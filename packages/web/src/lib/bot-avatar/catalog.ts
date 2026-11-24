// Shape recipes, palette and facial poses adapted from bloub; see LICENSE.bloub.
import { BOT_AVATAR_COLORS, BOT_AVATAR_EXPRESSIONS, BOT_AVATAR_SHAPES, type CharacterAvatarConfig, type ColorId, type ExpressionId, type ShapeId } from "@ganglion/xacpx-relay-protocol";
import { ANGLES, eyePoses, hullOfCircles, profileFromPolygon, radiusAtAngle, regularPolygonProfile, unionOfCirclesProfile, type Gaze } from "./geometry";

export const AVATAR_PALETTE: Readonly<Record<ColorId, string>> = Object.freeze({
  encre: "#0a0a0c", brun: "#8b5e3c", rouge: "#e8483f", orange: "#f08a24", ambre: "#f0b429", vert: "#3ecf8e",
  turquoise: "#2fbfa0", bleu: "#3b93f0", violet: "#8b5cf6", rose: "#e152b0", gris: "#a3a3a3", creme: "#f1efe9",
});
export const AVATAR_RGB: Readonly<Record<ColorId, readonly [number, number, number]>> = Object.freeze(Object.fromEntries(Object.entries(AVATAR_PALETTE).map(([id, hex]) => {
  const value = Number.parseInt(hex.slice(1), 16);
  return [id, Object.freeze([(value >> 16) & 255, (value >> 8) & 255, value & 255])];
})) as Record<ColorId, readonly [number, number, number]>);
function normalize(radii: number[], max: number): readonly number[] {
  const factor = max / Math.max(...radii);
  return Object.freeze(radii.map((r) => r * factor));
}
export const AVATAR_PROFILES: Readonly<Record<ShapeId, readonly number[]>> = Object.freeze({
  cercle: Object.freeze(ANGLES.map(() => 1)),
  galet: normalize(ANGLES.map((a) => 1 + 0.075 * Math.cos(2 * a + 0.5) + 0.035 * Math.cos(3 * a + 2.1)), 1.02),
  squircle: normalize(ANGLES.map((a) => (Math.abs(Math.cos(a)) ** 4.2 + Math.abs(Math.sin(a)) ** 4.2) ** (-1 / 4.2)), 1.15),
  capsule: Object.freeze(profileFromPolygon(hullOfCircles(-0.42, 0, 0.62, 0.42, 0, 0.62))),
  triangle: Object.freeze(regularPolygonProfile(3, 1.12, 0.34, -90)),
  hexagone: Object.freeze(regularPolygonProfile(6, 1.04, 0.26, 0)),
  nuage: normalize(unionOfCirclesProfile([{ x: -0.44, y: 0.2, r: 0.54 }, { x: 0.46, y: 0.2, r: 0.5 }, { x: 0.02, y: 0.3, r: 0.6 }, { x: -0.24, y: -0.3, r: 0.48 }, { x: 0.3, y: -0.24, r: 0.44 }]), 1.02),
  goutte: normalize(profileFromPolygon(hullOfCircles(0, 0.28, 0.66, 0, -0.96, 0.05)), 1.04),
});
export interface EyeConfig { w: number; h: number; tilt: number; open: number }
export interface Expression { gaze: Gaze; split: number; eyes: readonly [EyeConfig, EyeConfig] }
const eye = (w: number, h: number, tilt = 0, open = 1): EyeConfig => ({ w, h, tilt, open });
const pair = (w: number, h: number, tilt = 0, open = 1): readonly [EyeConfig, EyeConfig] => [eye(w, h, tilt, open), eye(w, h, -tilt, open)];
export const AVATAR_EXPRESSIONS: Readonly<Record<ExpressionId, Expression>> = {
  neutre: { gaze: { yaw: 28.49, pitch: 28.62, roll: -13 }, split: 15.46, eyes: pair(0.186, 0.412) },
  attentif: { gaze: { yaw: 4, pitch: 5, roll: -4 }, split: 16, eyes: pair(0.21, 0.44) },
  surpris: { gaze: { yaw: 3, pitch: -3, roll: 0 }, split: 19, eyes: pair(0.45, 0.47) },
  excite: { gaze: { yaw: 6, pitch: -14, roll: 0 }, split: 19.5, eyes: pair(0.4, 0.56, -10) },
  heureux: { gaze: { yaw: 5, pitch: 9, roll: 0 }, split: 17, eyes: pair(0.27, 0.17, 14) },
  hilare: { gaze: { yaw: 4, pitch: 14, roll: 0 }, split: 18, eyes: pair(0.34, 0.13, 20) },
  colere: { gaze: { yaw: 3, pitch: 7, roll: 0 }, split: 17, eyes: pair(0.34, 0.15, 30) },
  triste: { gaze: { yaw: 3, pitch: -13, roll: 0 }, split: 16, eyes: pair(0.22, 0.4, -28) },
  effraye: { gaze: { yaw: 2, pitch: -20, roll: 0 }, split: 20.5, eyes: pair(0.4, 0.6) },
  mefiant: { gaze: { yaw: 12, pitch: 6, roll: -6 }, split: 16, eyes: [eye(0.21, 0.4), eye(0.22, 0.15)] },
  confus: { gaze: { yaw: -14, pitch: 3, roll: 8 }, split: 16.5, eyes: [eye(0.2, 0.44, -18), eye(0.28, 0.17, 14)] },
  curieux: { gaze: { yaw: 16, pitch: -9, roll: -15 }, split: 16.5, eyes: [eye(0.24, 0.46, -8), eye(0.2, 0.38, -8)] },
  fier: { gaze: { yaw: 5, pitch: 17, roll: 0 }, split: 17, eyes: pair(0.3, 0.15, 18) },
  timide: { gaze: { yaw: -19, pitch: -14, roll: -7 }, split: 14, eyes: pair(0.17, 0.3) },
  blase: { gaze: { yaw: -22, pitch: 2, roll: 0 }, split: 16, eyes: pair(0.3, 0.12) },
  somnolent: { gaze: { yaw: 6, pitch: -9, roll: -3 }, split: 16, eyes: pair(0.2, 0.42, 0, 0.42) },
};
for (const expression of Object.values(AVATAR_EXPRESSIONS)) {
  Object.freeze(expression.gaze);
  expression.eyes.forEach(Object.freeze);
  Object.freeze(expression.eyes);
  Object.freeze(expression);
}
Object.freeze(AVATAR_EXPRESSIONS);

