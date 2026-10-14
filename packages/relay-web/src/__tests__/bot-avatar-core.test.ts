import { describe, expect, it } from "vitest";
import { BOT_AVATAR_EXPRESSIONS, BOT_AVATAR_SHAPES, type CharacterAvatarConfig } from "@ganglion/xacpx-relay-protocol";
import { avatarTransition, sampleAvatar, sampleTransition, shouldCelebrate } from "../lib/bot-avatar/core";
import { radiusAtAngle } from "../lib/bot-avatar/geometry";
import type { BotAvatarState } from "../lib/bot-avatar-state";

const config: CharacterAvatarConfig = { version: 1, kind: "character", shape: "nuage", color: "violet", expression: "curieux", motion: "auto" };
const states: BotAvatarState[] = ["idle", "queued", "working", "streaming", "waiting", "completed", "failed", "cancelled", "indeterminate", "offline", "retired"];

describe("avatar geometry and deterministic sampling", () => {
  it("keeps all fitted default expressions inside their chosen silhouette", () => {
    for (const shape of BOT_AVATAR_SHAPES) for (const expression of BOT_AVATAR_EXPRESSIONS) {
      const pose = sampleAvatar({ config: { ...config, shape, expression }, state: "idle", motion: false }, 0);
      for (const eye of pose.eyes) for (const x of [-eye.w / 2, eye.w / 2]) for (const y of [-eye.h / 2, eye.h / 2]) {
        const px = eye.x + eye.a * x + eye.c * y, py = eye.y + eye.b * x + eye.d * y;
        expect(Math.hypot(px, py)).toBeLessThan(radiusAtAngle(pose.radii, Math.atan2(py, px)) * 34);
      }
    }
  });
  it("freezes preview samples and static states independent of time and pointer", () => {
    for (const state of states) {
      const target = { config, state, motion: false, celebrate: true };
      expect(sampleAvatar(target, 800, { x: 1, y: -1 })).toEqual(sampleAvatar(target, 0));
    }
    for (const state of ["waiting", "failed", "cancelled", "indeterminate", "offline", "retired"] as const) {
      expect(sampleAvatar({ config, state, motion: true }, 50)).toEqual(sampleAvatar({ config, state, motion: true }, 0));
    }
  });
  it("continues blinking after an hour and a day of visible idle time", () => {
    const target = { config, state: "idle" as const, motion: true };
    for (const start of [3600, 86400]) {
      const open = sampleAvatar(target, start + 1.2).eyes[0];
      const closed = sampleAvatar(target, start + 1.48).eyes[0];
      expect(Math.hypot(closed.b, closed.d)).toBeLessThan(Math.hypot(open.b, open.d) * 0.25);
    }
  });
  it("makes working, streaming, queued and observed completion distinct controlled poses", () => {
    const idle = sampleAvatar({ config, state: "idle", motion: true }, 0.35);
    for (const state of ["working", "streaming", "queued"] as const) {
      expect(sampleAvatar({ config, state, motion: true }, 0.35)).not.toEqual(idle);
    }
    const completed = { config, state: "completed" as const, motion: true };
    expect(sampleAvatar({ ...completed, celebrate: true }, 0.35)).not.toEqual(sampleAvatar(completed, 0.35));
    expect(sampleAvatar({ ...completed, celebrate: true }, 2)).toEqual(sampleAvatar(completed, 2));
  });
});

describe("avatar interrupted transitions", () => {
  it("starts every rapid update at the displayed mixed pose, not an old source or target", () => {
    const initial = sampleAvatar({ config, state: "idle", motion: true }, 1.5);
    const first = avatarTransition(initial, { config: { ...config, shape: "triangle", expression: "effraye" }, state: "working", motion: true }, 1.5);
    const displayed = sampleTransition(first, 1.59, { x: 0.3, y: -0.2 });
    const secondConfig = { ...config, shape: "capsule" as const, expression: "hilare" as const };
    const second = avatarTransition(displayed, { config: secondConfig, state: "streaming", motion: true }, 1.59);
    expect(sampleTransition(second, 1.59)).toEqual(displayed);
    secondConfig.color = "rouge";
    expect(sampleTransition(second, 3).color).toEqual([139, 92, 246]);
    const after = sampleTransition(second, 1.590001);
    expect(Math.abs(after.eyes[0].x - displayed.eyes[0].x)).toBeLessThan(0.001);
    expect(Math.abs(after.radii[0]! - displayed.radii[0]!)).toBeLessThan(0.001);
  });
  it("celebrates only observed active-to-completed transitions within a nonempty activity identity", () => {
    for (const previous of ["queued", "working", "streaming", "waiting"] as const) expect(shouldCelebrate(previous, "completed", "run-a", "run-a")).toBe(true);
    for (const previous of ["idle", "offline", "completed", "failed", "cancelled", "indeterminate", "retired"] as const) expect(shouldCelebrate(previous, "completed", "run-a", "run-a")).toBe(false);
    expect(shouldCelebrate("working", "completed", "run-a", "run-b")).toBe(false);
    expect(shouldCelebrate("working", "completed", undefined, undefined)).toBe(false);
  });
});
