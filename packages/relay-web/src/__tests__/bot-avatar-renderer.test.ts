import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import type { CharacterAvatarConfig } from "@ganglion/xacpx-relay-protocol";
import { i18n } from "../i18n";
import BotAvatar from "../components/BotAvatar.vue";

const config: CharacterAvatarConfig = { version: 1, kind: "character", shape: "nuage", color: "violet", expression: "curieux", motion: "auto" };
let wrappers: VueWrapper[];
let frames: Map<number, FrameRequestCallback>;
let observers: TestObserver[];
let reduced: boolean;
let mediaListeners: Set<() => void>;
class TestObserver {
  target?: Element;
  disconnected = false;
  constructor(private callback: IntersectionObserverCallback) { observers.push(this); }
  observe(target: Element) { this.target = target; }
  disconnect() { this.disconnected = true; }
  show(visible: boolean) {
    this.callback([{ target: this.target, isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}
function avatar(props: Record<string, unknown> = {}) {
  const wrapper = mount(BotAvatar, { props: { avatar: config, ...props }, global: { plugins: [i18n] } });
  wrappers.push(wrapper);
  return wrapper;
}
function tick(time: number) {
  const entries = [...frames];
  frames.clear();
  entries.forEach(([, callback]) => callback(time));
}
function changeMotion(value: boolean) {
  reduced = value;
  mediaListeners.forEach((callback) => callback());
}
function eyes(wrapper: VueWrapper) {
  return wrapper.findAll("rect").map((eye) => eye.attributes("transform"));
}

beforeEach(() => {
  wrappers = []; frames = new Map(); observers = []; reduced = false; mediaListeners = new Set();
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frames.set(++id, callback); return id; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((frame: number) => { frames.delete(frame); }));
  vi.stubGlobal("IntersectionObserver", TestObserver);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ get matches() { return reduced; }, addEventListener: (_type: string, callback: () => void) => mediaListeners.add(callback), removeEventListener: (_type: string, callback: () => void) => mediaListeners.delete(callback) })));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => {
  wrappers.forEach((wrapper) => wrapper.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("BotAvatar resources and safe rendering", () => {
  it("never acquires browser animation resources for immutable static thumbnails", async () => {
    const wrapper = avatar({ static: true, follow: true });
    const before = wrapper.html();
    tick(90000); await nextTick();
    expect(wrapper.html()).toBe(before);
    expect(frames.size).toBe(0);
    expect(observers).toHaveLength(0);
    expect(mediaListeners.size).toBe(0);
  });
  it("subscribes only visible avatars, shares a frame and releases everything on unmount", async () => {
    const first = avatar({ follow: true }), second = avatar();
    expect(frames.size).toBe(0);
    observers[0]!.show(true); observers[1]!.show(true);
    expect(frames.size).toBe(1);
    tick(100); tick(116); await nextTick();
    observers[0]!.show(false);
    expect(frames.size).toBe(1);
    observers[1]!.show(false);
    expect(frames.size).toBe(0);
    observers[0]!.show(true);
    tick(90000);
    expect(frames.size).toBe(1);
    first.unmount(); second.unmount(); wrappers = [];
    expect(frames.size).toBe(0);
    expect(mediaListeners.size).toBe(0);
    expect(observers.every((observer) => observer.disconnected)).toBe(true);
  });
  it("reactively stops reduced motion, motion-off and disabled idle but preserves disabled running work", async () => {
    const wrapper = avatar({ follow: true });
    observers[0]!.show(true);
    expect(frames.size).toBe(1);
    changeMotion(true);
    expect(frames.size).toBe(0);
    await nextTick();
    const frozen = eyes(wrapper);
    tick(1000); await nextTick();
    expect(eyes(wrapper)).toEqual(frozen);
    changeMotion(false);
    expect(frames.size).toBe(1);
    await wrapper.setProps({ disabled: true });
    expect(frames.size).toBe(0);
    expect(mediaListeners.size).toBe(0);
    expect(observers[0]!.disconnected).toBe(true);
    await wrapper.setProps({ state: "working" });
    observers.at(-1)!.show(true);
    expect(frames.size).toBe(1);
    await wrapper.setProps({ avatar: { ...config, motion: "off" } });
    expect(frames.size).toBe(0);
    expect(mediaListeners.size).toBe(0);
    await wrapper.setProps({ avatar: config, retired: true });
    expect(frames.size).toBe(0);
    expect(wrapper.attributes("data-state")).toBe("retired");
  });
  it("keeps disabled queued and terminal bots static after their real running work ends", async () => {
    const wrapper = avatar({ disabled: true, state: "working", activityKey: "disabled-run", follow: true });
    observers[0]!.show(true);
    tick(100); tick(116);
    expect(frames.size).toBe(1);
    await wrapper.setProps({ state: "streaming" });
    expect(frames.size).toBe(1);
    await wrapper.setProps({ state: "completed" });
    expect(frames.size).toBe(0);
    expect(wrapper.attributes("data-state")).toBe("completed");
    const completedEyes = eyes(wrapper);
    tick(90000); await nextTick();
    expect(eyes(wrapper)).toEqual(completedEyes);
    for (const state of ["queued", "idle", "failed", "cancelled", "indeterminate"] as const) {
      await wrapper.setProps({ state });
      expect(frames.size).toBe(0);
      expect(wrapper.attributes("data-state")).toBe(state);
    }
  });
  it("does not start a clock for loaded static task states and settles active-to-waiting transitions", async () => {
    for (const state of ["waiting", "failed", "cancelled", "indeterminate", "offline", "retired"]) {
      const wrapper = avatar({ state });
      observers.at(-1)?.show(true);
      expect(frames.size).toBe(0);
      wrapper.unmount();
    }
    wrappers = [];
    const wrapper = avatar({ state: "working" });
    observers.at(-1)!.show(true);
    tick(100); tick(116);
    await wrapper.setProps({ state: "waiting" });
    for (let i = 1; i <= 6; i++) tick(116 + i * 50);
    await nextTick();
    expect(frames.size).toBe(0);
    expect(wrapper.attributes("data-state")).toBe("waiting");
    expect(wrapper.find(".bot-avatar-indicator").text()).toBe("!");
  });
  it("pauses hidden pages without changing the sampled pose or chasing elapsed wall time", async () => {
    const wrapper = avatar();
    observers[0]!.show(true);
    tick(100); tick(116); await nextTick();
    const before = eyes(wrapper);
    vi.mocked(Object.getOwnPropertyDescriptor(document, "visibilityState")!.get!).mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(frames.size).toBe(0);
    vi.mocked(Object.getOwnPropertyDescriptor(document, "visibilityState")!.get!).mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    tick(90000); await nextTick();
    expect(eyes(wrapper)).toEqual(before);
  });
  it("renders legacy text as text, never as markup or a network image", () => {
    const text = "<img src=https://example.invalid/avatar onerror=alert(1)>";
    const wrapper = avatar({ avatar: { version: 1, kind: "text", value: text } });
    expect(wrapper.find("img").exists()).toBe(false);
    expect(wrapper.attributes("title")).toBe(text);
    expect(wrapper.text()).toBe("<i");
    expect(frames.size).toBe(0);
    expect(observers).toHaveLength(0);
  });
  it("uses distinct deterministic instance clips without per-frame live announcements", () => {
    const parent = mount({
      components: { BotAvatar },
      setup: () => ({ config }),
      template: '<div><BotAvatar :avatar="config" static /><BotAvatar :avatar="config" static /></div>',
    }, { global: { plugins: [i18n] } });
    wrappers.push(parent);
    const clips = parent.findAll("clipPath");
    expect(clips[0]!.attributes("id")).not.toBe(clips[1]!.attributes("id"));
    expect(parent.find("[aria-live]").exists()).toBe(false);
  });
  it("winks only for a live completion, not a recovered terminal response", async () => {
    const live = avatar({ state: "working", activityKey: "run-a" });
    const recovered = avatar({ state: "working", activityKey: "run-a" });
    observers[0]!.show(true); observers[1]!.show(true);
    tick(100); tick(116);
    await live.setProps({ state: "completed", observedCompletion: true });
    await recovered.setProps({ state: "completed" });
    for (let i = 1; i <= 7; i++) tick(116 + i * 50);
    await nextTick();
    expect(eyes(live)).not.toEqual(eyes(recovered));
    for (let i = 8; i <= 22; i++) tick(116 + i * 50);
    await nextTick();
    expect(eyes(live)).toEqual(eyes(recovered));
  });
  it("keeps loaded completed static in meaning while explicit editor completion previews wink once", async () => {
    const loaded = avatar({ state: "completed", activityKey: "loaded" });
    const preview = avatar({ state: "completed", activityKey: "preview-1", preview: true });
    observers[0]!.show(true); observers[1]!.show(true);
    tick(100);
    for (let i = 1; i <= 7; i++) tick(100 + i * 50);
    await nextTick();
    expect(eyes(loaded)).not.toEqual(eyes(preview));
    for (let i = 8; i <= 22; i++) tick(100 + i * 50);
    await nextTick();
    expect(eyes(loaded)).toEqual(eyes(preview));
  });
});
