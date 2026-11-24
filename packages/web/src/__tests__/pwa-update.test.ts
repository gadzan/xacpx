import { describe, it, expect, vi } from "vitest";
import { schedulePwaUpdateChecks } from "../lib/pwa-update";

// A tiny fake document we can drive visibility on, plus a controllable interval.
function fakeDoc(visibility: DocumentVisibilityState = "visible") {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    visibilityState: visibility,
    addEventListener: (t: string, fn: () => void) => {
      (listeners[t] ??= []).push(fn);
    },
    removeEventListener: (t: string, fn: () => void) => {
      listeners[t] = (listeners[t] ?? []).filter((f) => f !== fn);
    },
    fire: (t: string) => (listeners[t] ?? []).forEach((f) => f()),
    count: (t: string) => (listeners[t] ?? []).length,
  };
}

describe("schedulePwaUpdateChecks", () => {
  it("no-ops (and returns a callable teardown) when there is no registration", () => {
    const teardown = schedulePwaUpdateChecks(undefined);
    expect(typeof teardown).toBe("function");
    expect(() => teardown()).not.toThrow();
  });

  it("polls registration.update() on the interval", () => {
    const update = vi.fn();
    let tick: () => void = () => {};
    schedulePwaUpdateChecks(
      { update },
      {
        intervalMs: 1000,
        doc: fakeDoc(),
        setIntervalFn: (fn) => {
          tick = fn;
          return 1 as unknown as ReturnType<typeof setInterval>;
        },
      },
    );
    expect(update).not.toHaveBeenCalled();
    tick();
    tick();
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("checks for an update when the tab becomes visible again", () => {
    const update = vi.fn();
    const doc = fakeDoc("visible");
    schedulePwaUpdateChecks(
      { update },
      { intervalMs: 1000, doc, setIntervalFn: () => 1 as unknown as ReturnType<typeof setInterval> },
    );
    doc.fire("visibilitychange");
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("does not check while the tab is hidden", () => {
    const update = vi.fn();
    const doc = fakeDoc("hidden");
    schedulePwaUpdateChecks(
      { update },
      { intervalMs: 1000, doc, setIntervalFn: () => 1 as unknown as ReturnType<typeof setInterval> },
    );
    doc.fire("visibilitychange");
    expect(update).not.toHaveBeenCalled();
  });

  it("swallows a rejected update() so a failed poll never throws", () => {
    let tick: () => void = () => {};
    schedulePwaUpdateChecks(
      { update: () => Promise.reject(new Error("offline")) },
      {
        intervalMs: 1000,
        doc: fakeDoc(),
        setIntervalFn: (fn) => {
          tick = fn;
          return 1 as unknown as ReturnType<typeof setInterval>;
        },
      },
    );
    expect(() => tick()).not.toThrow();
  });

  it("teardown clears the timer and removes the visibility listener", () => {
    const cleared = vi.fn();
    const doc = fakeDoc();
    const teardown = schedulePwaUpdateChecks(
      { update: vi.fn() },
      {
        intervalMs: 1000,
        doc,
        setIntervalFn: () => 42 as unknown as ReturnType<typeof setInterval>,
        clearIntervalFn: cleared,
      },
    );
    expect(doc.count("visibilitychange")).toBe(1);
    teardown();
    expect(cleared).toHaveBeenCalledWith(42);
    expect(doc.count("visibilitychange")).toBe(0);
  });
});
