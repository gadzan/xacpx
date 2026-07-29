// jsdom does not implement IndexedDB; the session tail cache depends on it.
// `fake-indexeddb/auto` installs indexedDB/IDBKeyRange/etc. as globals.
import "fake-indexeddb/auto";
import { config } from "@vue/test-utils";
import { i18n } from "../i18n";

// Install i18n globally for all component mounts. Default locale is "en", so
// existing assertions on English text keep passing unchanged.
config.global.plugins.push(i18n);

// jsdom 不实现 ResizeObserver / requestAnimationFrame。终端组件依赖二者做 fit 驱动；
// 装最小 stub 让相关测试确定性（不真正观察，仅提供可构造的 API）。
if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === "undefined") {
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame === "undefined") {
  (globalThis as { requestAnimationFrame: unknown }).requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0) as unknown as number;
  (globalThis as { cancelAnimationFrame: unknown }).cancelAnimationFrame = (id: number) => clearTimeout(id);
}

// jsdom's Range doesn't implement getClientRects/getBoundingClientRect. CodeMirror 6 (the
// FileViewer edit-mode editor) measures layout via Range on every mount/update, so without
// these stubs every CodeEditor-mounting test spams benign `getClientRects is not a function`
// stack traces to stderr. Stub minimal, spec-shaped return values — no real layout, just
// enough for CM6's measurement code not to throw.
Range.prototype.getClientRects = () =>
  ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () =>
  ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON() {} }) as DOMRect;
