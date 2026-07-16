<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { renderMarkdown } from "../lib/render-markdown";
import { hydrateMermaidBlocks, resetMermaidBlocks } from "../lib/render-mermaid";
import { enhanceMermaidBlock } from "../lib/inline-mermaid";
import MermaidViewer from "./MermaidViewer.vue";
import { useThemeStore } from "../stores/theme";

const { t } = useI18n();

const props = defineProps<{ text: string; streaming?: boolean }>();

// While streaming, every appended chunk grows `text`, and re-parsing the WHOLE buffer
// (healing + markdown-it + DOMPurify) per chunk is O(n²) over the turn. Throttle the parse
// to one render per THROTTLE_MS with a trailing call, so the last chunk always lands. The
// non-streaming path renders synchronously on every change, exactly like the old computed.
const THROTTLE_MS = 80;

const theme = useThemeStore();
const rootEl = ref<HTMLElement | null>(null);
const html = ref("");
let timer: ReturnType<typeof setTimeout> | null = null;
let lastRenderAt = 0;
let disposed = false;

function cancelTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

// Mermaid blocks are hydrated only when NOT streaming: a mid-stream fence (auto-closed by
// remend) holds a partial diagram that mermaid would fail to parse. During streaming the
// block shows its source (the <code> fallback); the finalized render hydrates it to SVG.
//
// hydrateMermaidBlocks is async, so two overlapping triggers on the same root (e.g. rapid
// theme toggles) could otherwise run concurrently. Chain every call through a per-instance
// promise so only one hydration pass runs at a time; a failed pass must not break the chain.
let hydrateChain: Promise<void> = Promise.resolve();

const viewerSvg = ref<string | null>(null);
let enhanceDetachers: Array<() => void> = [];
function detachEnhancers(): void {
  for (const d of enhanceDetachers) d();
  enhanceDetachers = [];
}
// After hydration, give each freshly-rendered diagram inline pan/zoom + a ⤢ that opens the
// fullscreen viewer. `data-mmd-enhanced` keeps the double-schedule-on-mount from wrapping the same
// block twice; it is cleared on a reset pass (below) because resetMermaidBlocks rebuilds the block
// from scratch, so the fresh SVG must be re-enhanced.
function enhanceRenderedBlocks(root: HTMLElement): void {
  root
    .querySelectorAll<HTMLElement>("pre.mermaid-block.mermaid-rendered:not([data-mmd-enhanced])")
    .forEach((block) => {
      block.setAttribute("data-mmd-enhanced", "1");
      enhanceDetachers.push(
        enhanceMermaidBlock(block, {
          onExpand: () => {
            viewerSvg.value = block.querySelector("svg")?.outerHTML ?? null;
          },
        }),
      );
    });
}

// A block whose diagram failed to render keeps its <code> source (spec fallback); tag it with a
// localized label the CSS `::before` renders muted, so the failure is legible instead of just a
// tinted border. The label text sits in a data-attr (i18n lives here, not in the DOM-only lib);
// it is inert once the `.mermaid-error` class is gone, so no cleanup is needed on reset.
function labelErrorBlocks(root: HTMLElement): void {
  root
    .querySelectorAll<HTMLElement>("pre.mermaid-block.mermaid-error:not([data-mmd-error-label])")
    .forEach((block) => block.setAttribute("data-mmd-error-label", t("chat.mermaidError")));
}

// A hydration pass is stale — must not touch the DOM — if the component was disposed, streaming
// resumed, or the root is gone. Checked when the queued callback finally runs (an earlier pass may
// have been in-flight across a streaming/unmount transition) AND, via hydrateMermaidBlocks'
// shouldAbort hook, again after each async render before it commits SVG.
function hydrationStale(): boolean {
  return disposed || props.streaming === true || rootEl.value === null;
}

function scheduleHydrate(reset: boolean): void {
  if (props.streaming) return;
  hydrateChain = hydrateChain
    .then(async () => {
      await nextTick();
      if (hydrationStale()) return;
      const root = rootEl.value;
      if (root === null) return; // narrows for TS; hydrationStale already ruled it out
      if (reset) {
        detachEnhancers();
        // resetMermaidBlocks rebuilds each block's children, so drop the enhancement marker too —
        // otherwise the re-rendered SVG is skipped by enhanceRenderedBlocks and loses pan/zoom.
        root
          .querySelectorAll("pre.mermaid-block[data-mmd-enhanced]")
          .forEach((block) => block.removeAttribute("data-mmd-enhanced"));
        resetMermaidBlocks(root);
      }
      await hydrateMermaidBlocks(root, theme.mode, hydrationStale);
      if (!hydrationStale()) {
        enhanceRenderedBlocks(root);
        labelErrorBlocks(root);
      }
    })
    .catch(() => {}); // one failed pass must not break the chain
}

