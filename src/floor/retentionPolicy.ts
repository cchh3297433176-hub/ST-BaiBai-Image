import { isLegacyFloorImage, normalizeImagePath } from '@/floor/missingImages';
import { isAiStoryMessage, type STMessage } from '@/st/context';

export interface ImageRetentionPolicy {
  enabled: boolean;
  keepFloors: number;
  idleDays: number;
}

export const DEFAULT_IMAGE_RETENTION: ImageRetentionPolicy = {
  enabled: false,
  keepFloors: 10,
  idleDays: 30,
};

export function normalizeImageRetention(raw: Partial<ImageRetentionPolicy> = {}): ImageRetentionPolicy {
  const positiveInt = (value: number | undefined, fallback: number) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
  return {
    enabled: raw.enabled === true,
    keepFloors: positiveInt(raw.keepFloors, DEFAULT_IMAGE_RETENTION.keepFloors),
    idleDays: positiveInt(raw.idleDays, DEFAULT_IMAGE_RETENTION.idleDays),
  };
}

/** AI 楼照常计数，包括没有出图和被酒馆 /hide 隐藏的剧情楼。 */
export function firstRetainedFloor(chat: readonly STMessage[], keepFloors: number): number {
  let remaining = keepFloors;
  for (let i = chat.length - 1; i >= 0; i--) {
    if (isAiStoryMessage(chat[i]) && --remaining === 0) return i;
  }
  return 0;
}

function ownedImagePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const path = normalizeImagePath(value);
  // 目录和文件名同时核对。公开接口存图用同一目录，但不写入楼层 bbiImage。
  if (isLegacyFloorImage(path) || /^user\/images\/柏宝绘_[^/\\\x00-\x1f]+\/bbi_[a-z0-9_]+-[a-z0-9]+\.(?:png|jpe?g|webp|gif|avif)$/i.test(path)) {
    return path;
  }
}

function storedPaths(extra: Record<string, unknown> | undefined): string[] {
  const paths: string[] = [];
  const store = extra?.bbiImage;
  if (!store || typeof store !== 'object') return paths;
  for (const swipe of Object.values(store)) {
    if (!swipe || typeof swipe !== 'object') continue;
    for (const entries of Object.values(swipe)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const path = ownedImagePath(entry?.path);
        if (path) paths.push(path);
      }
    }
  }
  return paths;
}

export interface ImageReferencePlan {
  keep: Set<string>;
  expire: Set<string>;
  candidates?: ReadonlySet<string>;
}

/**
 * 留存位按楼计算，翻页版本与该楼的所有出图历史共用留存位。
 * 活跃聊天按位置，闲置聊天按最后曾经出图的位置。遇到跨楼重复引用，留存优先。
 */
export function planChatRetention(
  chat: readonly STMessage[],
  keepFloors: number,
  idle: boolean,
  plan: ImageReferencePlan,
): void {
  const cutoff = firstRetainedFloor(chat, keepFloors);
  let keptIdleFloor = false;
  for (let i = chat.length - 1; i >= 0; i--) {
    const message = chat[i];
    const paths = storedPaths(message.extra);
    for (const swipe of message.swipe_info ?? []) {
      for (const path of storedPaths(swipe?.extra)) paths.push(path);
    }
    if (!paths.length) continue;
    let keep = true;
    if (isAiStoryMessage(message)) {
      keep = idle ? !keptIdleFloor : i >= cutoff;
      keptIdleFloor = true;
    }
    for (const path of paths) {
      if (!plan.candidates || plan.candidates.has(path)) (keep ? plan.keep : plan.expire).add(path);
    }
  }
}
