<script setup lang="ts">
import Collapsible from '@/components/Collapsible.vue';
import Icon from '@/components/Icon.vue';
import { confirmDialog } from '@/components/confirm';
import { imageRetentionProgress, imageRetentionStatus, retentionResultText, runImageRetention } from '@/floor/retention';
import type { ImageRetentionPolicy } from '@/floor/retentionPolicy';
import { settings } from '@/state/settings';
import { ref, watch } from 'vue';

const keepFloors = ref<number | string>(settings.storage.retention.keepFloors);
const idleDays = ref<number | string>(settings.storage.retention.idleDays);
const status = ref('');

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
  if (imageRetentionProgress.value || !settings.enabled) return;
  const rules = readRules();
  if (!rules) return;
  status.value = '';
  const policy = { ...rules, enabled: true };
  try {
    const result = await runImageRetention(policy, count => confirmDialog({
      title: rules.enabled ? '更新旧图自动清理规则' : '启用旧图自动清理',
      text: `找到 ${count} 张符合规则的旧图。确认后清理这些图片文件，并按最近 ${policy.keepFloors} 个 AI 楼、闲置 ${policy.idleDays} 天的规则自动清理。`,
      confirmText: rules.enabled ? '确认并更新' : '确认并开启',
      tone: 'danger',
    }));
    if (!result) return;
    settings.storage.retention = policy;
    const message = retentionResultText(result) + (rules.enabled ? '自动清理规则已更新。' : '自动清理已开启。');
    if (result.failed || result.interrupted) toastr.warning(message, '柏宝绘');
    else toastr.success(message, '柏宝绘');
  } catch (error) {
    toastr.error(error instanceof Error ? error.message : String(error), '柏宝绘');
  }
}

function disable() {
  settings.storage.retention = { ...settings.storage.retention, enabled: false };
  status.value = '自动清理已暂停。';
}
</script>

<template>
  <Collapsible title="旧图自动清理" :open="!!imageRetentionProgress">
    <label class="bbi-num-row">
      <span class="bbi-field-label">最近保留 AI 楼数</span>
      <input v-model.number="keepFloors" class="bbi-input bbi-num" type="number" inputmode="numeric" min="1" step="1" :disabled="!!imageRetentionProgress" />
    </label>
    <label class="bbi-num-row">
      <span class="bbi-field-label">闲置天数</span>
      <input v-model.number="idleDays" class="bbi-input bbi-num" type="number" inputmode="numeric" min="1" step="1" :disabled="!!imageRetentionProgress" />
    </label>
    <p class="bbi-field-hint">楼数按每个聊天计算，同一楼的多张插图一起保留。闲置从最后一条消息算起，满天数只保留最后一个有图的 AI 楼。图库使用已保存的规则。</p>
    <p v-if="settings.storage.retention.enabled" class="bbi-field-hint">
      已开启自动清理 · 最近 {{ settings.storage.retention.keepFloors }} 个 AI 楼 · 闲置 {{ settings.storage.retention.idleDays }} 天
    </p>
    <p v-else class="bbi-field-hint">自动清理已关闭。预览并确认后开启。</p>
    <button type="button" class="bbi-btn bbi-btn-primary" :disabled="!!imageRetentionProgress || !settings.enabled" @click="preview">
      <Icon v-if="imageRetentionProgress && imageRetentionProgress.phase !== 'confirming'" name="refresh" class="bbi-spin" />
      <span role="status">{{ imageRetentionStatus || (settings.storage.retention.enabled ? '预览并更新规则' : '预览旧图') }}</span>
    </button>
    <button v-if="settings.storage.retention.enabled" type="button" class="bbi-btn" :disabled="!!imageRetentionProgress && !imageRetentionProgress.automatic" @click="disable">暂停自动清理</button>
    <button v-else type="button" class="bbi-btn" :disabled="!!imageRetentionProgress" @click="saveRules">保存规则</button>
    <p v-if="status" class="bbi-field-hint" role="status">{{ status }}</p>
  </Collapsible>
</template>
