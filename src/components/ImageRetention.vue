<script setup lang="ts">
import { formatBytes } from '@/bytes';
import Collapsible from '@/components/Collapsible.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import { applyImageRetention, previewImageRetention, type RetentionPreview } from '@/floor/retention';
import type { ImageRetentionPolicy } from '@/floor/retentionPolicy';
import { settings } from '@/state/settings';
import { ref, shallowRef, watch } from 'vue';

const keepFloors = ref<number | string>(settings.storage.retention.keepFloors);
const idleDays = ref<number | string>(settings.storage.retention.idleDays);
const open = ref(false);
const busy = ref(false);
const status = ref('');
const pending = shallowRef<{ policy: ImageRetentionPolicy; preview: RetentionPreview }>();

watch(() => settings.storage.retention, current => {
  keepFloors.value = current.keepFloors;
  idleDays.value = current.idleDays;
});

function readRules(): ImageRetentionPolicy | undefined {
  const floors = Number(keepFloors.value);
  const days = Number(idleDays.value);
  if (!Number.isSafeInteger(floors) || floors < 1 || !Number.isSafeInteger(days) || days < 1) {
    status.value = '楼数和闲置天数需填写大于 0 的整数。';
    return;
  }
  return { enabled: settings.storage.retention.enabled, keepFloors: floors, idleDays: days };
}

function saveRules() {
  const policy = readRules();
  if (!policy || policy.enabled) return;
  settings.storage.retention = policy;
  status.value = '规则已保存，可在图库清理旧图。';
}

async function preview() {
  const rules = readRules();
  if (!rules) return;
  busy.value = true;
  status.value = '正在检查已有聊天和旧图…';
  const policy = { ...rules, enabled: true };
  try {
    pending.value = { policy, preview: await previewImageRetention(policy) };
    status.value = '';
    open.value = true;
  } catch (error) {
    status.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
  }
}

async function apply() {
  if (!pending.value || busy.value) return;
  const selected = pending.value;
  busy.value = true;
  try {
    const deleted = await applyImageRetention(selected.preview, selected.policy);
    settings.storage.retention = selected.policy;
    status.value = deleted ? '已处理 ' + deleted + ' 张旧图，自动清理已开启。' : '这次没有旧图可清，自动清理已开启。';
  } catch (error) {
    status.value = error instanceof Error ? error.message : String(error);
  } finally {
    open.value = false;
    busy.value = false;
  }
}

function disable() {
  settings.storage.retention = { ...settings.storage.retention, enabled: false };
  status.value = '自动清理已暂停。';
}
</script>

<template>
  <Collapsible title="旧图自动清理" :open="false">
    <label class="bbi-num-row">
      <span class="bbi-field-label">最近保留 AI 楼数</span>
      <input v-model.number="keepFloors" class="bbi-input bbi-num" type="number" inputmode="numeric" min="1" step="1" :disabled="busy" />
    </label>
    <label class="bbi-num-row">
      <span class="bbi-field-label">闲置天数</span>
      <input v-model.number="idleDays" class="bbi-input bbi-num" type="number" inputmode="numeric" min="1" step="1" :disabled="busy" />
    </label>
    <p class="bbi-field-hint">闲置聊天只留最后一个有图楼里的图片。保存的规则也用于图库里的「清理旧图」。</p>
    <p v-if="settings.storage.retention.enabled" class="bbi-field-hint">
      正在使用 {{ settings.storage.retention.keepFloors }} 楼 / {{ settings.storage.retention.idleDays }} 天
    </p>
    <button type="button" class="bbi-btn bbi-btn-primary" :disabled="busy || !settings.enabled" @click="preview">预览旧图</button>
    <button v-if="settings.storage.retention.enabled" type="button" class="bbi-btn" :disabled="busy" @click="disable">暂停自动清理</button>
    <button v-else type="button" class="bbi-btn" :disabled="busy" @click="saveRules">保存规则</button>
    <p v-if="status" class="bbi-field-hint" role="status">{{ status }}</p>

    <ConfirmDialog
      v-model:open="open"
      title="启用旧图自动清理"
      confirm-text="确认并开启"
      tone="danger"
      :busy="busy"
      busy-text="正在清理…"
      @confirm="apply"
    >
      {{ pending?.preview.paths.length ?? 0 }} 张旧图符合规则，预计释放 {{ formatBytes(pending?.preview.bytes ?? 0) }}。
      <template v-if="pending?.preview.unknownSizes">另有 {{ pending.preview.unknownSizes }} 张未取得文件大小。</template>
      确认后会删除这些图片文件。
    </ConfirmDialog>
  </Collapsible>
</template>
