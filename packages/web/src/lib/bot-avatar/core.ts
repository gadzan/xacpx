import type { CharacterAvatarConfig } from "@ganglion/xacpx-relay-protocol";
import type { BotAvatarState } from "../bot-avatar-state";
import { AVATAR_EXPRESSIONS, AVATAR_EYE_FIT, AVATAR_PROFILES, AVATAR_RGB, EYE_SCALE_H, EYE_SCALE_W, placeEye } from "./catalog";
import { clamp, eyePoses, lerp, loopNoise } from "./geometry";

export interface AvatarEye { x: number; y: number; a: number; b: number; c: number; d: number; w: number; h: number }
export interface AvatarPose {
  readonly radii: readonly number[];
  readonly color: readonly [number, number, number];
  readonly sx: number;
  readonly sy: number;
  readonly eyes: readonly [Readonly<AvatarEye>, Readonly<AvatarEye>];
  readonly ring: number;
}
export interface AvatarTarget { config: CharacterAvatarConfig; state: BotAvatarState; motion: boolean; celebrate?: boolean; blink?: AvatarBlinkRhythm }
export interface AvatarPointer { x: number; y: number }
export const AVATAR_TRANSITION_SECONDS = 0.24;
const ACTIVE_STATES: Partial<Record<BotAvatarState, true>> = { queued: true, working: true, streaming: true, waiting: true };
export function shouldCelebrate(previous: BotAvatarState, next: BotAvatarState, previousKey: string | undefined, nextKey: string | undefined): boolean {
  return !!nextKey && previousKey === nextKey && !!ACTIVE_STATES[previous] && next === "completed";
}
export function avatarHasLoop(state: BotAvatarState): boolean {
  return state === "idle" || state === "queued" || state === "working" || state === "streaming" || state === "completed";
}

const BLINK_PERIOD = 3600;
/** A blink keeps the lid moving for this long, in seconds. */
const BLINK_DURATION = 0.18;
/** Seconds between two blinks, drawn per blink: never faster than MIN, never slower than MAX. */
export const BLINK_INTERVAL_MIN = 1.9;
export const BLINK_INTERVAL_MAX = 4.6;

/** One avatar's own blink rhythm. Two avatars with different rhythms never blink in step. */
export interface AvatarBlinkRhythm { readonly seed: number; readonly first: number }

/** The rhythm used when a caller has no identity to seed one from; it also keeps
 *  `sampleAvatar` deterministic, so tests and frozen previews stay reproducible. */
export const DEFAULT_BLINK_RHYTHM: AvatarBlinkRhythm = Object.freeze({ seed: 0x5eed, first: 1.4 });

function blinkInterval(seed: number): number {
  return BLINK_INTERVAL_MIN + seed / 4294967296 * (BLINK_INTERVAL_MAX - BLINK_INTERVAL_MIN);
}

/** A fresh rhythm for one avatar: the first blink lands anywhere in the interval too, so
 *  avatars mounted together by the same list do not blink together a moment later. */
export function createBlinkRhythm(random: () => number = Math.random): AvatarBlinkRhythm {
  return Object.freeze({ seed: Math.floor(random() * 4294967296) >>> 0, first: BLINK_INTERVAL_MIN + random() * (BLINK_INTERVAL_MAX - BLINK_INTERVAL_MIN) });
}

const RHYTHMS_BY_KEY = new Map<string, AvatarBlinkRhythm>();
/** The rhythm of one named Bot: every place that Bot appears blinks alike, so a sidebar
 *  row and its conversation header stay one character, and the rhythm survives remounts
 *  instead of being redrawn. Distinct keys get distinct rhythms, which is what stops a
 *  list of Bots from blinking in step. */
export function blinkRhythmFor(key: string): AvatarBlinkRhythm {
  const known = RHYTHMS_BY_KEY.get(key);
  if (known) return known;
  let seed = 2166136261;
  for (let i = 0; i < key.length; i += 1) seed = Math.imul(seed ^ key.charCodeAt(i), 16777619) >>> 0;
  const rhythm = Object.freeze({ seed, first: blinkInterval(seed) });
  RHYTHMS_BY_KEY.set(key, rhythm);
  return rhythm;
}

const BLINK_STARTS = new WeakMap<AvatarBlinkRhythm, readonly number[]>();
function blinkStarts(rhythm: AvatarBlinkRhythm): readonly number[] {
  const cached = BLINK_STARTS.get(rhythm);
  if (cached) return cached;
  const starts: number[] = [];
  let seed = rhythm.seed, t = rhythm.first;
  while (t + BLINK_DURATION < BLINK_PERIOD) {
    starts.push(t);
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    t += blinkInterval(seed);
  }
  return BLINK_STARTS.set(rhythm, Object.freeze(starts)).get(rhythm)!;
}
function blink(t: number, rhythm: AvatarBlinkRhythm): number {
  const starts = blinkStarts(rhythm);
  const phase = t % BLINK_PERIOD;
  let lo = 0, hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid]! <= phase) lo = mid + 1;
    else hi = mid;
  }
  const k = (phase - (starts[lo - 1] ?? -1)) / BLINK_DURATION;
  return k < 0 || k > 1 ? 1 : k < 0.45 ? 1 - k / 0.45 : (k - 0.45) / 0.55;
}

