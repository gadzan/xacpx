import { beforeEach, expect, test, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
const { upload } = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock("../api/client", () => ({ api: { upload } }));
vi.mock("../lib/image-downscale", () => ({ downscaleImage: async () => undefined, fileToBase64: async () => "YQ==" }));
import { useComposerStore } from "../stores/composer";

beforeEach(() => { setActivePinia(createPinia()); upload.mockReset(); });
const file = (name: string) => new File(["a"], name, { type: "text/plain" });

test("late completion and remaining batch files never enter another conversation", async () => {
  const store = useComposerStore();
  const { promise, resolve: finish } = Promise.withResolvers<unknown>();
  upload.mockImplementationOnce(() => promise);
  store.bindInstance("one", "direct-one");
  const adding = store.addFiles([file("a.txt"), file("b.txt")]);
  await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
  store.bindInstance("two", "group-two");
  finish({ id: "old", path: "/uploads/old", size: 1 });
  await adding;
  expect(store.pending).toEqual([]);
  expect(upload).toHaveBeenCalledTimes(1);
  store.bindInstance("one", "direct-one");
  expect(store.pending.map(({ filename, status }) => ({ filename, status }))).toEqual([
    { filename: "a.txt", status: "error" }, { filename: "b.txt", status: "error" },
  ]);
});

test("accepted snapshot consumes only submitted attachments and keeps newer uploads", async () => {
  upload.mockImplementation(async (_instance, input) => ({ id: input.filename, path: `/uploads/${input.filename}`, size: 1 }));
  const store = useComposerStore();
  store.bindInstance("one", "direct-one");
  await store.addFiles([file("a.txt")]);
  const sent = store.snapshot();
  await store.addFiles([file("b.txt")]);
  store.consume("direct-one", sent.ids);
  expect(store.snapshot().media.map((item) => item.fileName)).toEqual(["b.txt"]);
  expect(sent.media[0]).toMatchObject({ id: "a.txt", fileName: "a.txt", filePath: "/uploads/a.txt" });
});

test("failed upload retries its actual file while other scoped drafts remain intact", async () => {
  upload.mockRejectedValueOnce(new Error("offline"));
  const store = useComposerStore();
  store.bindInstance("one", "group-one");
  await store.addFiles([file("a.txt")]);
  const id = store.pending[0]!.id;
  expect(store.pending[0]!.status).toBe("error");
  upload.mockResolvedValueOnce({ id: "uploaded", path: "/uploads/a.txt", size: 1 });
  await store.retryAttachment(id);
  expect(store.snapshot().media).toEqual([{ id: "uploaded", filePath: "/uploads/a.txt", fileName: "a.txt", mimeType: "text/plain", kind: "file", size: 1 }]);
  store.bindInstance("two", "direct-two");
  expect(store.snapshot().media).toEqual([]);
  store.bindInstance("one", "group-one");
  expect(store.snapshot().media[0]?.id).toBe("uploaded");
});
