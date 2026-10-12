import { defineStore } from "pinia";
import { ref } from "vue";
import type { AgentMention } from "@ganglion/xacpx-relay-protocol";
export const useDirectComposerStore = defineStore("direct-composer", () => {
  const drafts = ref<
    Record<string, { text: string; mentions: AgentMention[] }>
  >({});
  function get(key: string) {
    return drafts.value[key] ?? { text: "", mentions: [] };
  }
  function set(key: string, text: string, mentions: AgentMention[]) {
    drafts.value[key] = { text, mentions };
  }
  function clear(key: string, text: string, mentions: AgentMention[]) {
    const current = get(key);
    if (
      current.text === text &&
      JSON.stringify(current.mentions) === JSON.stringify(mentions)
    )
      delete drafts.value[key];
  }
  return { get, set, clear };
});
