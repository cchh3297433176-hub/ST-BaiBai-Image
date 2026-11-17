import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetMissingImages } from '@/floor/missingImages';
import type { STMessage } from '@/st/context';
import { applyImageRetention, bindImageRetention, previewImageRetention } from './retention';
import { firstRetainedFloor, planChatRetention } from './retentionPolicy';

const mocks = vi.hoisted(() => ({
  getContext: vi.fn(),
  listUserImages: vi.fn(),
  probeUserImage: vi.fn(),
  deleteImageFileOnly: vi.fn(),
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
vi.mock('@/state/settings', () => ({
  settings: { enabled: true, storage: { retention: { enabled: false, keepFloors: 1, idleDays: 30 } } },
}));

const old = 'user/images/柏宝绘_甲/bbi_a_0_b-gold.png';
const oldSwipe = 'user/images/柏宝绘_甲/bbi_a_1_b-goldswipe.jpg';
const recent = 'user/images/柏宝绘_甲/bbi_a_0_b-gnew.png';
const shared = 'user/images/柏宝绘_甲/bbi_a_0_b-gshared.jpg';
const idleOld = 'user/images/柏宝绘_甲/bbi_a_0_b-gidleold.png';
const idleNew = 'user/images/柏宝绘_甲/bbi_a_0_b-gidlenew.png';
const external = 'user/images/柏宝绘_画师串/preview.png';
const policy = { enabled: true, keepFloors: 1, idleDays: 30 };
const getExtra = (paths: string[]) => ({
  bbiImage: { 0: { b: paths.map(path => ({ path })) } },
});
const ai = (...paths: string[]): STMessage => ({
  mes: '剧情', name: '甲', is_user: false, is_system: false, extra: getExtra(paths),
});
const user: STMessage = { mes: '用户', name: '乙', is_user: true, is_system: false };

afterEach(() => {
  resetMissingImages();
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
      chat: [ai(old, shared), { ...ai(recent), send_date: date }],
      characterId: 0,
      getCurrentChatId: () => 'main',
      getRequestHeaders: () => ({}),
    };
    mocks.getContext.mockReturnValue(ctx);
    mocks.listUserImages.mockResolvedValue([old, shared, recent, idleOld, idleNew].map(path => path.split('/').pop()));
    mocks.probeUserImage.mockResolvedValue({ exists: true, size: 400 });
    mocks.deleteImageFileOnly.mockResolvedValue(undefined);
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
      if (url === '/api/chats/group/get') {
        return Response.json([ai(idleOld), ai(idleNew), { ...ai(), send_date: '2020-01-01T00:00:00Z' }]);
      }
      throw new Error('unexpected request: ' + url);
    }));

    const preview = await previewImageRetention(policy);
    expect(preview.paths).toEqual([old, idleOld]);
    expect(preview.bytes).toBe(800);
    expect(mocks.deleteImageFileOnly).not.toHaveBeenCalled();
    expect(await applyImageRetention(preview, policy)).toBe(2);
    expect(mocks.deleteImageFileOnly.mock.calls).toEqual([[old], [idleOld]]);
    expect(ctx.chat[0].extra).toEqual(getExtra([old, shared]));
  });

  it('忽略提示词试算和重渲染，实际生成时暂停删除，并重新核对变动后的楼层', async () => {
    const eventSource = new EventEmitter();
    const chat = [ai(old), ai(recent)];
    mocks.getContext.mockReturnValue({
      characters: [{ avatar: 'a.png' }], groups: [], chat, characterId: 0,
      getCurrentChatId: () => 'main', getRequestHeaders: () => ({}), eventSource,
      eventTypes: { GENERATION_STARTED: 'start', MESSAGE_UPDATED: 'update', MESSAGE_EDITED: 'edit' },
    });
    mocks.listUserImages.mockResolvedValue([old, recent].map(path => path.split('/').pop()));
    mocks.probeUserImage.mockResolvedValue({ exists: true, size: 400 });
    vi.stubGlobal('fetch', vi.fn(async () => {
      eventSource.emit('start', 'normal', {}, true);
      eventSource.emit('update', 0);
      return Response.json([{ file_id: 'main' }]);
    }));
    const dataset: Record<string, string> = {};
    vi.stubGlobal('document', { body: { dataset } });
    bindImageRetention();

    const preview = await previewImageRetention(policy);
    expect(preview.paths).toEqual([old]);

    dataset.generating = 'true';
    await expect(applyImageRetention(preview, policy)).rejects.toThrow('正在生成回复');
    delete dataset.generating;

    chat.reverse();
    eventSource.emit('edit', 1);
    expect(await applyImageRetention(preview, policy)).toBe(0);
    expect(mocks.deleteImageFileOnly).not.toHaveBeenCalled();
  });
});
