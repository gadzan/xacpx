// Geometry adapted from bloub; source revision and MIT notice are in LICENSE.bloub.
export const SAMPLES = 64;
const TAU = Math.PI * 2;
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
export interface Point { x: number; y: number }
export const ANGLES = Array.from({ length: SAMPLES }, (_, i) => i / SAMPLES * TAU);
const COS = ANGLES.map(Math.cos);
const SIN = ANGLES.map(Math.sin);

export function profileFromPolygon(poly: Point[]): number[] {
  return ANGLES.map((_, k) => {
    const dx = COS[k]!;
    const dy = SIN[k]!;
    let best = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = (a.x * ey - a.y * ex) / den;
      const u = (a.x * dy - a.y * dx) / den;
      if (t > best && u >= 0 && u <= 1) best = t;
    }
    return best;
  });
}

export function hullOfCircles(x1: number, y1: number, r1: number, x2: number, y2: number, r2: number): Point[] {
  const base = Math.atan2(y2 - y1, x2 - x1);
  const spread = Math.acos(clamp((r1 - r2) / (Math.hypot(x2 - x1, y2 - y1) || 1e-6), -1, 1));
  const points: Point[] = [];
  for (let i = 0; i <= 48; i++) {
    const a = base + spread + (TAU - 2 * spread) * i / 48;
    points.push({ x: x1 + Math.cos(a) * r1, y: y1 + Math.sin(a) * r1 });
  }
  for (let i = 0; i <= 48; i++) {
    const a = base - spread + 2 * spread * i / 48;
    points.push({ x: x2 + Math.cos(a) * r2, y: y2 + Math.sin(a) * r2 });
  }
  return points;
}

export function regularPolygonProfile(sides: number, radius: number, corner: number, rotation: number): number[] {
  const vertices = Array.from({ length: sides }, (_, i) => {
    const angle = rotation * Math.PI / 180 + i / sides * TAU;
    return { x: Math.cos(angle) * (radius - corner), y: Math.sin(angle) * (radius - corner) };
  });
  const normal = (a: Point, b: Point) => Math.atan2(-(b.x - a.x), b.y - a.y);
  const points: Point[] = [];
  for (let i = 0; i < sides; i++) {
    const cur = vertices[i]!;
    const a0 = normal(vertices[(i - 1 + sides) % sides]!, cur);
    let delta = normal(cur, vertices[(i + 1) % sides]!) - a0;
    while (delta > Math.PI) delta -= TAU;
    while (delta < -Math.PI) delta += TAU;
    for (let k = 0; k <= 10; k++) {
      const angle = a0 + delta * k / 10;
      points.push({ x: cur.x + Math.cos(angle) * corner, y: cur.y + Math.sin(angle) * corner });
    }
  }
  return profileFromPolygon(points);
}

export function unionOfCirclesProfile(circles: Array<{ x: number; y: number; r: number }>): number[] {
  return ANGLES.map((_, i) => {
    let best = 0;
    for (const circle of circles) {
      const b = COS[i]! * circle.x + SIN[i]! * circle.y;
      const disc = b * b - (circle.x * circle.x + circle.y * circle.y - circle.r * circle.r);
      if (disc >= 0) best = Math.max(best, b + Math.sqrt(disc));
    }
    return best;
  });
}

export function radiusAtAngle(radii: readonly number[], angle: number): number {
  const t = (((angle / TAU) % 1 + 1) % 1) * radii.length;
  const i = Math.floor(t);
  return lerp(radii[i % radii.length]!, radii[(i + 1) % radii.length]!, t - i);
}

export function bodyPath(radii: readonly number[], sx = 1, sy = 1): string {
  const xScale = 34 * sx, yScale = 34 * sy;
  let x0 = radii[SAMPLES - 1]! * COS[SAMPLES - 1]! * xScale, y0 = radii[SAMPLES - 1]! * SIN[SAMPLES - 1]! * yScale;
  let x1 = radii[0]! * COS[0]! * xScale, y1 = radii[0]! * SIN[0]! * yScale;
  let x2 = radii[1]! * COS[1]! * xScale, y2 = radii[1]! * SIN[1]! * yScale;
  const r = (n: number) => Math.round(n * 100) / 100;
  let path = `M${r(x1)} ${r(y1)}`;
  for (let i = 0; i < SAMPLES; i++) {
    const k = (i + 2) % SAMPLES;
    const x3 = radii[k]! * COS[k]! * xScale, y3 = radii[k]! * SIN[k]! * yScale;
    path += `C${r(x1 + (x2 - x0) / 6)} ${r(y1 + (y2 - y0) / 6)} ${r(x2 - (x3 - x1) / 6)} ${r(y2 - (y3 - y1) / 6)} ${r(x2)} ${r(y2)}`;
    x0 = x1; y0 = y1; x1 = x2; y1 = y2; x2 = x3; y2 = y3;
  }
  return `${path}Z`;
}

export interface Gaze { yaw: number; pitch: number; roll: number }
export interface EyeProjection { x: number; y: number; a: number; b: number; c: number; d: number }
type Vec3 = [number, number, number];
function spin(u: Vec3, v: Vec3, degrees: number): [Vec3, Vec3] {
  const a = degrees * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return [[u[0] * c + v[0] * s, u[1] * c + v[1] * s, u[2] * c + v[2] * s], [v[0] * c - u[0] * s, v[1] * c - u[1] * s, v[2] * c - u[2] * s]];
}
export function eyePoses(gaze: Gaze, split: number): [EyeProjection, EyeProjection] {
  let f: Vec3 = [0, 0, 1], right: Vec3 = [1, 0, 0], down: Vec3 = [0, 1, 0];
  [f, right] = spin(f, right, gaze.yaw);
  [down, f] = spin(down, f, gaze.pitch);
  [right, down] = spin(right, down, gaze.roll);
  const build = (side: number): EyeProjection => {
    const [ef, er] = spin(f, right, split * side);
    return { x: ef[0], y: ef[1], a: er[0], b: er[1], c: down[0], d: down[1] };
  };
  return [build(-1), build(1)];
}

export function loopNoise(t: number, period: number, seed: number): number {
  const p = t / period * TAU;
  return 0.55 * Math.sin(p + seed) + 0.3 * Math.sin(2 * p + seed * 1.7 + 1.1) + 0.15 * Math.sin(3 * p + seed * 2.3 + 2.4);
}
