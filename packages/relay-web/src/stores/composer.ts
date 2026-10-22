import { defineStore } from "pinia";
import { computed, reactive, ref } from "vue";
import type { PromptAttachmentRef } from "@ganglion/xacpx-relay-protocol";
import { api } from "../api/client";
import { downscaleImage, fileToBase64 } from "../lib/image-downscale";

const MAX_ATTACHMENTS = 5;
const MAX_BYTES = 10 * 1024 * 1024;

export interface PendingAttachment {
  id: string;
  uploadId?: string;
  filename: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
  previewUrl?: string;
  filePath?: string;
  status: "uploading" | "ready" | "error";
}

interface AttachmentDraft {
  instanceId: string;
  epoch: number;
  pending: PendingAttachment[];
  rejection: { reason: "too-many" | "too-large"; filename: string } | null;
}

export const useComposerStore = defineStore("composer", () => {
  const insertRequest = ref<{ key: string; text: string; seq: number } | null>(null);
  let seq = 0;
  function requestInsert(key: string, text: string): void {
    insertRequest.value = { key, text, seq: ++seq };
  }

  const drafts = reactive<Record<string, AttachmentDraft>>({});
  const activeKey = ref("");
  const files = new Map<string, File>();
  let localSeq = 0;
  const pending = computed(() => drafts[activeKey.value]?.pending ?? []);
  const uploading = computed(() => pending.value.some((entry) => entry.status === "uploading"));
  const rejection = computed(() => drafts[activeKey.value]?.rejection ?? null);

  function bindInstance(instanceId: string, scopeKey = instanceId): void {
    if (activeKey.value !== scopeKey) {
      const previous = drafts[activeKey.value];
      if (previous) {
        previous.epoch++;
        for (const entry of previous.pending) {
          if (entry.status === "uploading") entry.status = "error";
        }
      }
    }
    if (!drafts[scopeKey]) drafts[scopeKey] = { instanceId, epoch: 0, pending: [], rejection: null };
    activeKey.value = scopeKey;
  }

  async function uploadEntry(draft: AttachmentDraft, entry: PendingAttachment, file: File): Promise<void> {
    const epoch = draft.epoch;
    entry.status = "uploading";
    try {
      const preview = await downscaleImage(file);
      if (epoch !== draft.epoch || !draft.pending.includes(entry)) return;
      entry.previewUrl = preview;
      const content = await fileToBase64(file);
      if (epoch !== draft.epoch || !draft.pending.includes(entry)) return;
      const result = await api.upload(draft.instanceId, { filename: entry.filename, content, mimeType: entry.mimeType });
      if (epoch !== draft.epoch || !draft.pending.includes(entry)) return;
      entry.uploadId = result.id;
      entry.filePath = result.path;
      entry.size = result.size;
      entry.status = "ready";
    } catch {
      if (epoch === draft.epoch && draft.pending.includes(entry)) entry.status = "error";
    }
  }

  async function addFiles(incoming: File[], scopeKey = activeKey.value): Promise<void> {
    const draft = drafts[scopeKey];
    if (!draft?.instanceId) return;
    const epoch = draft.epoch;
    draft.rejection = null;
    const entries: Array<{ entry: PendingAttachment; file: File }> = [];
    for (const file of incoming) {
      if (draft.pending.length >= MAX_ATTACHMENTS) {
        draft.rejection = { reason: "too-many", filename: file.name };
        break;
      }
      if (file.size > MAX_BYTES) {
        draft.rejection = { reason: "too-large", filename: file.name };
        continue;
      }
      const id = `local-${++localSeq}`;
      draft.pending.push({ id, filename: file.name, mimeType: file.type || "application/octet-stream", size: file.size,
        kind: file.type.startsWith("image/") ? "image" : "file", status: "uploading" });
      const entry = draft.pending[draft.pending.length - 1]!;
      files.set(id, file);
      entries.push({ entry, file });
    }
    for (const { entry, file } of entries) {
      if (epoch !== draft.epoch) break;
      if (draft.pending.includes(entry)) await uploadEntry(draft, entry, file);
    }
  }

  async function retryAttachment(id: string, scopeKey = activeKey.value): Promise<void> {
    const draft = drafts[scopeKey];
    const entry = draft?.pending.find((item) => item.id === id);
    const file = files.get(id);
    if (draft && entry?.status === "error" && file) await uploadEntry(draft, entry, file);
  }

  function removeAttachment(id: string, scopeKey = activeKey.value): void {
    const draft = drafts[scopeKey];
    if (!draft) return;
    draft.pending = draft.pending.filter((entry) => entry.id !== id);
    draft.rejection = null;
    files.delete(id);
  }

  function clearAttachments(scopeKey = activeKey.value): void {
    const draft = drafts[scopeKey];
    if (!draft) return;
    draft.epoch++;
    for (const entry of draft.pending) files.delete(entry.id);
    draft.pending = [];
    draft.rejection = null;
  }

  function snapshot(scopeKey = activeKey.value): { ids: string[]; media: PromptAttachmentRef[] } {
    const ready = drafts[scopeKey]?.pending.filter((entry) => entry.status === "ready" && entry.filePath && entry.uploadId) ?? [];
    return { ids: ready.map((entry) => entry.id), media: ready.map((entry) => ({
      id: entry.uploadId!, filePath: entry.filePath!, fileName: entry.filename, mimeType: entry.mimeType,
      kind: entry.kind, size: entry.size, ...(entry.previewUrl ? { previewUrl: entry.previewUrl } : {}),
    })) };
  }

  function consume(scopeKey: string, ids: readonly string[]): void {
    for (const id of ids) removeAttachment(id, scopeKey);
  }

  return { insertRequest, requestInsert, pending, uploading, rejection, bindInstance, addFiles, retryAttachment,
    removeAttachment, clearAttachments, snapshot, consume };
});
