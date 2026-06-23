<script setup lang="ts">
// Home layout: default VitePress theme + xacpx home (Linear craft x field.io motion).
// - Forces dark appearance on the home route only (restores the visitor's
//   preference on inner pages).
// - Generative WebGL plasma behind the hero (home-hero-before).
// - Eyebrow, install command, chat mockup, works-with strip, and the
//   self-playing / pipeline / capability sections layered into the home slots.
import { computed, onMounted, onUnmounted, watch } from 'vue';
import DefaultTheme from 'vitepress/theme';
import { useData } from 'vitepress';
import HeroCanvas from './components/HeroCanvas.vue';
import InstallCommand from './components/InstallCommand.vue';
import ChatMockup from './components/ChatMockup.vue';
import BridgeShowcase from './components/BridgeShowcase.vue';
import ChatDemoSection from './components/ChatDemoSection.vue';
import ArchitectureSection from './components/ArchitectureSection.vue';
import CapabilitiesSection from './components/CapabilitiesSection.vue';
import RelaySection from './components/RelaySection.vue';

const { Layout } = DefaultTheme;
const { lang, frontmatter } = useData();
const zh = computed(() => lang.value.startsWith('zh'));
const isHome = computed(() => frontmatter.value.layout === 'home');

// Force dark on the home route only; remember + restore the user's choice.
let savedDark: boolean | null = null;

function applyHomeTheme(home: boolean) {
  if (typeof document === 'undefined') return;
  const el = document.documentElement;
  if (home) {
    if (savedDark === null) savedDark = el.classList.contains('dark');
    el.classList.add('dark');
    el.classList.add('x-home');
  } else {
    el.classList.remove('x-home');
    if (savedDark === false) el.classList.remove('dark');
    savedDark = null;
  }
}

watch(isHome, (v) => applyHomeTheme(v));
onMounted(() => applyHomeTheme(isHome.value));
onUnmounted(() => applyHomeTheme(false));
</script>

<template>
  <Layout>
    <template #home-hero-before>
      <HeroCanvas />
    </template>
    <template #home-hero-info-before>
      <p class="hero-eyebrow">
        <span class="hero-eyebrow-dot" />
        {{ zh ? '开源 · 驱动任意 Agent' : 'Open source · Drive any agent' }}
      </p>
    </template>
    <template #home-hero-actions-after>
      <InstallCommand />
    </template>
    <template #home-hero-image>
      <ChatMockup />
    </template>
    <template #home-hero-after>
      <BridgeShowcase />
    </template>
    <template #home-features-before>
      <ChatDemoSection />
    </template>
    <template #home-features-after>
      <RelaySection />
      <ArchitectureSection />
      <CapabilitiesSection />
    </template>
  </Layout>
</template>
