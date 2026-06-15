import { defineStore } from "pinia";
import { ref } from "vue";

/** A tiny reactive bridge so non-composer UI (e.g. the command palette) can push
 *  text into a session's composer. The bumping `seq` makes repeated inserts of the
 *  same text still trigger the watcher in PromptInput. */
export const useComposerStore = defineStore("composer", () => {
  const insertRequest = ref<{ key: string; text: string; seq: number } | null>(null);
  let seq = 0;
  function requestInsert(key: string, text: string): void {
    insertRequest.value = { key, text, seq: ++seq };
  }
  return { insertRequest, requestInsert };
});
