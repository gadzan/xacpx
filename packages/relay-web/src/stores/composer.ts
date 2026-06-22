import { defineStore } from "pinia";
import { ref } from "vue";

import { api } from "../api/client";
import { downscaleImage, fileToBase64 } from "../lib/image-downscale";

const MAX_ATTACHMENTS = 5;
const MAX_BYTES = 10 * 1024 * 1024;

export interface PendingAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
  previewUrl?: string;
  filePath?: string;
  status: "uploading" | "ready" | "error";
}

/** A tiny reactive bridge so non-composer UI (e.g. the command palette) can push
 *  text into a session's composer. The bumping `seq` makes repeated inserts of the
 *  same text still trigger the watcher in PromptInput. */
export const useComposerStore = defineStore("composer", () => {
  const insertRequest = ref<{ key: string; text: string; seq: number } | null>(null);
  let seq = 0;
  function requestInsert(key: string, text: string): void {
    insertRequest.value = { key, text, seq: ++seq };
  }

  const pending = ref<PendingAttachment[]>([]);
  const uploading = ref(false);
  const rejection = ref<{ reason: "too-many" | "too-large"; filename: string } | null>(null);
  let instanceId = "";
  let localSeq = 0;

  function bindInstance(id: string): void {
    instanceId = id;
  }

  async function addFiles(files: File[]): Promise<void> {
    // Capture the target instance once at the start: an in-flight batch must keep
    // uploading to the instance it began with, even if bindInstance() switches the
    // active instance mid-flight (session/instance switch while files are queued).
    const targetInstanceId = instanceId;
    if (!targetInstanceId) return;
    rejection.value = null;
    uploading.value = true;
    for (const file of files) {
      if (pending.value.length >= MAX_ATTACHMENTS) { rejection.value = { reason: "too-many", filename: file.name }; break; }
      if (file.size > MAX_BYTES) { rejection.value = { reason: "too-large", filename: file.name }; continue; }
      const localId = `local-${++localSeq}`;
      const kind: "image" | "file" = file.type.startsWith("image/") ? "image" : "file";
      const entry: PendingAttachment = {
        id: localId,
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        kind,
        status: "uploading",
      };
      pending.value.push(entry);
      try {
        const previewUrl = await downscaleImage(file);
        if (previewUrl) entry.previewUrl = previewUrl;
        const content = await fileToBase64(file);
        const res = await api.upload(targetInstanceId, { filename: file.name, content, mimeType: entry.mimeType });
        entry.filePath = res.path;
        entry.id = res.id;
        entry.size = res.size;
        entry.status = "ready";
      } catch {
        entry.status = "error";
      }
    }
    uploading.value = pending.value.some((p) => p.status === "uploading");
  }

  function removeAttachment(id: string): void {
    pending.value = pending.value.filter((p) => p.id !== id);
    rejection.value = null;
  }

  function clearAttachments(): void {
    pending.value = [];
    rejection.value = null;
  }

  return { insertRequest, requestInsert, pending, uploading, rejection, bindInstance, addFiles, removeAttachment, clearAttachments };
});
