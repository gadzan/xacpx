import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { h, nextTick } from "vue";
import type { CharacterAvatarConfig } from "@ganglion/xacpx-relay-protocol";
import { i18n } from "../i18n";
import BotAvatar from "../components/BotAvatar.vue";
import TranscriptRow from "../components/TranscriptRow.vue";
import botAvatarSource from "../components/BotAvatar.vue?raw";

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
  it("draws a flat body and white, unstroked eyes; creme gets ink eyes", () => {
    for (const color of ["violet", "gris", "encre", "bleu"] as const) {
      const wrapper = avatar({ avatar: { ...config, color }, static: true });
      const body = wrapper.find(".bot-avatar-body");
      for (const attr of ["stroke", "stroke-opacity", "stroke-width"]) expect(body.attributes(attr)).toBeUndefined();
      for (const eye of wrapper.findAll("rect")) {
        expect(eye.attributes("fill")).toBe("#FFFFFF");
        expect(eye.attributes("stroke")).toBeUndefined();
        expect(eye.attributes("stroke-width")).toBeUndefined();
      }
    }
    const creme = avatar({ avatar: { ...config, color: "creme" }, static: true });
    expect(creme.findAll("rect").map((eye) => eye.attributes("fill"))).toEqual(["#0A0A0C", "#0A0A0C"]);
  });
  it("marks only creme and encre bodies for the theme-specific low-contrast hairline", () => {
    expect(avatar({ avatar: { ...config, color: "creme" }, static: true }).find(".bot-avatar-body").attributes("data-hairline")).toBe("creme");
    expect(avatar({ avatar: { ...config, color: "encre" }, static: true }).find(".bot-avatar-body").attributes("data-hairline")).toBe("encre");
    for (const color of ["violet", "gris", "bleu", "ambre"] as const) {
      expect(avatar({ avatar: { ...config, color }, static: true }).find(".bot-avatar-body").attributes("data-hairline")).toBeUndefined();
    }
  });
  it("keeps the low-contrast hairline 1 CSS px at every size: non-scaling, width 1, opacity 0.16", () => {
    const rules = [...botAvatarSource.matchAll(/:global\((.*?\[data-hairline="(creme|encre)"\])\)\s*\{([^}]*)\}/g)];
    expect(rules.map((rule) => rule[2])).toEqual(["creme", "encre"]);
    const [creme, encre] = rules;
    expect(creme![1]).toMatch(/^html:not\(\.dark\) /);
    expect(encre![1]).toMatch(/^html\.dark /);
    expect(creme![3]).toContain("stroke: rgb(var(--c-fg));");
    expect(encre![3]).toContain("stroke: #FFFFFF;");
    for (const rule of rules) {
      expect(rule[3]).toContain("vector-effect: non-scaling-stroke;");
      expect(rule[3]).toContain("stroke-width: 1;");
      expect(rule[3]).toContain("stroke-opacity: 0.16;");
    }
  });
  it("drops the round surface backing behind a slotted BotAvatar but keeps it for the driver-icon fallback", () => {
    const frame = (wrapper: VueWrapper) => wrapper.find('[data-avatar-key="row"] > span');
    const slotted = mount(TranscriptRow, {
      props: { driver: "codex", speaker: "Bot" },
      slots: { avatar: () => h(BotAvatar, { avatar: { ...config, color: "encre" }, size: 32, static: true }) },
      global: { plugins: [i18n] },
    });
    wrappers.push(slotted);
    expect(frame(slotted).find('[data-test="bot-avatar"]').exists()).toBe(true);
    for (const cls of ["bg-surface", "rounded-full", "overflow-hidden"]) expect(frame(slotted).classes()).not.toContain(cls);
    expect(frame(slotted).classes()).toEqual(expect.arrayContaining(["h-8", "w-8"]));
    for (const driver of ["codex", undefined]) {
      const fallback = mount(TranscriptRow, { props: { driver, speaker: "Agent" }, global: { plugins: [i18n] } });
      wrappers.push(fallback);
      expect(frame(fallback).find('[data-test="bot-avatar"]').exists()).toBe(false);
      expect(frame(fallback).classes()).toEqual(expect.arrayContaining(["h-8", "w-8", "rounded-full", "bg-surface", "overflow-hidden"]));
      expect(frame(fallback).classes()).not.toContain("border");
    }
  });
  it("keeps the queued status ring", () => {
    const wrapper = avatar({ state: "queued", static: true });
    expect(wrapper.find("circle").exists()).toBe(true);
    expect(wrapper.find("circle").attributes("stroke")).toBe("rgb(var(--c-accent))");
  });
  it("shows no badge for a cancelled bot and leaves every other state's badge unchanged", () => {
    const badges: Record<string, string | undefined> = {
      idle: undefined, queued: undefined, working: undefined, streaming: undefined, completed: undefined,
      waiting: "!", failed: "!", cancelled: undefined, indeterminate: "?", offline: "−", retired: "×",
    };
    for (const [state, badge] of Object.entries(badges)) {
      const wrapper = avatar({ state, static: true });
      const indicator = wrapper.find(".bot-avatar-indicator");
      expect(indicator.exists()).toBe(badge !== undefined);
      if (badge !== undefined) expect(indicator.text()).toBe(badge);
    }
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
  it("keeps ZWJ emoji and skin tone modifiers whole at the two-grapheme limit", () => {
    const wrapper = avatar({ avatar: { version: 1, kind: "text", value: "👩‍💻👍🏽X" } });
    expect(wrapper.find(".bot-avatar-text").text()).toBe("👩‍💻👍🏽");
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

describe("BotAvatar outline", () => {
  const mountWith = (props: Record<string, unknown>) => mount(BotAvatar, { props: { static: true, size: 21, ...props }, global: { plugins: [i18n] } });

  it("renders exactly as before when no caller asks for an outline", () => {
    for (const props of [{ avatar: { ...config, motion: "off" } }, { driver: "codex" }, { avatar: { version: 1, kind: "text", value: "AB" } }]) {
      const wrapper = mountWith(props);
      expect(wrapper.find(".bot-avatar-outline").exists()).toBe(false);
      expect(wrapper.html()).not.toContain("drop-shadow");
      expect(wrapper.html()).not.toContain("--avatar-ring");
      wrapper.unmount();
    }
  });

  it("traces a character's own body path under the body, in CSS px", () => {
    const wrapper = mountWith({ avatar: { ...config, motion: "off" }, outline: 1.5 });
    const outline = wrapper.find(".bot-avatar-outline");
    const body = wrapper.find(".bot-avatar-body");
    expect(outline.attributes("d")).toBe(body.attributes("d"));
    expect(outline.attributes("vector-effect")).toBe("non-scaling-stroke");
    expect(outline.attributes("style")).toContain("stroke: var(--avatar-ring)");
    expect(outline.attributes("style")).toContain("stroke-width: 3px");
    // Under the body, so the body covers the inner half of the stroke; the hairline stays on the body.
    const paths = wrapper.findAll("path").filter((p) => p.classes().some((c) => c.startsWith("bot-avatar-")));
    expect(paths.map((p) => p.classes()[0])).toEqual(["bot-avatar-outline", "bot-avatar-body"]);
    expect(wrapper.html()).not.toContain("drop-shadow");
    wrapper.unmount();
  });

  it("follows the opaque pixels of the kinds that have no path", () => {
    for (const props of [{ driver: "codex" }, { avatar: { version: 1, kind: "text", value: "AB" } }]) {
      const wrapper = mountWith({ ...props, outline: 1 });
      expect(wrapper.find(".bot-avatar-outline").exists()).toBe(false);
      expect(wrapper.html()).toContain("drop-shadow(1px 0 0 var(--avatar-ring)) drop-shadow(-1px 0 0 var(--avatar-ring)) drop-shadow(0 1px 0 var(--avatar-ring)) drop-shadow(0 -1px 0 var(--avatar-ring))");
      wrapper.unmount();
    }
  });
});
