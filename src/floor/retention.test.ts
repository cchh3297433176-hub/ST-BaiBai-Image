import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isImageMissing, resetMissingImages } from '@/floor/missingImages';
import type { STMessage } from '@/st/context';
import { settings } from '@/state/settings';
import { bindImageRetention, imageRetentionProgress, runImageRetention } from './retention';
import { firstRetainedFloor, planChatRetention } from './retentionPolicy';

const mocks = vi.hoisted(() => ({
  getContext: vi.fn(),
  listUserImages: vi.fn(),
  probeUserImage: vi.fn(),
  deleteImageFileOnly: vi.fn(),
  deleteUploadedFile: vi.fn(),
}));
vi.mock('@/st/context', async importOriginal => ({
  ...await importOriginal<typeof import('@/st/context')>(),
  getContext: mocks.getContext,
}));
vi.mock('@/st/images', () => ({
  listUserImageFolders: async () => ['柏宝绘_甲'],
  listUserImages: mocks.listUserImages,
  probeUserImage: mocks.probeUserImage,
}));
vi.mock('@/floor/storage', () => ({ deleteImageFileOnly: mocks.deleteImageFileOnly }));
vi.mock('@/floor/upload', () => ({ deleteUploadedFile: mocks.deleteUploadedFile }));
vi.mock('@/state/settings', async () => {
  const { reactive } = await import('vue');
  return { settings: reactive({ enabled: true, storage: { retention: { enabled: false, keepFloors: 1, idleDays: 30 } } }) };
});

const old = 'user/images/柏宝绘_甲/bbi_a_0_b-gold.png';
const oldSwipe = 'user/images/柏宝绘_甲/bbi_a_1_b-goldswipe.jpg';
const recent = 'user/images/柏宝绘_甲/bbi_a_0_b-gnew.png';
const shared = 'user/images/柏宝绘_甲/bbi_a_0_b-gshared.jpg';
const idleOld = 'user/images/柏宝绘_甲/bbi_a_0_b-gidleold.png';
const idleNew = 'user/images/柏宝绘_甲/bbi_a_0_b-gidlenew.png';
const external = 'user/images/柏宝绘_画师串/preview.png';
const legacy = 'user/files/bbi_00000000000001_0_00000000000002-golden.png';
const policy = { enabled: true, keepFloors: 1, idleDays: 30 };
const getExtra = (paths: string[]) => ({
  bbiImage: { 0: { b: paths.map(path => ({ path })) } },
});
const ai = (...paths: string[]): STMessage => ({
  mes: '剧情', name: '甲', is_user: false, is_system: false, extra: getExtra(paths),
});
const user: STMessage = { mes: '用户', name: '乙', is_user: true, is_system: false };

