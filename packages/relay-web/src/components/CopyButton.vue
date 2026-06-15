<script setup lang="ts">
import { ref } from "vue";

const props = defineProps<{ text: string }>();
const copied = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.text);
  } catch {
    // Fallback for insecure contexts / older engines.
    const ta = document.createElement("textarea");
    ta.value = props.text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      /* give up silently */
    }
    document.body.removeChild(ta);
  }
  copied.value = true;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => (copied.value = false), 1200);
}
</script>

<template>
  <button
    data-test="copy-button"
    type="button"
    :title="copied ? 'Copied' : 'Copy'"
    class="rounded p-1 text-xs leading-none text-slate-400 hover:bg-slate-200 hover:text-slate-600"
    @click.stop="copy"
  >
    {{ copied ? "✓" : "⧉" }}
  </button>
</template>
