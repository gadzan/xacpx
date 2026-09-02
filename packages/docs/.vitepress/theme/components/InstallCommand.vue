<script setup lang="ts">
// Tabbed install command, one tab per channel (mirrors Vite's package-manager tabs).
import { ref, computed } from 'vue';
import { useData } from 'vitepress';

const { lang } = useData();
const zh = computed(() => lang.value.startsWith('zh'));

interface Tab {
  key: string;
  label: string;
  note: string;
  lines: string[];
}

const tabs = computed<Tab[]>(() => [
  {
    key: 'wechat',
    label: zh.value ? '微信' : 'WeChat',
    note: zh.value ? '内置' : 'built-in',
    lines: [
      'npm i -g @ganglion/xacpx',
      'xacpx login',
      'xacpx start',
    ],
  },
  {
    key: 'feishu',
    label: zh.value ? '飞书' : 'Feishu',
    note: zh.value ? '插件' : 'plugin',
    lines: [
      'npm i -g @ganglion/xacpx',
      'xacpx plugin add @ganglion/xacpx-channel-feishu',
      'xacpx channel add feishu',
    ],
  },
  {
    key: 'yuanbao',
    label: zh.value ? '元宝' : 'Yuanbao',
    note: zh.value ? '插件' : 'plugin',
    lines: [
      'npm i -g @ganglion/xacpx',
      'xacpx plugin add @ganglion/xacpx-channel-yuanbao',
      'xacpx channel add yuanbao',
    ],
  },
  {
    key: 'discord',
    label: 'Discord',
    note: zh.value ? '插件' : 'plugin',
    lines: [
      'npm i -g @ganglion/xacpx',
      'xacpx plugin add @ganglion/xacpx-channel-discord',
      'xacpx channel add discord',
    ],
  },
]);

const active = ref('wechat');
const current = computed(() => tabs.value.find((t) => t.key === active.value) ?? tabs.value[0]);
const copied = ref(false);

async function copy() {
  try {
    await navigator.clipboard.writeText(current.value.lines.join('\n'));
    copied.value = true;
    setTimeout(() => (copied.value = false), 1600);
  } catch {
    /* clipboard unavailable; ignore */
  }
}
</script>

<template>
  <div class="install-cmd">
    <div class="install-tabs" role="tablist">
      <button
        v-for="t in tabs"
        :key="t.key"
        class="install-tab"
        :class="{ active: t.key === active }"
        type="button"
        role="tab"
        :aria-selected="t.key === active"
        @click="active = t.key"
      >
        {{ t.label }}
        <span class="install-tab-note">{{ t.note }}</span>
      </button>
    </div>
    <div class="install-body">
      <div class="install-code">
        <div v-for="(line, i) in current.lines" :key="i" class="install-line">
          <span class="install-prompt">$</span><span class="install-text">{{ line }}</span>
        </div>
      </div>
      <button
        class="install-copy"
        :class="{ copied }"
        type="button"
        :aria-label="zh ? '复制命令' : 'Copy commands'"
        @click="copy"
      >
        {{ copied ? (zh ? '已复制' : 'Copied') : (zh ? '复制' : 'Copy') }}
      </button>
    </div>
  </div>
</template>
