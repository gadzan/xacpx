<script setup lang="ts">
// The "bridge" showcase — xacpx literally is a bridge between the agents it
// drives and the chat channels it runs in. Three connected parts:
//   1. agents: an infinite full-colour logo marquee (@lobehub/icons)
//   2. xacpx: the central hub the wires converge into
//   3. channels: real brand SVG logos (WeChat / Feishu provided; Yuanbao from lobe)
// Converging/diverging wires + flowing packets tie the three together. Wire
// endpoints (x = 167 / 500 / 833 of the 1000-wide viewBox) line up with the
// channel grid columns (centres at 1/6, 1/2, 5/6).
import { computed } from 'vue';
import { useData } from 'vitepress';

// full-colour variants where available, else mono (renders in currentColor)
import codex from '@lobehub/icons-static-svg/icons/codex-color.svg?raw';
import claudecode from '@lobehub/icons-static-svg/icons/claudecode-color.svg?raw';
import gemini from '@lobehub/icons-static-svg/icons/gemini-color.svg?raw';
import cursor from '@lobehub/icons-static-svg/icons/cursor.svg?raw';
import copilot from '@lobehub/icons-static-svg/icons/copilot-color.svg?raw';
import opencode from '@lobehub/icons-static-svg/icons/opencode.svg?raw';
import qwen from '@lobehub/icons-static-svg/icons/qwen-color.svg?raw';
import kimi from '@lobehub/icons-static-svg/icons/kimi-color.svg?raw';
import openclaw from '@lobehub/icons-static-svg/icons/openclaw-color.svg?raw';
import kilocode from '@lobehub/icons-static-svg/icons/kilocode.svg?raw';
import kiro from '@lobehub/icons-static-svg/icons/kiro-color.svg?raw';
import qoder from '@lobehub/icons-static-svg/icons/qoder-color.svg?raw';
import trae from '@lobehub/icons-static-svg/icons/trae-color.svg?raw';
import yuanbaoSvg from '@lobehub/icons-static-svg/icons/yuanbao-color.svg?raw';

const { lang } = useData();
const zh = computed(() => lang.value.startsWith('zh'));

interface Agent {
  name: string;
  svg?: string;
  mono?: string;
}

const agents: Agent[] = [
  { name: 'Codex', svg: codex },
  { name: 'Claude Code', svg: claudecode },
  { name: 'Gemini', svg: gemini },
  { name: 'Cursor', svg: cursor },
  { name: 'Copilot', svg: copilot },
  { name: 'OpenCode', svg: opencode },
  { name: 'Droid', mono: 'D' },
  { name: 'Qwen', svg: qwen },
  { name: 'Kimi', svg: kimi },
  { name: 'OpenClaw', svg: openclaw },
  { name: 'Pi', mono: 'π' },
  { name: 'iFlow', mono: 'iF' },
  { name: 'Kilocode', svg: kilocode },
  { name: 'Kiro', svg: kiro },
  { name: 'omp', mono: 'o' },
  { name: 'Reasonix', mono: 'Rx' },
  { name: 'Qoder', svg: qoder },
  { name: 'Trae', svg: trae },
];

// duplicated track for a seamless infinite marquee
const track = computed(() => [...agents, ...agents]);

// Real brand marks. WeChat + Feishu provided as official SVGs; Yuanbao from @lobehub/icons.
const wechatSvg = `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M32.8 18.003 32.5 18C25.732 18 20 22.798 20 29c0 1.007.151 1.976.433 2.894A18 18 0 0 1 18.5 32c-1.809 0-3.54-.274-5.137-.775-.394-.123-1.828.696-3.039 1.389-.927.53-1.724.986-1.824.886-.094-.094.169-.718.476-1.448.446-1.06.986-2.346.664-2.552C6.21 27.305 4 23.866 4 20c0-6.627 6.492-12 14.5-12 7.186 0 13.151 4.326 14.3 10.003M16 16a2 2 0 1 1-4 0 2 2 0 0 1 4 0m7 2a2 2 0 1 0 0-4 2 2 0 0 0 0 4" fill="#6bb657"/><path fill-rule="evenodd" clip-rule="evenodd" d="M44 29c0 3.362-1.908 6.336-4.833 8.149-.13.08.169.858.446 1.583.237.618.459 1.196.387 1.268-.075.075-.802-.327-1.571-.752-.829-.458-1.706-.942-1.871-.888-1.262.413-2.63.64-4.058.64C26.149 39 21 34.523 21 29s5.149-10 11.5-10S44 23.477 44 29m-6-3.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0M28.5 27a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3" fill="#6bb657"/></svg>`;
const feishuSvg = `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 8c0 1 7 3.5 14.745 16.744 0 0 4.184-4.363 6.255-5.744 1.5-1 2.712-1.332 2.712-1.332C33.712 15.156 29.5 8 28 8z" fill="#00d6b9"/><path d="M43.5 18.5c-1-.667-3.65-1.771-6.5-1.5a15 15 0 0 0-3.288.668S32.5 18 31 19c-2.07 1.38-6.255 5.744-6.255 5.744-1.428 1.397-3.05 2.732-5.245 3.756 0 0 7 3 11.5 3 5.063 0 7-3.5 7-3.5 1.5-3.305 3.5-7 5.5-9.5" fill="#163c9a"/><path d="M4 17.5v17c0 1 6 5.5 15 5.5 10 0 17.05-7.705 19-12 0 0-1.937 3.5-7 3.5-4.5 0-11.5-3-11.5-3-5.117-2.239-10.03-6.577-12.906-9.117C4.974 17.953 4 17.093 4 17.5" fill="#3370ff"/></svg>`;

