<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import { Check, Copy } from "lucide-vue-next";

const props = defineProps<{ text: string }>();
const copied = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
});

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
    :aria-label='$t("copy.copy")'
    :title='copied ? $t("copy.copied") : $t("copy.copy")'
    class="shrink-0 rounded-sm p-1 leading-[0] text-fg-muted transition-[transform,color,background-color] duration-150 ease-ui hover:bg-fg/5 hover:text-fg active:scale-95 motion-reduce:transition-none motion-reduce:active:scale-100 [&_svg]:block [@media(pointer:coarse)]:grid [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 [@media(pointer:coarse)]:place-items-center [@media(pointer:coarse)]:p-0"
    @click.stop="copy"
  >
    <!-- Both glyphs share one 14px box so the swap has nowhere to move to: the
         copied state shrinks the Copy icon away and scales the Check in on top
         of it (`.ui-swap-*`, 120ms — fast enough to read as "done"). -->
    <span class="relative block h-3.5 w-3.5">
      <Transition name="ui-swap">
        <span v-if="copied" key="check" class="absolute inset-0 grid place-items-center">
          <Check :size="14" class="text-run" />
        </span>
        <span v-else key="copy" class="absolute inset-0 grid place-items-center">
          <Copy :size="14" />
        </span>
      </Transition>
    </span>
  </button>
</template>
