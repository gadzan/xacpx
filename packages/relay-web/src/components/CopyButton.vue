<script setup lang="ts">
import { ref } from "vue";
import { Check, Copy } from "lucide-vue-next";

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
    aria-label="Copy"
    :title="copied ? 'Copied' : 'Copy'"
    class="rounded p-1 leading-none text-fg-muted hover:bg-fg/5 hover:text-fg"
    @click.stop="copy"
  >
    <Check v-if="copied" :size="14" class="text-run" />
    <Copy v-else :size="14" />
  </button>
</template>
