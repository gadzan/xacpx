<script setup lang="ts">
// Second pillar: the self-hosted relay hub web dashboard. Positions xacpx as
// "chat OR browser" — a CSS browser-window mockup (instances rail + a live
// session) above three highlights and a CTA. Single-accent, hairline-built,
// reuses the shared .cap-section scaffold from style.css.
import { computed } from 'vue';
import { useData, withBase } from 'vitepress';

const { lang } = useData();
const zh = computed(() => lang.value.startsWith('zh'));

const t = computed(() => ({
  kicker: zh.value ? '网页看板' : 'The web dashboard',
  title: zh.value ? '也可以在浏览器里遥控一切' : 'Or drive everything from your browser',
  sub: zh.value
    ? '自托管 relay hub，每个实例通过 WebSocket 拨入。在一个多租户看板里统一管理它们的全部会话——聊天、定时任务、编排；Agent 回复以实时 markdown 渲染，移动端也好用。'
    : 'Self-host the relay hub and every instance dials in over WebSocket. Manage all of their sessions — chat, scheduled tasks, orchestration — from one multi-tenant dashboard that renders agent replies as live markdown and works on mobile.',
  url: 'relay.example.com',
  railTitle: zh.value ? '实例' : 'Instances',
  instances: [
    { name: 'home-pc', state: 'online', active: true },
    { name: 'vps-1', state: 'online', active: false },
    { name: 'laptop', state: 'offline', active: false },
  ],
  session: 'backend · codex',
  userMsg: zh.value ? '修复接口超时问题' : 'fix the API timeout',
  botMsg: zh.value ? '已调整重试退避，并加了 30s 上限' : 'Patched the retry backoff, added a 30s ceiling',
  highlights: [
    {
      title: zh.value ? '多实例，一块屏' : 'Many instances, one screen',
      body: zh.value ? '你跑的每台机器都拨入同一个 hub。' : 'Every box you run dials into the same hub.',
      icon: 'servers',
    },
    {
      title: zh.value ? '多租户且安全' : 'Multi-tenant & secure',
      body: zh.value
        ? '登录与连接器配对共用一个 access token；租户只见自己的实例。'
        : 'One access token for web login and connector pairing; tenants see only their own.',
      icon: 'shield',
    },
    {
      title: zh.value ? '可安装 PWA' : 'Installable PWA',
      body: zh.value ? '把看板添加到主屏，回复以 markdown 流式渲染。' : 'Add it to your home screen; replies stream as markdown.',
      icon: 'install',
    },
  ],
  cta: zh.value ? '自托管 relay hub' : 'Self-host the relay hub',
  link: withBase(zh.value ? '/zh/guide/relay-self-hosting' : '/guide/relay-self-hosting'),
}));
</script>

<template>
  <section class="cap-section relay-section">
    <div class="cap-head" v-reveal="0">
      <span class="cap-kicker">{{ t.kicker }}</span>
      <h2 class="cap-title">{{ t.title }}</h2>
      <p class="demo-sub">{{ t.sub }}</p>
    </div>

    <!-- browser-window dashboard mockup -->
    <div class="relay-window" v-reveal="1" aria-hidden="true">
      <div class="relay-chrome">
        <span class="relay-dot relay-dot-r" />
        <span class="relay-dot relay-dot-y" />
        <span class="relay-dot relay-dot-g" />
        <span class="relay-url">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
          {{ t.url }}
        </span>
      </div>

      <div class="relay-body">
        <!-- instances rail -->
        <aside class="relay-rail">
          <p class="relay-rail-title">{{ t.railTitle }}</p>
          <div
            v-for="inst in t.instances"
            :key="inst.name"
            class="relay-inst"
            :class="{ 'is-active': inst.active }"
          >
            <span class="relay-status" :class="inst.state === 'online' ? 'is-online' : 'is-offline'" />
            <span class="relay-inst-name">{{ inst.name }}</span>
          </div>
        </aside>

        <!-- session pane -->
        <div class="relay-pane">
          <div class="relay-pane-head">
            <span class="relay-pane-arrow">▸</span>{{ t.session }}
          </div>
          <div class="relay-thread">
            <div class="relay-msg is-user">
              <span class="relay-bubble">{{ t.userMsg }}</span>
            </div>
            <div class="relay-msg is-bot">
              <span class="relay-bubble">{{ t.botMsg }}<span class="relay-caret" /></span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- highlights -->
    <ul class="relay-highlights" v-reveal="2">
      <li v-for="h in t.highlights" :key="h.title" class="relay-hl">
        <span class="relay-hl-icon">
          <svg v-if="h.icon === 'servers'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="8" rx="2" /><rect x="2" y="13" width="20" height="8" rx="2" /><line x1="6" y1="7" x2="6.01" y2="7" /><line x1="6" y1="17" x2="6.01" y2="17" /></svg>
          <svg v-else-if="h.icon === 'shield'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
        </span>
        <div>
          <p class="relay-hl-title">{{ h.title }}</p>
          <p class="relay-hl-body">{{ h.body }}</p>
        </div>
      </li>
    </ul>

    <div class="relay-cta" v-reveal="2">
      <a class="relay-cta-btn" :href="t.link">{{ t.cta }} →</a>
    </div>
  </section>
</template>

<style scoped>
.relay-section .demo-sub {
  margin-left: auto;
  margin-right: auto;
  max-width: 56ch;
}

