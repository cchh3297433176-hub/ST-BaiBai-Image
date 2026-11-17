import { isImageMissing, markImageMissing } from '@/floor/missingImages';
import { planChatRetention, type ImageReferencePlan, type ImageRetentionPolicy } from '@/floor/retentionPolicy';
import { deleteImageFileOnly } from '@/floor/storage';
import { settings } from '@/state/settings';
import { getContext, type STContext, type STMessage } from '@/st/context';
import { listUserImageFolders, listUserImages, probeUserImage } from '@/st/images';
import { watch } from 'vue';

type SavedChat = { id: string; avatar?: string };

export interface RetentionPreview {
  paths: readonly string[];
  bytes: number;
  unknownSizes: number;
}

const DAY = 86_400_000;
const AUTOMATIC_INTERVAL = 60 * 60 * 1000;
const AUTOMATIC_DELAY = 90_000;
let revision = 0;
let bound = false;
let busy = false;
let lastSweep = 0;
let hostDateParser: ((value: string) => { valueOf(): number }) | undefined;

function pause(ms = 20): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function post(ctx: STContext, route: string, body: object): Promise<unknown> {
  const response = await fetch(route, {
    method: 'POST',
    headers: ctx.getRequestHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error('读取聊天失败（HTTP ' + response.status + '）');
  return response.json();
}

function currentChat(ctx: STContext): SavedChat | undefined {
  const id = ctx.getCurrentChatId();
  if (!id) return;
  if (ctx.groupId != null && String(ctx.groupId)) return { id };
  const avatar = ctx.characters?.[Number(ctx.characterId)]?.avatar;
  if (avatar) return { id, avatar };
}

function chatKey(chat: SavedChat): string {
  return JSON.stringify([chat.avatar ?? null, chat.id]);
}

async function* savedChats(ctx: STContext, stillValid: () => void): AsyncGenerator<SavedChat> {
  // simple 只列文件名；逐张角色卡查，避免 /chats/recent 在手机上并发读取整个聊天库。
  for (const avatar of new Set(ctx.characters?.map(character => character.avatar).filter(Boolean))) {
    await pause();
    stillValid();
    const result = await post(ctx, '/api/characters/chats', { avatar_url: avatar, simple: true });
    if (result && typeof result === 'object' && 'error' in result && result.error === true) continue;
    if (!Array.isArray(result)) throw new Error('酒馆未返回可识别的聊天列表');
    for (const chat of result) {
      if (typeof chat?.file_id !== 'string') throw new Error('酒馆返回了无法识别的聊天文件名');
      yield { id: chat.file_id, avatar };
    }
  }

  // 群聊记录由宿主维护；同一文件可能被重复列出，调用层会去重。
  for (const group of ctx.groups ?? []) {
    for (const id of group.chats ?? []) {
      if (typeof id !== 'string') throw new Error('酒馆返回了无法识别的群聊文件名');
      yield { id };
    }
  }
}

async function readChat(ctx: STContext, chat: SavedChat): Promise<STMessage[]> {
  const result = chat.avatar
    ? await post(ctx, '/api/chats/get', { avatar_url: chat.avatar, file_name: chat.id })
    : await post(ctx, '/api/chats/group/get', { id: chat.id });
  if (!Array.isArray(result)) throw new Error('无法完整读取历史聊天');
  return result.filter(message => message && typeof message.mes === 'string');
}

function isIdle(chat: readonly STMessage[], now: number, days: number): boolean {
  for (let i = chat.length - 1; i >= 0; i--) {
    const value = chat[i].send_date;
    if (!value) continue;
    const nativeTime = /^\d+$/.test(String(value)) ? Number(value) : Date.parse(value);
    const time = Number.isFinite(nativeTime) ? nativeTime : hostDateParser?.(value).valueOf();
    // 日期不明时按活跃会话处理，保留完整的最近 N 楼。
    return typeof time === 'number' && Number.isFinite(time) && now - time >= days * DAY;
  }
  return false;
}

function assertStable(expected: number): void {
  if (revision !== expected) throw new Error('聊天刚刚发生变化，请重新预览');
}

function isGenerating(): boolean {
  // ST 只在实际锁住发送按钮时设置这个标记。生成开始事件也会在试算提示词、
  // 执行斜杠指令前触发，这些路径可能没有对应的结束事件。
  return typeof document !== 'undefined' && document.body?.dataset.generating === 'true';
}

async function findExpiredImages(policy: ImageRetentionPolicy, valid: () => void): Promise<string[]> {
  const ctx = getContext();
  if (!ctx?.characters || !Array.isArray(ctx.groups)) throw new Error('酒馆的角色和群聊列表尚未就绪');
  const utilsUrl = '/scripts/utils.js';
  if (!hostDateParser && typeof window !== 'undefined') {
    const utils = await import(/* @vite-ignore */ utilsUrl).catch(() => null);
    if (typeof utils?.timestampToMoment === 'function') hostDateParser = utils.timestampToMoment;
  }
  const active = currentChat(ctx);
  const seen = new Set(active ? [chatKey(active)] : []);
  const plan: ImageReferencePlan = { keep: new Set(), expire: new Set() };
  const now = Date.now();
  planChatRetention(ctx.chat, policy.keepFloors, false, plan);
  for await (const next of savedChats(ctx, valid)) {
    const key = chatKey(next);
    if (seen.has(key)) continue;
    seen.add(key);
    await pause();
    valid();
    const messages = await readChat(ctx, next);
    planChatRetention(messages, policy.keepFloors, isIdle(messages, now, policy.idleDays), plan);
  }
  valid();

  const byFolder = new Map<string, Map<string, string>>();
  for (const path of plan.expire) {
    if (plan.keep.has(path) || isImageMissing(path)) continue;
    const [, , folder, file] = path.split('/');
    const files = byFolder.get(folder) ?? new Map();
    files.set(file, path);
    byFolder.set(folder, files);
  }
  if (!byFolder.size) return [];

  const existingFolders = await listUserImageFolders();
  const expired: string[] = [];
  for (const folder of existingFolders) {
    const candidates = byFolder.get(folder);
    if (!candidates) continue;
    await pause();
    valid();
    for (const file of await listUserImages(folder)) {
      const path = candidates.get(file);
      if (path) expired.push(path);
    }
  }
  valid();
  return expired;
}

async function withCleanupLock<T>(task: () => Promise<T>): Promise<T> {
  if (busy) throw new Error('正在检查历史图片');
  busy = true;
  try {
    if (!navigator.locks) return await task();
    return await navigator.locks.request('st-baibai-image-retention', { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('另一个酒馆页面正在检查旧图');
      return task();
    });
  } finally {
    busy = false;
  }
}

export function previewImageRetention(policy: ImageRetentionPolicy): Promise<RetentionPreview> {
  return withCleanupLock(async () => {
    const snapshot = revision;
    const valid = () => assertStable(snapshot);
    valid();
    const paths = await findExpiredImages(policy, valid);
    let bytes = 0;
    let unknownSizes = 0;
    const existing: string[] = [];
    for (let i = 0; i < paths.length; i += 4) {
      await pause();
      valid();
      const batch = paths.slice(i, i + 4);
      const probes = await Promise.all(batch.map(path => probeUserImage('/' + path.split('/').map(encodeURIComponent).join('/'))));
      for (const [index, probe] of probes.entries()) {
        if (probe?.exists === false) continue;
        existing.push(batch[index]);
        if (probe?.exists && probe.size !== null) bytes += probe.size;
        else unknownSizes++;
      }
    }
    valid();
    return { paths: existing, bytes, unknownSizes };
  });
}

async function deletePaths(paths: readonly string[], valid: () => void): Promise<number> {
  let deleted = 0;
  for (const path of paths) {
    await pause();
    valid();
    await deleteImageFileOnly(path);
    markImageMissing(path);
    deleted++;
  }
  return deleted;
}

/** 重新计算保留范围，且只处理预览里已经确认的文件。 */
export function applyImageRetention(preview: RetentionPreview, policy: ImageRetentionPolicy): Promise<number> {
  return withCleanupLock(async () => {
    const snapshot = revision;
    const valid = () => {
      assertStable(snapshot);
      if (!settings.enabled) throw new Error('柏宝绘已停用');
      if (isGenerating()) throw new Error('酒馆正在生成回复，请等回复结束后再清理旧图');
    };
    valid();
    const previewed = new Set(preview.paths);
    lastSweep = Date.now();
    if (!previewed.size) return 0;
    // 重新检查磁盘上的会话与分支，防止预览后另一设备新增保留引用。
    const stillExpired = await findExpiredImages(policy, valid);
    return deletePaths(stillExpired.filter(path => previewed.has(path)), valid);
  });
}

function isComposing(): boolean {
  return document.visibilityState === 'hidden'
    || Boolean(document.activeElement?.matches('#send_textarea, .edit_textarea, [contenteditable="true"]'));
}

export function bindImageRetention(): void {
  const ctx = getContext();
  if (bound || !ctx) return;
  bound = true;
  let lastCompletedRevision = -1;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = () => {
    if (timer !== undefined) clearTimeout(timer);
    if (!settings.enabled || !settings.storage.retention.enabled) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!settings.enabled || !settings.storage.retention.enabled) return;
      if (isComposing() || isGenerating() || busy) {
        schedule();
        return;
      }
      lastSweep = Date.now();
      const snapshot = revision;
      const policy = { ...settings.storage.retention };
      const valid = () => {
        assertStable(snapshot);
        const current = settings.storage.retention;
        if (isComposing() || isGenerating() || !settings.enabled || !current.enabled
          || policy.keepFloors !== current.keepFloors || policy.idleDays !== current.idleDays) {
          throw new Error('旧图清理已暂停');
        }
      };
      void withCleanupLock(async () => {
        const paths = await findExpiredImages(policy, valid);
        await deletePaths(paths, valid);
        lastCompletedRevision = snapshot;
      }).catch(error => console.debug('[柏宝绘] 旧图清理稍后重试', error))
        .finally(schedule);
    }, Math.max(AUTOMATIC_DELAY, lastSweep + (lastCompletedRevision === revision ? DAY : AUTOMATIC_INTERVAL) - Date.now()));
  };

  const invalidate = () => {
    revision++;
    schedule();
  };
  const events = ctx.eventTypes;
  for (const event of [
    events.CHAT_CHANGED, events.CHAT_CREATED, events.CHAT_DELETED, events.GROUP_CHAT_CREATED,
    events.GROUP_CHAT_DELETED, events.CHAT_RENAMED, events.MESSAGE_SENT, events.MESSAGE_DELETED,
    events.MESSAGE_EDITED, events.MESSAGE_SWIPED, events.MESSAGE_SWIPE_DELETED, events.MESSAGE_RECEIVED,
  ]) {
    if (event) ctx.eventSource.on(event, invalidate);
  }

  // 在设定页首次确认后启动；以后由启动、活动变化与低频定时器驱动。
  watch(
    () => [settings.enabled, settings.storage.retention.enabled,
      settings.storage.retention.keepFloors, settings.storage.retention.idleDays],
    schedule,
  );
  schedule();
}