export function sampleAvatar(target: AvatarTarget, t: number, pointer?: AvatarPointer): AvatarPose {
  const { config, state } = target;
  const animated = target.motion && avatarHasLoop(state);
  const working = state === "working", streaming = state === "streaming";
  const expression = AVATAR_EXPRESSIONS[working ? "attentif" : config.expression];
  const gaze = expression.gaze;
  const time = animated ? Math.max(0, t) : 0;
  const wander = animated && !working ? 1 : 0;
  const yaw = gaze.yaw + loopNoise(time, 11.3, 0.4) * 5.5 * wander + (animated ? clamp(pointer?.x ?? 0, -1, 1) * 2 : 0);
  const pitch = gaze.pitch + loopNoise(time, 9.1, 1.3) * 4.2 * wander + (animated ? clamp(pointer?.y ?? 0, -1, 1) * 1.5 : 0);
  const projections = eyePoses({ yaw, pitch, roll: gaze.roll }, expression.split);
  const fit = AVATAR_EYE_FIT[config.shape];
  const pulse = animated && (working || streaming) ? Math.sin(time * (streaming ? 9 : 3)) : 0;
  const lid = animated ? blink(time, target.blink ?? DEFAULT_BLINK_RHYTHM) : 1;
  const wink = animated && state === "completed" && target.celebrate && time < 0.8
    ? Math.sin(clamp((time - 0.15) / 0.4) * Math.PI) : 0;
  // Gaze drift, pointer follow and blink all act on the raw projection; the shared
  // PULL / SPREAD placement is applied afterwards so it never changes their motion.
  const mx = (projections[0].x + projections[1].x) / 2 * 34 * fit, my = (projections[0].y + projections[1].y) / 2 * 34 * fit;
  const eyes = projections.map((pose, i): AvatarEye => {
    const cfg = expression.eyes[i]!;
    const tilt = cfg.tilt * Math.PI / 180, c = Math.cos(tilt), s = Math.sin(tilt);
    const open = 0.06 + 0.94 * cfg.open * lid * (i === 1 ? 1 - wink : 1);
    return {
      x: placeEye(pose.x * 34 * fit, mx), y: placeEye(pose.y * 34 * fit, my),
      a: pose.a * c + pose.c * s, b: (pose.b * c + pose.d * s) * open,
      c: pose.c * c - pose.a * s, d: (pose.d * c - pose.b * s) * open,
      w: cfg.w * 34 * fit * EYE_SCALE_W * (1 + (streaming ? pulse * 0.07 : 0)), h: cfg.h * 34 * fit * EYE_SCALE_H,
    };
  }) as [AvatarEye, AvatarEye];
  return {
    radii: AVATAR_PROFILES[config.shape], color: AVATAR_RGB[config.color],
    sx: 1 + pulse * 0.014, sy: 1 - pulse * 0.018, eyes,
    ring: state === "queued" ? animated ? 0.45 + 0.25 * Math.sin(time * 2) : 0.65 : 0,
  };
}

export function blendAvatar(from: AvatarPose, to: AvatarPose, progress: number): AvatarPose {
  const t = clamp(progress);
  if (t === 0) return from;
  if (t === 1) return to;
  const blendEye = (a: Readonly<AvatarEye>, b: Readonly<AvatarEye>): AvatarEye => ({
    x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), a: lerp(a.a, b.a, t), b: lerp(a.b, b.b, t),
    c: lerp(a.c, b.c, t), d: lerp(a.d, b.d, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t),
  });
  return {
    radii: from.radii.map((r, i) => lerp(r, to.radii[i]!, t)),
    color: [lerp(from.color[0], to.color[0], t), lerp(from.color[1], to.color[1], t), lerp(from.color[2], to.color[2], t)],
    sx: lerp(from.sx, to.sx, t), sy: lerp(from.sy, to.sy, t),
    eyes: [blendEye(from.eyes[0], to.eyes[0]), blendEye(from.eyes[1], to.eyes[1])], ring: lerp(from.ring, to.ring, t),
  };
}

export interface AvatarTransition { readonly from: AvatarPose; readonly target: AvatarTarget; readonly start: number }
export function avatarTransition(from: AvatarPose, target: AvatarTarget, start: number): AvatarTransition {
  const frozen: AvatarPose = Object.freeze({ ...from, radii: Object.freeze([...from.radii]), color: Object.freeze([...from.color]) as readonly [number, number, number], eyes: Object.freeze(from.eyes.map((eye) => Object.freeze({ ...eye }))) as AvatarPose["eyes"] });
  return Object.freeze({ from: frozen, target: Object.freeze({ ...target, config: Object.freeze({ ...target.config }) }), start });
}
export function sampleTransition(transition: AvatarTransition, t: number, pointer?: AvatarPointer): AvatarPose {
  const elapsed = Math.max(0, t - transition.start);
  const k = clamp(elapsed / AVATAR_TRANSITION_SECONDS);
  return blendAvatar(transition.from, sampleAvatar(transition.target, elapsed, pointer), 1 - (1 - k) ** 3);
}
