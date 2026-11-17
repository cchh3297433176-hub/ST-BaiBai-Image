import { isImageMissing, isLegacyFloorImage, markImagesMissing } from '@/floor/missingImages';
import { planChatRetention, type ImageReferencePlan, type ImageRetentionPolicy } from '@/floor/retentionPolicy';
import { deleteImageFileOnly } from '@/floor/storage';
import { deleteUploadedFile } from '@/floor/upload';
import { mapLimit } from '@/pool';
import { settings } from '@/state/settings';
import { getContext, type STContext, type STMessage } from '@/st/context';
import { listUserImageFolders, listUserImages, probeUserImage } from '@/st/images';
import { computed, shallowRef, watch } from 'vue';

type SavedChat = { id: string; avatar?: string };
type Phase = 'scanning' | 'confirming' | 'verifying' | 'deleting';
type Progress = { phase: Phase; automatic: boolean; done?: number; total?: number };

export interface RetentionResult {
  deleted: number;
  failed: number;
  reclassified?: number;
  interrupted?: string;
}

export interface GalleryRetentionSummary {
  retained: number;
  unmatched: ReadonlySet<string>;
}

const DAY = 86_400_000;
const AUTOMATIC_INTERVAL = 10 * 60_000;
const AUTOMATIC_DELAY = 30_000;
const CHAT_CONCURRENCY = 3;
const FILE_CONCURRENCY = 6;
const FILE_VERIFY_BATCH = 250;
const SCAN_TIMEOUT = 45_000;
let revision = 0;
let bound = false;
let lastSweep: { time: number; revision: number; policy: ImageRetentionPolicy } | undefined;
let hostDateParser: ((value: string) => { valueOf(): number }) | undefined;

const progress = shallowRef<Progress>();
export const imageRetentionProgress = computed(() => progress.value);
export const imageRetentionStatus = computed(() => {
  const state = progress.value;
  if (!state) return '';
  const labels = {
    scanning: '正在检索',
    confirming: '等待确认',
    verifying: '正在复核',
    deleting: '正在删除',
  };
  const label = labels[state.phase];
  return state.total ? `${label} ${state.done}/${state.total}` : label;
});

function setProgress(phase: Phase, done?: number, total?: number): void {
  progress.value = { phase, automatic: progress.value?.automatic ?? false, done, total };
}

async function post(ctx: STContext, route: string, body: object): Promise<Response> {
  return fetch(route, {
    method: 'POST',
    headers: ctx.getRequestHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SCAN_TIMEOUT),
  });
}

