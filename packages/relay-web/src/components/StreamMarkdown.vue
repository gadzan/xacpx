<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { renderMarkdown } from "../lib/render-markdown";

const props = defineProps<{ text: string; streaming?: boolean }>();

// While streaming, every appended chunk grows `text`, and re-parsing the WHOLE buffer
// (healing + markdown-it + DOMPurify) per chunk is O(n²) over the turn. Throttle the parse
// to one render per THROTTLE_MS with a trailing call, so the last chunk always lands. The
// non-streaming path renders synchronously on every change, exactly like the old computed.
const THROTTLE_MS = 80;

const html = ref("");
let timer: ReturnType<typeof setTimeout> | null = null;
let lastRenderAt = 0;

function cancelTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

function render(): void {
  lastRenderAt = Date.now();
  html.value = renderMarkdown(props.text, { streaming: props.streaming });
}

render(); // initial synchronous render (also seeds the throttle clock)

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

onBeforeUnmount(cancelTimer);
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- input is sanitized by renderMarkdown (DOMPurify) -->
  <div class="stream-md text-sm" v-html="html" />
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
</style>