function render(): void {
  lastRenderAt = Date.now();
  // Replacing v-html discards the current DOM, including any enhanced mermaid viewports; detach
  // their listeners first so a plain (finalized) re-render doesn't strand them until the next
  // theme switch or unmount. The freshly rendered HTML gets its own enhancers after hydration.
  detachEnhancers();
  html.value = renderMarkdown(props.text, { streaming: props.streaming });
  scheduleHydrate(false);
}

render(); // initial synchronous render (also seeds the throttle clock)
onMounted(() => scheduleHydrate(false)); // rootEl exists only after mount

watch(
  () => props.text,
  () => {
    if (!props.streaming) {
      cancelTimer();
      render();
      return;
    }
    const elapsed = Date.now() - lastRenderAt;
    if (elapsed >= THROTTLE_MS) {
      cancelTimer();
      render();
      return;
    }
    // Trailing edge: one pending render picks up whatever `text` holds when it fires.
    if (timer === null) {
      timer = setTimeout(() => {
        timer = null;
        render();
      }, THROTTLE_MS - elapsed);
    }
  },
);

// Streaming ended (or toggled): drop any pending throttled render and paint the
// final full text immediately — the closing frame must never lag or be skipped.
watch(
  () => props.streaming,
  () => {
    cancelTimer();
    render();
  },
);

// Theme switched: re-theme any already-rendered diagrams (the SVG cache is theme-keyed).
watch(
  () => theme.mode,
  () => scheduleHydrate(true),
);

onBeforeUnmount(() => {
  disposed = true;
  cancelTimer();
  detachEnhancers();
});
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- input is sanitized by renderMarkdown (DOMPurify) -->
  <div ref="rootEl" class="stream-md text-sm" v-html="html" />
  <MermaidViewer v-if="viewerSvg" :svg="viewerSvg" @close="viewerSvg = null" />
</template>

<style>
/* Tailwind's preflight strips element styling, so restore the markdown basics for
   v-html content. Non-scoped on purpose: scoped styles cannot reach v-html output. */
.stream-md > :first-child {
  margin-top: 0;
}
.stream-md > :last-child {
  margin-bottom: 0;
}
.stream-md p {
  margin: 0.5em 0;
  line-height: 1.5;
}
.stream-md h1,
.stream-md h2,
.stream-md h3,
.stream-md h4 {
  margin: 0.8em 0 0.4em;
  font-weight: 600;
  line-height: 1.3;
}
.stream-md h1 {
  font-size: 1.3em;
}
.stream-md h2 {
  font-size: 1.2em;
}
.stream-md h3 {
  font-size: 1.1em;
}
.stream-md ul,
.stream-md ol {
  margin: 0.5em 0;
  padding-left: 1.4em;
}
.stream-md ul {
  list-style: disc;
}
.stream-md ol {
  list-style: decimal;
}
.stream-md li {
  margin: 0.2em 0;
}
.stream-md a {
  color: rgb(var(--c-accent));
  text-decoration: underline;
}
/* Inline code: bg-surface rounded px-1 py-0.5 font-mono text-[12.5px] (mockup line 298) */
.stream-md code {
  background: rgb(var(--c-surface));
  color: rgb(var(--c-fg));
  border-radius: 4px;
  padding: 0.1em 0.3em;
  font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px;
}
/* Code block: cool snippet panel (mockup lines 331–346) — bg-bg/raised, border-border,
   rounded-lg, font-mono text-[13px], overflow-x with thin scrollbar. */