const channels = computed(() => [
  { key: 'wechat', name: zh.value ? '微信' : 'WeChat', svg: wechatSvg, x: 167, size: 34 },
  { key: 'feishu', name: zh.value ? '飞书' : 'Feishu', svg: feishuSvg, x: 500, size: 34 },
  { key: 'yuanbao', name: zh.value ? '元宝' : 'Yuanbao', svg: yuanbaoSvg, x: 833, size: 34 },
]);

// wire geometry (viewBox 0 0 1000 220, hub centred at 500)
const HUB = { topY: 90, botY: 144 };
const topAnchors = [120, 310, 500, 690, 880];
function topWire(x: number): string {
  return `M${x},2 C ${x},56 500,42 500,${HUB.topY}`;
}
function botWire(x: number): string {
  return `M500,${HUB.botY} C 500,196 ${x},190 ${x},218`;
}
</script>

<template>
  <div class="bridge">
    <p class="bridge-label">{{ zh ? '驱动这些 Agent，运行在这些频道' : 'Works with — runs in' }}</p>

    <!-- 1. agents marquee -->
    <div class="bridge-marquee">
      <div class="bridge-track">
        <span
          v-for="(a, i) in track"
          :key="a.name + i"
          class="bridge-chip"
          :aria-hidden="i >= agents.length ? 'true' : undefined"
        >
          <span v-if="a.svg" class="bridge-logo" v-html="a.svg" />
          <span v-else class="bridge-logo bridge-logo-mono">{{ a.mono }}</span>
          {{ a.name }}
        </span>
      </div>
    </div>

    <!-- 2. connectors + hub -->
    <svg class="bridge-stage" viewBox="0 0 1000 220" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <defs>
        <filter id="bridgeGlow" x="-200%" y="-200%" width="500%" height="500%">
          <feGaussianBlur stdDeviation="2.6" />
        </filter>
        <filter id="hubHalo" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="9" />
        </filter>
        <linearGradient id="hubFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#9a8cff" />
          <stop offset="1" stop-color="#6655e6" />
        </linearGradient>
      </defs>

      <path v-for="x in topAnchors" :key="'tw' + x" class="bridge-wire" :d="topWire(x)" />
      <path v-for="c in channels" :key="'bw' + c.key" class="bridge-wire" :d="botWire(c.x)" />

      <g v-for="(x, i) in topAnchors" :key="'tp' + x" class="bridge-flow">
        <circle class="bridge-flow-glow" r="5" />
        <circle class="bridge-flow-core" r="2.4" />
        <animateMotion
          :dur="'2.6s'"
          :begin="i * 0.4 + 's'"
          repeatCount="indefinite"
          :path="topWire(x)"
          calcMode="spline"
          keyPoints="0;1"
          keyTimes="0;1"
          keySplines="0.45 0 0.55 1"
        />
      </g>
      <g v-for="(c, i) in channels" :key="'bp' + c.key" class="bridge-flow">
        <circle class="bridge-flow-glow" r="5" />
        <circle class="bridge-flow-core" r="2.4" />
        <animateMotion
          :dur="'2.4s'"
          :begin="0.6 + i * 0.5 + 's'"
          repeatCount="indefinite"
          :path="botWire(c.x)"
          calcMode="spline"
          keyPoints="0;1"
          keyTimes="0;1"
          keySplines="0.45 0 0.55 1"
        />
      </g>

      <g class="bridge-hub">
        <rect class="hub-halo" x="424" y="90" width="152" height="54" rx="16" />
        <rect class="hub-ring" x="424" y="90" width="152" height="54" rx="16" />
        <rect class="hub-ring hub-ring-2" x="424" y="90" width="152" height="54" rx="16" />
        <rect class="hub-pill" x="424" y="90" width="152" height="54" rx="16" />
        <rect class="hub-sheen" x="431" y="94" width="138" height="22" rx="11" />
        <text class="hub-text" x="500" y="117">xacpx</text>
      </g>
    </svg>

    <!-- 3. channels (real brand logos), columns aligned under the wire ends -->
    <div class="bridge-channels">
      <div v-for="c in channels" :key="c.key" class="bridge-channel">
        <span class="bridge-ctile" :style="{ '--cs': c.size + 'px' }" v-html="c.svg" />
        <span class="bridge-clabel">{{ c.name }}</span>
      </div>
    </div>
  </div>
</template>
