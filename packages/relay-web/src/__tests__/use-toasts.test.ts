import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { pushToast, dismissToast, useToasts } from "../lib/use-toasts";

beforeEach(() => { useToasts().value = []; vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("use-toasts", () => {
  it("pushes newest-first and auto-dismisses after the timeout", () => {
    pushToast("success", "files.toast.created", { name: "a" }, 1000);
    pushToast("error", "files.toast.failed", { msg: "boom" }, 1000);
    const items = useToasts().value;
    expect(items[0].key).toBe("files.toast.failed"); // newest first
    expect(items.length).toBe(2);
    vi.advanceTimersByTime(1000);
    expect(useToasts().value.length).toBe(0);
  });

  it("dismiss removes a single toast and clears its timer", () => {
    const id = pushToast("info", "files.toast.deleted", { name: "x" }, 5000);
    pushToast("info", "files.toast.deleted", { name: "y" }, 5000);
    dismissToast(id);
    expect(useToasts().value.map((t) => t.params?.name)).toEqual(["y"]);
  });

  it("caps the visible stack at 4 (drops the oldest)", () => {
    for (let i = 0; i < 6; i++) pushToast("info", "k", { i }, 5000);
    const items = useToasts().value;
    expect(items.length).toBe(4);
    expect(items[0].params?.i).toBe(5); // newest kept
    expect(items[3].params?.i).toBe(2); // oldest visible
  });
});