/** Eye width multiplier applied on top of each expression's base eye size. */
export const EYE_SCALE_W = 1.75;
/** Eye height multiplier applied on top of each expression's base eye size. */
export const EYE_SCALE_H = 1.45;
/** Pulls the midpoint of the two eyes toward the body centre (1 = unchanged). */
export const EYE_CENTER_PULL = 0.6;
/** Widens the distance of each eye from that midpoint (1 = unchanged). */
export const EYE_SPREAD = 1.3;
/** Applies the shared PULL / SPREAD placement to one eye coordinate, given the pair's midpoint. */
export function placeEye(value: number, mid: number): number {
  return mid * EYE_CENTER_PULL + (value - mid) * EYE_SPREAD;
}

/** Random character for a freshly created Bot; one draw per dialog open. */
export function randomCharacterAvatar(): CharacterAvatarConfig {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!;
  return {
    version: 1,
    kind: "character",
    shape: pick(BOT_AVATAR_SHAPES),
    color: pick(BOT_AVATAR_COLORS),
    expression: pick(BOT_AVATAR_EXPRESSIONS),
    motion: "auto",
  };
}

export const AVATAR_EYE_FIT: Readonly<Record<ShapeId, number>> = Object.freeze(Object.fromEntries(BOT_AVATAR_SHAPES.map((shape) => {
  const radii = AVATAR_PROFILES[shape];
  let fit = 1;
  for (const expression of Object.values(AVATAR_EXPRESSIONS)) {
    for (const yaw of [-8, 0, 8]) for (const pitch of [-6, 0, 6]) {
      const poses = eyePoses({ ...expression.gaze, yaw: expression.gaze.yaw + yaw, pitch: expression.gaze.pitch + pitch }, expression.split);
      const mx = (poses[0].x + poses[1].x) / 2, my = (poses[0].y + poses[1].y) / 2;
      for (let i = 0; i < 2; i++) {
        const pose = poses[i]!, eye = expression.eyes[i]!;
        const ex = placeEye(pose.x, mx), ey = placeEye(pose.y, my);
        const tilt = eye.tilt * Math.PI / 180;
        const a = pose.a * Math.cos(tilt) + pose.c * Math.sin(tilt);
        const b = pose.b * Math.cos(tilt) + pose.d * Math.sin(tilt);
        const c = pose.c * Math.cos(tilt) - pose.a * Math.sin(tilt);
        const d = pose.d * Math.cos(tilt) - pose.b * Math.sin(tilt);
        const w = eye.w * EYE_SCALE_W, h = eye.h * EYE_SCALE_H;
        for (const x of [-w / 2, w / 2]) for (const y of [-h / 2, h / 2]) {
          const px = ex + a * x + c * y, py = ey + b * x + d * y;
          fit = Math.min(fit, radiusAtAngle(radii, Math.atan2(py, px)) * 0.83 / (Math.hypot(px, py) || 1));
        }
      }
    }
  }
  return [shape, Math.min(1, fit)];
})) as Record<ShapeId, number>);
