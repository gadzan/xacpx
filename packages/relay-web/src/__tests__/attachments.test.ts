import { setActivePinia, createPinia } from "pinia";
import { beforeEach, expect, test, vi } from "vitest";

const rpc = vi.fn();
const upload = vi.fn();
vi.mock("../api/client", () => ({
  ApiError: class ApiError extends Error {},
  api: {
    rpc: (...a: unknown[]) => rpc(...a),
    upload: (...a: unknown[]) => upload(...a),
  },
}));

import { useComposerStore } from "../stores/composer";
import { useChatStore } from "../stores/chat";

beforeEach(() => {
  setActivePinia(createPinia());
  rpc.mockReset();
  upload.mockReset();
});

test("addFiles uploads each file and tracks ready state with daemon path", async () => {
  upload.mockResolvedValue({ id: "u-1", path: "/home/.xacpx/runtime/uploads/u-1/a.txt", filename: "a.txt", mimeType: "text/plain", size: 3 });
  const composer = useComposerStore();
  composer.bindInstance("i1");
  const file = new File([new Uint8Array([97, 98, 99])], "a.txt", { type: "text/plain" });
  await composer.addFiles([file]);
  expect(upload).toHaveBeenCalledTimes(1);
  expect(composer.pending).toHaveLength(1);
  expect(composer.pending[0]).toMatchObject({ filename: "a.txt", kind: "file", status: "ready", filePath: "/home/.xacpx/runtime/uploads/u-1/a.txt" });
});

test("addFiles rejects beyond the 5-attachment cap", async () => {
  upload.mockResolvedValue({ id: "u", path: "/p", filename: "f", mimeType: "text/plain", size: 1 });
  const composer = useComposerStore();
  composer.bindInstance("i1");
  const mk = (n: string) => new File([new Uint8Array([1])], n, { type: "text/plain" });
  await composer.addFiles([mk("1"), mk("2"), mk("3"), mk("4"), mk("5")]);
  await composer.addFiles([mk("6")]);
  expect(composer.pending).toHaveLength(5);
});

test("sets rejection.reason=too-many when 6 files are added", async () => {
  upload.mockResolvedValue({ id: "u", path: "/p", filename: "f", mimeType: "text/plain", size: 1 });
  const composer = useComposerStore();
  composer.bindInstance("i1");
  const mk = (n: string) => new File([new Uint8Array([1])], n, { type: "text/plain" });
  await composer.addFiles([mk("1"), mk("2"), mk("3"), mk("4"), mk("5"), mk("6")]);
  expect(composer.rejection?.reason).toBe("too-many");
  expect(composer.rejection?.filename).toBe("6");
});

test("sets rejection.reason=too-large when a file exceeds 10MB", async () => {
  const composer = useComposerStore();
  composer.bindInstance("i1");
  const file = new File([new Uint8Array(1)], "big.png", { type: "image/png" });
  Object.defineProperty(file, "size", { value: 11 * 1024 * 1024 });
  await composer.addFiles([file]);
  expect(composer.rejection?.reason).toBe("too-large");
  expect(composer.rejection?.filename).toBe("big.png");
});

test("chat.send forwards ready attachments as media refs", async () => {
  rpc.mockResolvedValue({ ok: true });
  const chat = useChatStore();
  chat.select("i1", "main");
  await chat.send("hi", [{ id: "u-1", filePath: "/p/a.png", fileName: "a.png", mimeType: "image/png", kind: "image", size: 3, previewUrl: "data:image/png;base64,AA" }]);
  const [, type, payload] = rpc.mock.calls[0];
  expect(type).toBe("control.prompt");
  expect((payload as { media?: unknown[] }).media).toHaveLength(1);
  expect(chat.messages.at(-1)).toMatchObject({ direction: "in", text: "hi" });
});
