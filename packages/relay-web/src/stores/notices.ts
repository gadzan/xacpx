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
export const QUEUE_OVERFLOW_TOAST_MS = 3000;

export const useNoticesStore = defineStore("notices", () => {
  const items = ref<NoticeItem[]>([]);
  let seq = 0;
  const autoDismiss = new Map<number, ReturnType<typeof setTimeout>>();

  function clearTimer(id: number): void {
    const timer = autoDismiss.get(id);
    if (timer) {
      clearTimeout(timer);
      autoDismiss.delete(id);
    }
  }

  function applyEvent(event: WebServerEvent): void {
    if (event.kind !== "notice") return;
    const id = ++seq;
    items.value.unshift({ id, instanceId: event.instanceId, kind: event.notice.kind, text: event.notice.text });
    if (items.value.length > MAX) {
      for (const dropped of items.value.slice(MAX)) clearTimer(dropped.id);
      items.value.length = MAX;
    }
    if (event.notice.kind === "queue-overflow") {
      autoDismiss.set(id, setTimeout(() => dismiss(id), QUEUE_OVERFLOW_TOAST_MS));
    }
  }

  function dismiss(id: number): void {
    clearTimer(id);
    items.value = items.value.filter((n) => n.id !== id);
  }

  return { items, applyEvent, dismiss };
});