afterEach(() => {
  settings.storage.retention = { ...policy, enabled: false };
  resetMissingImages();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe('柏宝绘旧图清理', () => {
  it('按 AI 楼层计数，包含没出图的楼和被隐藏的普通剧情楼', () => {
    expect(firstRetainedFloor([ai(old), user, { ...ai(), is_system: true }, user, ai(recent)], 2)).toBe(2);
    expect(firstRetainedFloor([ai(old), user, ai(recent), user], 1)).toBe(2);
  });

  it('保留最近一整个有图楼，记录所有滑动版本，只收楼层自有插图', () => {
    const plan = { keep: new Set<string>(), expire: new Set<string>() };
    const message = { ...ai(recent, shared, external), swipe_info: [{ extra: getExtra([oldSwipe]) }] };
    planChatRetention([ai(old), message, ai()], 1, true, plan);
    expect(plan.keep).toEqual(new Set([recent, shared, oldSwipe]));
    expect(plan.expire).toEqual(new Set([old]));
  });

  it('预览既有会话，清理分支未保留且仍存在的图，也处理闲置群聊', async () => {
    const date = new Date().toISOString();
    const ctx = {
      characters: [{ avatar: 'a.png' }],
      groups: [{ id: 'group', chats: ['groupChat'] }],
      chat: [ai(old, shared, legacy), { ...ai(recent), send_date: date }],
      characterId: 0,
      getCurrentChatId: () => 'main',
      getRequestHeaders: () => ({}),
    };
    mocks.getContext.mockReturnValue(ctx);
    mocks.listUserImages.mockResolvedValue([old, shared, recent, idleOld, idleNew].map(path => path.split('/').pop()));
    mocks.probeUserImage.mockResolvedValue({ exists: true, size: 400 });
    mocks.deleteImageFileOnly.mockResolvedValue(true);
    mocks.deleteUploadedFile.mockResolvedValue(true);
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts: RequestInit) => {
      const payload = JSON.parse(String(opts.body));
      if (url === '/api/characters/chats') {
        expect(payload.simple).toBe(true);
        return Response.json([{ file_id: 'main' }, { file_id: 'branch' }]);
      }
      if (url === '/api/chats/get') {
        expect(payload.file_name).toBe('branch');
        return Response.json([{ ...ai(shared), send_date: date }]);
      }
      if (url === '/api/files/verify') {
        expect(payload.urls).toEqual([legacy]);
        return Response.json({ [legacy]: true });
      }
      if (url === '/api/chats/group/get') {
        return Response.json([ai(idleOld), ai(idleNew), { ...ai(), send_date: '2020-01-01T00:00:00Z' }]);
      }
      throw new Error('unexpected request: ' + url);
    }));

    const result = await runImageRetention(policy, async count => {
      expect(count).toBe(3);
      expect(imageRetentionProgress.value?.phase).toBe('confirming');
      expect(mocks.deleteImageFileOnly).not.toHaveBeenCalled();
      return true;
    });

    expect(result).toEqual({ deleted: 3, failed: 0 });
    expect(mocks.listUserImages).toHaveBeenCalledExactlyOnceWith('柏宝绘_甲', { sortField: 'name', signal: expect.any(AbortSignal) });
    expect(mocks.probeUserImage).not.toHaveBeenCalled();
    expect(mocks.deleteImageFileOnly.mock.calls.map(([path]) => path).sort()).toEqual([old, idleOld].sort());
    expect(mocks.deleteUploadedFile).toHaveBeenCalledExactlyOnceWith(legacy, expect.any(AbortSignal));
    expect(isImageMissing(legacy)).toBe(true);
    expect(ctx.chat[0].extra).toEqual(getExtra([old, shared, legacy]));
  });

  it('等待确认后重新查保留楼层，生成回复时不会删除', async () => {
    const chat = [ai(old), ai(recent)];
    mocks.getContext.mockReturnValue({
      characters: [{ avatar: 'a.png' }], groups: [], chat, characterId: 0,
      getCurrentChatId: () => 'main', getRequestHeaders: () => ({}),
    });
    mocks.listUserImages.mockResolvedValue([old, recent].map(path => path.split('/').pop()));
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([{ file_id: 'main' }])));
    const dataset: Record<string, string> = { generating: 'true' };
    vi.stubGlobal('document', { body: { dataset } });

    await expect(runImageRetention(policy, async () => true)).rejects.toThrow('正在生成回复');
    delete dataset.generating;

    const result = await runImageRetention(policy, async count => {
      expect(count).toBe(1);
      chat.reverse();
      return true;
    });
    expect(result).toEqual({ deleted: 0, failed: 0 });
    expect(mocks.deleteImageFileOnly).not.toHaveBeenCalled();
    expect(imageRetentionProgress.value).toBeUndefined();
  });

  it('删除逐张容错并区分已不存在的文件，当次任务保持占用状态', async () => {
    mocks.getContext.mockReturnValue({
      characters: [], groups: [], chat: [ai(old, shared, oldSwipe), ai(recent)], getCurrentChatId: () => undefined,
    });
    mocks.listUserImages.mockResolvedValue([old, shared, oldSwipe].map(path => path.split('/').pop()));
    mocks.deleteImageFileOnly.mockImplementation(async path => {
      if (path === shared) throw new Error('HTTP 500');
      return path === old;
    });
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await runImageRetention(policy, async count => {
        expect(count).toBe(3);
        await expect(runImageRetention(policy, async () => true)).rejects.toThrow('正在清理');
        return true;
      });
      expect(result).toEqual({ deleted: 1, failed: 1 });
      expect(isImageMissing(old)).toBe(true);
      expect(isImageMissing(oldSwipe)).toBe(true);
      expect(isImageMissing(shared)).toBe(false);
    } finally {
      log.mockRestore();
    }
  });

  it('自动清理会在输入框聚焦和酒馆切到后台时运行，后续消息不推迟已安排的时间', async () => {
    vi.useFakeTimers();
    const eventSource = new EventEmitter();
    const chat = [ai(old), ai(), ai(), ai(recent)];
    mocks.getContext.mockReturnValue({
      characters: [], groups: [], chat, getCurrentChatId: () => 'main',
      eventSource, eventTypes: { MESSAGE_SENT: 'sent', MESSAGE_UPDATED: 'update' },
    });
    mocks.listUserImages.mockResolvedValue([old, recent].map(path => path.split('/').pop()));
    mocks.deleteImageFileOnly.mockResolvedValue(true);
    vi.stubGlobal('document', {
      body: { dataset: {} },
      visibilityState: 'hidden',
      activeElement: { matches: () => true },
    });
    settings.storage.retention = { ...policy, keepFloors: 3 };
    bindImageRetention();

    await vi.advanceTimersByTimeAsync(20_000);
    eventSource.emit('sent');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.deleteImageFileOnly).toHaveBeenCalledExactlyOnceWith(old, expect.any(AbortSignal));
    settings.storage.retention = { ...policy, enabled: false };
    await vi.advanceTimersByTimeAsync(0);
  });
});
