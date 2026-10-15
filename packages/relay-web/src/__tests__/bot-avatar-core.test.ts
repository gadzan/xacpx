import { describe, expect, it } from "vitest";
import { BOT_AVATAR_COLORS, BOT_AVATAR_EXPRESSIONS, BOT_AVATAR_SHAPES, type CharacterAvatarConfig } from "@ganglion/xacpx-relay-protocol";
import { AVATAR_EXPRESSIONS, EYE_CENTER_PULL, EYE_SCALE_H, EYE_SCALE_W, EYE_SPREAD } from "../lib/bot-avatar/catalog";
import { avatarTransition, sampleAvatar, sampleTransition, shouldCelebrate } from "../lib/bot-avatar/core";
import { eyePoses, radiusAtAngle } from "../lib/bot-avatar/geometry";
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
  it("keeps every fitted eye corner inside the 0.83 safety radius for all colours, shapes and expressions", () => {
    expect([BOT_AVATAR_COLORS.length, BOT_AVATAR_SHAPES.length, BOT_AVATAR_EXPRESSIONS.length]).toEqual([12, 8, 16]);
    let checked = 0;
    for (const color of BOT_AVATAR_COLORS) for (const shape of BOT_AVATAR_SHAPES) for (const expression of BOT_AVATAR_EXPRESSIONS) {
      const pose = sampleAvatar({ config: { ...config, color, shape, expression }, state: "idle", motion: false }, 0);
      for (const eye of pose.eyes) for (const x of [-eye.w / 2, eye.w / 2]) for (const y of [-eye.h / 2, eye.h / 2]) {
        const px = eye.x + eye.a * x + eye.c * y, py = eye.y + eye.b * x + eye.d * y;
        expect(Math.hypot(px, py)).toBeLessThanOrEqual(radiusAtAngle(pose.radii, Math.atan2(py, px)) * 34 * 0.83 + 1e-9);
        checked++;
      }
    }
    expect(checked).toBe(12 * 8 * 16 * 2 * 4);
  });
  it("keeps drifting, working and streaming eyes inside the silhouette so the clip never cuts them", () => {
    for (const shape of BOT_AVATAR_SHAPES) for (const expression of BOT_AVATAR_EXPRESSIONS) for (const state of ["idle", "working", "streaming"] as const) {
      for (let t = 0; t < 12; t += 0.37) {
        const pose = sampleAvatar({ config: { ...config, shape, expression }, state, motion: true }, t, { x: Math.sin(t), y: Math.cos(t) });
        for (const eye of pose.eyes) for (const x of [-eye.w / 2, eye.w / 2]) for (const y of [-eye.h / 2, eye.h / 2]) {
          const px = eye.x + eye.a * x + eye.c * y, py = eye.y + eye.b * x + eye.d * y;
          expect(Math.hypot(px, py)).toBeLessThan(radiusAtAngle(pose.radii, Math.atan2(py, px)) * 34 * Math.min(pose.sx, pose.sy));
        }
      }
    }
  });
  it("draws bigger eyes pulled toward the centre with the shared scale and placement constants", () => {
    const expression = AVATAR_EXPRESSIONS.neutre;
    const pose = sampleAvatar({ config: { ...config, shape: "cercle", expression: "neutre" }, state: "idle", motion: false }, 0);
    const raw = eyePoses(expression.gaze, expression.split);
    const fit = pose.eyes[0].w / (expression.eyes[0].w * 34 * EYE_SCALE_W);
    expect(fit).toBeGreaterThan(0);
    expect(fit).toBeLessThanOrEqual(1);
    expect(pose.eyes[0].h).toBeCloseTo(expression.eyes[0].h * 34 * fit * EYE_SCALE_H, 9);
    const mx = (raw[0].x + raw[1].x) / 2 * 34 * fit, my = (raw[0].y + raw[1].y) / 2 * 34 * fit;
    for (const i of [0, 1] as const) {
      expect(pose.eyes[i].x).toBeCloseTo(mx * EYE_CENTER_PULL + (raw[i].x * 34 * fit - mx) * EYE_SPREAD, 9);
      expect(pose.eyes[i].y).toBeCloseTo(my * EYE_CENTER_PULL + (raw[i].y * 34 * fit - my) * EYE_SPREAD, 9);
    }
    const mid = Math.hypot((pose.eyes[0].x + pose.eyes[1].x) / 2, (pose.eyes[0].y + pose.eyes[1].y) / 2);
    expect(mid).toBeCloseTo(Math.hypot(mx, my) * EYE_CENTER_PULL, 9);
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