.stream-md pre {
  background: rgb(var(--c-bg));
  color: rgb(var(--c-fg));
  border: 1px solid rgb(var(--c-border));
  border-radius: 8px;
  padding: 0.65em 0.85em;
  overflow-x: auto;
  margin: 0.6em 0;
  box-shadow: var(--shadow-e1);
}
.stream-md pre::-webkit-scrollbar { height: 8px; }
.stream-md pre::-webkit-scrollbar-thumb { background: rgb(var(--c-fg-muted) / 0.28); border-radius: 8px; }
.stream-md pre::-webkit-scrollbar-track { background: transparent; }
.stream-md pre code {
  background: transparent;
  padding: 0;
  color: inherit;
  font-size: 13px;
  line-height: 1.6;
}
/* Cool syntax palette: keyword=accent, string=run, comment=fg-muted, number=info */
.stream-md .hljs-keyword,
.stream-md .hljs-built_in,
.stream-md .hljs-name,
.stream-md .hljs-tag {
  color: rgb(var(--c-accent));
}
.stream-md .hljs-string,
.stream-md .hljs-attr,
.stream-md .hljs-symbol {
  color: rgb(var(--c-run));
}
.stream-md .hljs-comment,
.stream-md .hljs-quote {
  color: rgb(var(--c-fg-muted));
}
.stream-md .hljs-number,
.stream-md .hljs-literal {
  color: rgb(var(--c-info));
}
.stream-md blockquote {
  border-left: 3px solid rgb(var(--c-border));
  margin: 0.6em 0;
  padding-left: 0.8em;
  color: rgb(var(--c-fg-muted));
}
/* A wrapping div (emitted by the markdown renderer) provides horizontal scroll for wide
   tables. The <table> itself keeps normal table layout so columns stay aligned — setting
   display:block on the table would collapse the grid into a stacked single column. */
.stream-md .md-table-wrap {
  max-width: 100%;
  overflow-x: auto;
  margin: 0.6em 0;
}
.stream-md .md-table-wrap::-webkit-scrollbar { height: 8px; }
.stream-md .md-table-wrap::-webkit-scrollbar-thumb { background: rgb(var(--c-fg-muted) / 0.28); border-radius: 8px; }
.stream-md .md-table-wrap::-webkit-scrollbar-track { background: transparent; }
.stream-md table {
  border-collapse: collapse;
}
.stream-md img {
  max-width: 100%;
  height: auto;
}
.stream-md th,
.stream-md td {
  border: 1px solid rgb(var(--c-border));
  padding: 0.3em 0.6em;
}
.stream-md hr {
  border: none;
  border-top: 1px solid rgb(var(--c-border));
  margin: 0.8em 0;
}
/* Mermaid: the pre.mermaid-block is a code-styled fallback until hydrated. Once rendered, the
   inline enhancer replaces its content with a bounded pan/zoom viewport + a controls bar, so the
   <pre> itself is just the positioning context — strip its code styling and let the viewport clip. */
.stream-md .mermaid-block.mermaid-rendered {
  position: relative;
  padding: 0;
  border: none;
  background: transparent;
  box-shadow: none;
  overflow: visible;
}
.stream-md .mermaid-block.mermaid-error {
  border-color: rgb(var(--c-danger, var(--c-border)));
}
/* Muted caption above the preserved source so a failed render reads as failed, not just tinted. */
.stream-md .mermaid-block.mermaid-error::before {
  content: attr(data-mmd-error-label);
  display: block;
  margin-bottom: 0.4em;
  color: rgb(var(--c-fg-muted));
  font-size: 12px;
}
.stream-md .mmd-viewport {
  /* Height is set inline by the enhancer to the fitted diagram height (capped there); the fallback
     max-height only applies if measurement was unavailable and no inline height was set. */
  max-height: 560px;
  overflow: hidden;
  border: 1px solid rgb(var(--c-border));
  border-radius: 8px;
  background: rgb(var(--c-bg));
  box-shadow: var(--shadow-e1);
  touch-action: pan-y; /* one finger scrolls the page; the enhancer handles pinch + mouse drag */
  cursor: grab;
}
.stream-md .mmd-viewport:active {
  cursor: grabbing;
}
.stream-md .mmd-transform {
  transform-origin: 0 0;
  width: max-content;
}
.stream-md .mmd-transform svg {
  display: block;
}
.stream-md .mmd-controls {
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  gap: 4px;
  opacity: 0.5;
  transition: opacity 0.12s;
}
.stream-md .mermaid-block.mermaid-rendered:hover .mmd-controls,
.stream-md .mermaid-block.mermaid-rendered:focus-within .mmd-controls {
  opacity: 1;
}
.stream-md .mmd-controls button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.6rem;
  height: 1.6rem;
  font-size: 14px;
  line-height: 1;
  border-radius: 6px;
  border: 1px solid rgb(var(--c-border));
  background: rgb(var(--c-surface));
  color: rgb(var(--c-fg));
}
.stream-md .mmd-controls button:hover {
  background: rgb(var(--c-bg-raised, var(--c-surface)));
}
</style>