/* browser window */
.relay-window {
  max-width: 880px;
  margin: 0 auto;
  border: 1px solid var(--x-line);
  border-radius: 16px;
  background: var(--x-s1);
  box-shadow: var(--x-shadow-2), inset 0 1px 0 rgba(255, 255, 255, 0.04);
  overflow: hidden;
}

.relay-chrome {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 11px 15px;
  border-bottom: 1px solid var(--x-line);
  background: rgba(255, 255, 255, 0.015);
}

.relay-dot {
  width: 11px;
  height: 11px;
  border-radius: 50%;
}
.relay-dot-r { background: #ed6a5e; }
.relay-dot-y { background: #f4be4f; }
.relay-dot-g { background: var(--x-status); }

.relay-url {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-left: 14px;
  padding: 4px 12px;
  border-radius: 8px;
  border: 1px solid var(--x-line);
  background: rgba(255, 255, 255, 0.02);
  font-family: var(--x-font-mono);
  font-size: 11.5px;
  color: var(--vp-c-text-3);
}
.relay-url svg { width: 12px; height: 12px; }

/* split body */
.relay-body {
  display: grid;
  grid-template-columns: minmax(0, 0.42fr) minmax(0, 1fr);
  min-height: 268px;
}

.relay-rail {
  padding: 16px 12px;
  border-right: 1px solid var(--x-line);
  background: rgba(255, 255, 255, 0.012);
}

.relay-rail-title {
  margin: 2px 6px 12px;
  font-family: var(--x-font-mono);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--vp-c-text-3);
}

.relay-inst {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: 9px;
  font-family: var(--x-font-mono);
  font-size: 13px;
  color: var(--vp-c-text-2);
}
.relay-inst.is-active {
  background: var(--x-accent-soft);
  color: var(--vp-c-text-1);
  box-shadow: inset 0 0 0 1px var(--x-line-2);
}

.relay-status {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}
.relay-status.is-online {
  background: var(--x-status);
  animation: relay-pulse 2.6s ease-out infinite;
}
.relay-status.is-offline {
  background: var(--vp-c-text-3);
  opacity: 0.5;
}

@keyframes relay-pulse {
  0% { box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.5); }
  70% { box-shadow: 0 0 0 6px rgba(52, 211, 153, 0); }
  100% { box-shadow: 0 0 0 0 rgba(52, 211, 153, 0); }
}

/* session pane */
.relay-pane { display: flex; flex-direction: column; }

.relay-pane-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 13px 18px;
  border-bottom: 1px solid var(--x-line);
  font-family: var(--x-font-mono);
  font-size: 12.5px;
  color: var(--vp-c-text-2);
}
.relay-pane-arrow { color: var(--x-accent-bright); }

.relay-thread {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px;
}

.relay-msg { display: flex; }
.relay-msg.is-user { justify-content: flex-end; }
.relay-msg.is-bot { justify-content: flex-start; }

.relay-bubble {
  max-width: 84%;
  padding: 9px 13px;
  border-radius: 13px;
  font-family: var(--x-font-mono);
  font-size: 12.5px;
  line-height: 1.5;
}
.is-user .relay-bubble {
  color: #0b0a16;
  background: var(--x-accent);
  border-bottom-right-radius: 4px;
  font-weight: 500;
}
.is-bot .relay-bubble {
  color: var(--vp-c-text-1);
  background: var(--x-s3);
  border: 1px solid var(--x-line);
  border-bottom-left-radius: 4px;
}

.relay-caret {
  display: inline-block;
  width: 7px;
  height: 13px;
  margin-left: 3px;
  vertical-align: text-bottom;
  background: var(--x-accent-bright);
  border-radius: 1px;
  animation: relay-blink 1s steps(2, start) infinite;
}
@keyframes relay-blink {
  50% { opacity: 0; }
}

/* highlights */
.relay-highlights {
  list-style: none;
  margin: 40px auto 0;
  padding: 0;
  max-width: 880px;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 20px;
}

.relay-hl {
  display: flex;
  gap: 13px;
  align-items: flex-start;
}

.relay-hl-icon {
  flex: none;
  width: 38px;
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  color: var(--x-accent-bright);
  background: var(--x-accent-soft);
  border: 1px solid var(--x-line);
}
.relay-hl-icon svg { width: 19px; height: 19px; }

.relay-hl-title {
  margin: 2px 0 0;
  font-family: var(--x-font-display);
  font-size: 15px;
  font-weight: 600;
  color: var(--vp-c-text-1);
}
.relay-hl-body {
  margin: 5px 0 0;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--vp-c-text-2);
}

/* cta */
.relay-cta {
  margin-top: 36px;
  text-align: center;
}
.relay-cta-btn {
  display: inline-block;
  padding: 11px 22px;
  border-radius: 10px;
  background: var(--x-accent);
  color: #0b0a16;
  font-family: var(--x-font-display);
  font-size: 14.5px;
  font-weight: 600;
  box-shadow: var(--x-shadow-1);
  transition: transform 0.15s ease, background-color 0.15s ease;
}
.relay-cta-btn:hover {
  transform: translateY(-1px);
  background: var(--x-accent-bright);
}

@media (max-width: 860px) {
  .relay-highlights {
    grid-template-columns: 1fr;
    gap: 18px;
  }
  .relay-body { min-height: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .relay-status.is-online,
  .relay-caret {
    animation: none !important;
  }
}
</style>
