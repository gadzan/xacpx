import { describe, expect, it } from "vitest";
import { createAvatarClock } from "../lib/bot-avatar/clock";

function harness() {
  let nextId = 0, hidden = false;
  const frames = new Map<number, (time: number) => void>();
  const listeners = new Set<() => void>();
  const cancelled: number[] = [];
  const clock = createAvatarClock({
    requestFrame: (callback) => { const id = ++nextId; frames.set(id, callback); return id; },
    cancelFrame: (id) => { cancelled.push(id); frames.delete(id); },
    hidden: () => hidden,
    onVisibility: (callback) => { listeners.add(callback); return () => { listeners.delete(callback); }; },
  });
  return {
    clock, frames, listeners, cancelled,
    tick(time: number) {
      const entry = frames.entries().next().value;
      if (!entry) throw new Error("No scheduled frame");
      frames.delete(entry[0]);
      entry[1](time);
    },
    visibility(value: boolean) { hidden = value; listeners.forEach((callback) => callback()); },
  };
}

describe("shared avatar frame clock", () => {
  it("uses one frame and visibility listener across avatars and stops at the final release", () => {
    const h = harness(), a: number[] = [], b: number[] = [];
    const releaseA = h.clock.subscribe((elapsed) => a.push(elapsed));
    const releaseB = h.clock.subscribe((elapsed) => b.push(elapsed));
    expect(h.frames.size).toBe(1);
    expect(h.listeners.size).toBe(1);
    h.tick(100);
    h.tick(116);
    expect(a).toEqual([0, 0.016]);
    expect(b).toEqual(a);
    releaseA(); releaseA();
    expect(h.frames.size).toBe(1);
    releaseB();
    expect(h.frames.size).toBe(0);
    expect(h.listeners.size).toBe(0);
    expect(h.cancelled).toHaveLength(1);
  });
  it("does not schedule on hidden pages and resumes without any hidden-time debt", () => {
    const h = harness(), samples: number[] = [];
    h.visibility(true);
    const release = h.clock.subscribe((elapsed) => samples.push(elapsed));
    expect(h.frames.size).toBe(0);
    h.visibility(false);
    h.tick(100);
    h.tick(120);
    h.visibility(true);
    expect(h.frames.size).toBe(0);
    h.visibility(false);
    h.tick(50000);
    h.tick(50016);
    expect(samples).toEqual([0, 0.02, 0, 0.016]);
    release();
    expect(h.listeners.size).toBe(0);
  });
  it("restarts its local time after all offscreen avatars release and bounds stalled frames", () => {
    const h = harness(), samples: number[] = [];
    const release = h.clock.subscribe((elapsed) => samples.push(elapsed));
    h.tick(100);
    h.tick(900);
    release();
    const releaseAgain = h.clock.subscribe((elapsed) => samples.push(elapsed));
    h.tick(90000);
    expect(samples).toEqual([0, 0.05, 0]);
    releaseAgain();
  });
  it("does not leave an orphan frame when a subscriber removes itself during delivery", () => {
    const h = harness();
    let release = () => {};
    release = h.clock.subscribe(() => release());
    h.tick(100);
    expect(h.frames.size).toBe(0);
    expect(h.listeners.size).toBe(0);
  });
});
