<script setup lang="ts">
import { computed } from "vue";
import { renderMarkdown } from "../lib/render-markdown";

const props = defineProps<{ text: string; streaming?: boolean }>();
const html = computed(() => renderMarkdown(props.text, { streaming: props.streaming }));
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
/* Inline code: bg-fg/5 text-fg rounded px-1 */
.stream-md code {
  background: rgb(var(--c-fg) / 0.05);
  color: rgb(var(--c-fg));
  border-radius: 4px;
  padding: 0.1em 0.3em;
  font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.9em;
}
/* Code block: bg-raised border border-border rounded-lg, font-mono text-[13px] */
.stream-md pre {
  background: rgb(var(--c-raised));
  color: rgb(var(--c-fg));
  border: 1px solid rgb(var(--c-border));
  border-radius: 8px;
  padding: 0.7em 0.9em;
  overflow-x: auto;
  margin: 0.6em 0;
}
.stream-md pre code {
  background: transparent;
  padding: 0;
  color: inherit;
  font-size: 13px;
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
.stream-md table {
  border-collapse: collapse;
  margin: 0.6em 0;
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
