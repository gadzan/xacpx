import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import PromptInput from "../components/PromptInput.vue";
import { createDebouncedFlush } from "../lib/debounce-flush";

beforeEach(() => {
  setActivePinia(createPinia());
  sessionStorage.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createDebouncedFlush", () => {
  it("runs the callback once on the trailing edge", () => {
    const fn = vi.fn();
    const d = createDebouncedFlush(fn, 100);
    d.schedule();
    vi.advanceTimersByTime(50);
    d.schedule(); // restart the window
    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(d.pending).toBe(false);
  });

  it("flush runs a pending callback synchronously, and is a no-op when idle", () => {
    const fn = vi.fn();
    const d = createDebouncedFlush(fn, 100);
    d.flush(); // idle → nothing
    expect(fn).not.toHaveBeenCalled();
    d.schedule();
    d.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200); // the timer was consumed — no double fire
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("cancel drops a pending callback without running it", () => {
    const fn = vi.fn();
    const d = createDebouncedFlush(fn, 100);
    d.schedule();
    d.cancel();
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();
  });
});

const DRAFTS_KEY = "xacpx.composer-drafts.v1";
const readDrafts = (): Record<string, string> => JSON.parse(sessionStorage.getItem(DRAFTS_KEY) ?? "{}");

describe("PromptInput draft debounce", () => {
  it("does not write per keystroke; one trailing write lands the final text after 300ms", async () => {
    const w = mount(PromptInput, { props: { draftKey: "k1" } });
    const ta = w.find("textarea");
    await ta.setValue("h");
    await ta.setValue("he");
    await ta.setValue("hello");
    expect(readDrafts()["k1"]).toBeUndefined(); // nothing written yet
    vi.advanceTimersByTime(299);
    expect(readDrafts()["k1"]).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(readDrafts()["k1"]).toBe("hello");
  });

  it("pagehide flushes the pending draft synchronously (reload right after typing keeps it)", async () => {
    const w = mount(PromptInput, { props: { draftKey: "k1" } });
    await w.find("textarea").setValue("half-typed");
    expect(readDrafts()["k1"]).toBeUndefined();
    window.dispatchEvent(new Event("pagehide"));
    expect(readDrafts()["k1"]).toBe("half-typed"); // no timer advance needed
  });

  it("unmount flushes the pending draft", async () => {
    const w = mount(PromptInput, { props: { draftKey: "k1" } });
    await w.find("textarea").setValue("about to leave");
    w.unmount();
    expect(readDrafts()["k1"]).toBe("about to leave");
  });

  it("switching sessions stashes the old draft synchronously and never leaks text across keys", async () => {
    const w = mount(PromptInput, { props: { draftKey: "k1" } });
    await w.find("textarea").setValue("draft-a");
    await w.setProps({ draftKey: "k2" }); // switch before the debounce fires
    expect(readDrafts()["k1"]).toBe("draft-a"); // stashed immediately by the key watcher
    vi.advanceTimersByTime(300); // late timer must not write k1's text under k2
    expect(readDrafts()["k2"]).toBeUndefined();
    expect(readDrafts()["k1"]).toBe("draft-a");
  });

  it("pagehide after unmount does not write (listener removed)", async () => {
    const w = mount(PromptInput, { props: { draftKey: "k1" } });
    await w.find("textarea").setValue("gone");
    w.unmount(); // flushes "gone"
    sessionStorage.clear();
    window.dispatchEvent(new Event("pagehide"));
    expect(readDrafts()["k1"]).toBeUndefined();
  });
});
