import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n";
import FileViewer from "../components/FileViewer.vue";
import { useFilesStore } from "../stores/files";

let pinia: ReturnType<typeof createPinia>;
beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});
afterEach(() => { i18n.global.locale.value = "en"; });

describe("files browser i18n", () => {
  it("renders Chinese affordances in FileViewer when locale is zh-CN", async () => {
    i18n.global.locale.value = "zh-CN";
    const w = mount(FileViewer, { global: { plugins: [pinia] } });
    const files = useFilesStore();
    files.file = { workspace: "ws", path: "src/a.ts", content: "x", size: 1, truncated: false, binary: false };
    await w.vm.$nextTick();
    // Back-to-list affordance shows "文件" (Files); desktop Back shows "返回".
    expect(w.find('[data-test="fv-back-list"]').text()).toContain("文件");
    expect(w.find('[data-test="fv-back"]').text()).toContain("返回");
    expect(w.find('[data-test="fv-close"]').attributes("aria-label")).toBe("关闭文件");
  });

  it("localizes the binary-file notice in zh-CN", async () => {
    i18n.global.locale.value = "zh-CN";
    const w = mount(FileViewer, { global: { plugins: [pinia] } });
    const files = useFilesStore();
    files.file = { workspace: "ws", path: "bin.dat", content: "", size: 4, truncated: false, binary: true };
    await w.vm.$nextTick();
    expect(w.text()).toContain("不显示二进制文件");
  });
});
