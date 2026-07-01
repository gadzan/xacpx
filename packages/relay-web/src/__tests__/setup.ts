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