async function readJson(ctx: STContext, route: string, body: object): Promise<unknown> {
  const response = await post(ctx, route, body);
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

/** 遇到读取错误就停止领新任务，等已发出的读取结束后再释放清理锁。 */
async function scanInParallel<T, R>(
  items: readonly T[], limit: number, valid: () => void, read: (item: T) => Promise<R>,
): Promise<R[]> {
  let failure: { error: unknown } | undefined;
  const results = await mapLimit(items, limit, async item => {
    if (failure) return;
    try {
      valid();
      return await read(item);
    } catch (error) {
      failure = { error };
    }
  });
  if (failure) throw failure.error;
  valid();
  return results as R[];
}

async function savedChats(ctx: STContext, active: SavedChat | undefined, valid: () => void): Promise<SavedChat[]> {
  const avatars = [...new Set(ctx.characters?.map(character => character.avatar).filter(Boolean))];
  const lists = await scanInParallel(avatars, CHAT_CONCURRENCY, valid, async avatar => {
    // simple 只列文件名，避免让宿主为了列目录读入每一个大聊天。
    const result = await readJson(ctx, '/api/characters/chats', { avatar_url: avatar, simple: true });
    if (result && typeof result === 'object' && 'error' in result && result.error === true) return [];
    if (!Array.isArray(result)) throw new Error('酒馆未返回可识别的聊天列表');
    return result.map(chat => {
      if (typeof chat?.file_id !== 'string') throw new Error('酒馆返回了无法识别的聊天文件名');
      return { id: chat.file_id, avatar };
    });
  });
  const chats = new Map<string, SavedChat>();
  for (const list of lists) {
    for (const chat of list) chats.set(chatKey(chat), chat);
  }
  for (const group of ctx.groups ?? []) {
    for (const id of group.chats ?? []) {
      if (typeof id !== 'string') throw new Error('酒馆返回了无法识别的群聊文件名');
      const chat = { id };
      chats.set(chatKey(chat), chat);
    }
  }
  if (active) chats.delete(chatKey(active));
  return [...chats.values()];
}

async function readChat(ctx: STContext, chat: SavedChat): Promise<STMessage[]> {
  const result = chat.avatar
    ? await readJson(ctx, '/api/chats/get', { avatar_url: chat.avatar, file_name: chat.id })
    : await readJson(ctx, '/api/chats/group/get', { id: chat.id });
  if (!Array.isArray(result)) throw new Error('无法完整读取历史聊天');
  return result.filter(message => message && typeof message.mes === 'string');
}

function isIdle(chat: readonly STMessage[], now: number, days: number): boolean {
  for (let i = chat.length - 1; i >= 0; i--) {
    const value = chat[i].send_date;
    if (!value) continue;
    const nativeTime = /^\d+$/.test(String(value)) ? Number(value) : Date.parse(value);
    const time = Number.isFinite(nativeTime) ? nativeTime : hostDateParser?.(value).valueOf();
    return typeof time === 'number' && Number.isFinite(time) && now - time >= days * DAY;
  }
  return false;
}

function assertEnabled(): void {
  if (!settings.enabled) throw new Error('柏宝绘已停用');
}

function isGenerating(): boolean {
  return typeof document !== 'undefined' && document.body?.dataset.generating === 'true';
}

function assertCanDelete(snapshot: number): void {
  assertEnabled();
  if (revision !== snapshot) throw new Error('聊天刚刚发生变化，请重新清理');
  if (isGenerating()) throw new Error('酒馆正在生成回复，请等回复结束后再清理旧图');
}

async function scanImageReferences(
  ctx: STContext, policy: ImageRetentionPolicy, valid: () => void,
  phase: 'scanning' | 'verifying', candidates?: ReadonlySet<string>,
): Promise<ImageReferencePlan> {
  if (!ctx.characters || !Array.isArray(ctx.groups)) throw new Error('酒馆的角色和群聊列表尚未就绪');
  setProgress(phase);
  const utilsUrl = '/scripts/utils.js';
  if (!hostDateParser && typeof window !== 'undefined') {
    const utils = await import(/* @vite-ignore */ utilsUrl).catch(() => null);
    if (typeof utils?.timestampToMoment === 'function') hostDateParser = utils.timestampToMoment;
  }
  valid();
  const active = currentChat(ctx);
  const plan: ImageReferencePlan = { keep: new Set(), expire: new Set(), candidates };
  const now = Date.now();
  planChatRetention(ctx.chat, policy.keepFloors, isIdle(ctx.chat, now, policy.idleDays), plan);
  const chats = await savedChats(ctx, active, valid);
  let checked = 0;
  setProgress(phase, checked, chats.length);
  await scanInParallel(chats, CHAT_CONCURRENCY, valid, async chat => {
    const messages = await readChat(ctx, chat);
    planChatRetention(messages, policy.keepFloors, isIdle(messages, now, policy.idleDays), plan);
    setProgress(phase, ++checked, chats.length);
  });
  return plan;
}

function expiredImages(plan: ImageReferencePlan): string[] {
  return [...plan.expire].filter(path => !plan.keep.has(path) && !isImageMissing(path));
}

function summarizeGallery(plan: ImageReferencePlan, paths: readonly string[]): GalleryRetentionSummary {
  const unmatched = new Set<string>();
  let retained = 0;
  for (const path of paths) {
    if (plan.keep.has(path)) retained++;
    else if (!plan.expire.has(path)) unmatched.add(path);
  }
  return { retained, unmatched };
}

async function existingImages(ctx: STContext, paths: readonly string[], valid: () => void): Promise<string[]> {
  const byFolder = new Map<string, Map<string, string>>();
  const legacy: string[] = [];
  for (const path of paths) {
    if (isLegacyFloorImage(path)) {
      legacy.push(path);
      continue;
    }
    const [, , folder, file] = path.split('/');
    const files = byFolder.get(folder) ?? new Map();
    files.set(file, path);
    byFolder.set(folder, files);
  }

  setProgress('scanning');
  const existing = new Set<string>();
  if (byFolder.size) {
    const folders = (await listUserImageFolders(AbortSignal.timeout(SCAN_TIMEOUT))).filter(folder => byFolder.has(folder));
    await scanInParallel(folders, CHAT_CONCURRENCY, valid, async folder => {
      const candidates = byFolder.get(folder)!;
      // 按名称列图，宿主不用为按日期排序逐张 stat。
      const files = await listUserImages(folder, { sortField: 'name', signal: AbortSignal.timeout(SCAN_TIMEOUT) });
      for (const file of files) {
        const path = candidates.get(file);
        if (path) existing.add(path);
      }
    });
  }
  for (let i = 0; i < legacy.length; i += FILE_VERIFY_BATCH) {
    valid();
    const batch = legacy.slice(i, i + FILE_VERIFY_BATCH);
    const response = await post(ctx, '/api/files/verify', { urls: batch });
    if (response.status === 404 || response.status === 405) {
      // 某些旧版宿主没有批量验证接口。
      await scanInParallel(legacy, FILE_CONCURRENCY, valid, async path => {
        const probe = await probeUserImage('/' + path);
        if (probe?.exists !== false) existing.add(path);
      });
      break;
    }
    if (!response.ok) throw new Error('检查旧版图片失败（HTTP ' + response.status + '）');
    const verified = await response.json();
    for (const path of batch) {
      if (typeof verified?.[path] !== 'boolean') throw new Error('酒馆未返回可识别的旧版图片状态');
      if (verified[path]) existing.add(path);
    }
  }
  valid();
  return paths.filter(path => existing.has(path));
}

async function withCleanupLock<T>(automatic: boolean, task: () => Promise<T>): Promise<T> {
  if (progress.value) throw new Error('柏宝绘正在清理旧图');
  progress.value = { phase: 'scanning', automatic };
  try {
    if (!navigator.locks) return await task();
    return await navigator.locks.request('st-baibai-image-retention', { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('另一个酒馆页面正在检查旧图');
      return task();
    });
  } finally {
    progress.value = undefined;
  }
}

async function deletePaths(paths: readonly string[], valid: () => void): Promise<RetentionResult> {
  const confirmedMissing: string[] = [];
  const result: RetentionResult = { deleted: 0, failed: 0 };
  let processed = 0;
  setProgress('deleting', processed, paths.length);
  await mapLimit(paths, FILE_CONCURRENCY, async path => {
    if (result.interrupted) return;
    try {
      valid();
    } catch (error) {
      result.interrupted = error instanceof Error ? error.message : String(error);
      return;
    }
    try {
      const signal = AbortSignal.timeout(30_000);
      const deleted = isLegacyFloorImage(path) ? await deleteUploadedFile(path, signal) : await deleteImageFileOnly(path, signal);
      confirmedMissing.push(path);
      if (deleted) result.deleted++;
    } catch (error) {
      result.failed++;
      console.warn('[柏宝绘] 删除旧图失败', path, error);
    }
    setProgress('deleting', ++processed, paths.length);
  });
  markImagesMissing(confirmedMissing);
  return result;
}

function sameRules(a: ImageRetentionPolicy, b: ImageRetentionPolicy): boolean {
  return a.keepFloors === b.keepFloors && a.idleDays === b.idleDays;
}

export function retentionResultText(result: RetentionResult): string {
  const parts = [];
  if (result.deleted) parts.push(`已删除 ${result.deleted} 张旧图`);
  if (result.failed) parts.push(`${result.failed} 张删除失败`);
  if (result.reclassified) parts.push(`复核时跳过 ${result.reclassified} 张已不符合规则的图片`);
  if (result.interrupted) parts.push(result.interrupted);
  return parts.length ? parts.join('，') + '。' : '没有符合规则且仍存在的旧图。';
}

/** 一次清理包含检索、确认与删除，生命周期独立于图库和设置页。 */
export function runImageRetention(
  policy: ImageRetentionPolicy,
  confirm: (count: number, summary?: GalleryRetentionSummary) => Promise<boolean>,
  galleryPaths?: readonly string[],
): Promise<RetentionResult | undefined> {
  return withCleanupLock(false, async () => {
    const ctx = getContext();
    if (!ctx) throw new Error('酒馆尚未就绪');
    const previewRevision = revision;
    const plan = await scanImageReferences(ctx, policy, assertEnabled, 'scanning');
    const paths = await existingImages(ctx, expiredImages(plan), assertEnabled);
    const summary = galleryPaths && summarizeGallery(plan, galleryPaths);
    setProgress('confirming');
    if (!await confirm(paths.length, summary)) return;

    const confirmedRevision = revision;
    const canDelete = () => assertCanDelete(confirmedRevision);
    canDelete();
    // 只复核已确认路径的聊天引用。文件若已被别处删除，删除接口会返回 404。
    const confirmedContext = getContext();
    if (!confirmedContext) throw new Error('酒馆尚未就绪');
    const verified = paths.length
      ? expiredImages(await scanImageReferences(confirmedContext, policy, canDelete, 'verifying', new Set(paths)))
      : [];
    const result = await deletePaths(verified, canDelete);
    if (paths.length > verified.length) result.reclassified = paths.length - verified.length;
    if (!result.failed && !result.interrupted && !result.reclassified && previewRevision === confirmedRevision) {
      lastSweep = { time: Date.now(), revision: confirmedRevision, policy };
    }
    return result;
  });
}

export function bindImageRetention(): void {
  const ctx = getContext();
  if (bound || !ctx) return;
  bound = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scheduledAt = 0;

  const schedule = () => {
    if (!settings.enabled || !settings.storage.retention.enabled) {
      clearTimeout(timer);
      timer = undefined;
      return;
    }
    const now = Date.now();
    const interval = lastSweep?.revision === revision ? DAY : AUTOMATIC_INTERVAL;
    const nextSweep = lastSweep && sameRules(settings.storage.retention, lastSweep.policy) ? lastSweep.time + interval : 0;
    const next = Math.max(now + AUTOMATIC_DELAY, nextSweep);
    // 持续聊天时保留已排好的时间，避免每条消息都把清理往后推。
    if (timer !== undefined && scheduledAt <= next) return;
    clearTimeout(timer);
    scheduledAt = next;
    timer = setTimeout(() => {
      timer = undefined;
      if (!settings.enabled || !settings.storage.retention.enabled) return;
      if (progress.value || isGenerating()) {
        schedule();
        return;
      }
      const policy = { ...settings.storage.retention };
      const snapshot = revision;
      const valid = () => {
        assertCanDelete(snapshot);
        const current = settings.storage.retention;
        if (!current.enabled || !sameRules(current, policy)) throw new Error('旧图清理规则已变更或暂停');
      };
      void withCleanupLock(true, async () => {
        const current = getContext();
        if (!current) throw new Error('酒馆尚未就绪');
        const plan = await scanImageReferences(current, policy, valid, 'scanning');
        const paths = expiredImages(plan);
        const result = await deletePaths(await existingImages(current, paths, valid), valid);
        if (!result.failed && !result.interrupted) {
          lastSweep = { time: Date.now(), revision: snapshot, policy };
        }
      }).catch(error => console.debug('[柏宝绘] 旧图清理稍后重试', error))
        .finally(schedule);
    }, next - now);
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

  watch(
    () => [settings.enabled, settings.storage.retention.enabled,
      settings.storage.retention.keepFloors, settings.storage.retention.idleDays],
    schedule,
  );
  schedule();
}
