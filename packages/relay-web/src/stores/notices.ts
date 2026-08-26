import { defineStore } from "pinia";
import { ref } from "vue";
import type { WebServerEvent } from "@ganglion/xacpx-relay-protocol";

export interface NoticeItem {
  id: number;
  instanceId: string;
  kind: string;
  text: string;
}

const MAX = 20;

export const useNoticesStore = defineStore("notices", () => {
  const items = ref<NoticeItem[]>([]);
  let seq = 0;

  function applyEvent(event: WebServerEvent): void {
    if (event.kind !== "notice") return;
    items.value.unshift({ id: ++seq, instanceId: event.instanceId, kind: event.notice.kind, text: event.notice.text });
    if (items.value.length > MAX) items.value.length = MAX;
  }

  function dismiss(id: number): void {
    items.value = items.value.filter((n) => n.id !== id);
  }

  return { items, applyEvent, dismiss };
});
