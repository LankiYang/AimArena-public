import type { MapId } from './catalog.ts';

export interface RopeDef {
  id: string;
  top: [number, number, number];
  bottom: [number, number, number];
  radius: number;
  points?: readonly (readonly number[])[];
  bottomAirborne?: boolean;
  renderPath?: boolean;
}

export const ROPE_CLIMB_SPEED = 3;
export const ROPE_ATTACH_RADIUS = 0.8;
export const ROPE_BOTTOM_ZONE = 1.2;
export const ROPE_IDLE_RELEASE = 0.5;
export const ROPE_REATTACH_DELAY = 0.4;
export const MAP_ROPE_REVISION = 3;
export const ROPE_SEGMENT_TOLERANCE = 1;

// The public block map contains no ascenders.
const EMPTY: RopeDef[] = [];
export const ropesFor = (_map: MapId): RopeDef[] => EMPTY;
export const legacyRopesFor = (_map: MapId): RopeDef[] => EMPTY;
export const negotiatedRopesFor = (_map: MapId, _revision: number | undefined): RopeDef[] => EMPTY;

const path = (r: RopeDef): readonly (readonly number[])[] => r.points && r.points.length >= 2 ? r.points : [r.bottom, r.top];
const segmentLength = (a: readonly number[], b: readonly number[]) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
export const ropeHeight = (r: RopeDef): number => r.top[1] - r.bottom[1];
export function ropeLength(r: RopeDef): number {
  const p = path(r); let length = 0;
  for (let i = 1; i < p.length; i++) length += segmentLength(p[i - 1], p[i]);
  return length;
}
export function ropePoint(r: RopeDef, t: number): [number, number, number] {
  const p = path(r), total = ropeLength(r);
  let distance = Math.max(0, Math.min(1, t)) * total;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1], b = p[i], length = segmentLength(a, b);
    if (distance <= length || i === p.length - 1) {
      const f = length ? distance / length : 0;
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    }
    distance -= length;
  }
  return [p[0][0], p[0][1], p[0][2]];
}
export function ropeParamAt(r: RopeDef, y: number): number {
  const height = ropeHeight(r);
  return height ? (y - r.bottom[1]) / height : 0;
}
export const ropeTravelTime = (r: RopeDef, t0: number, t1: number): number => Math.abs(t1 - t0) * ropeLength(r) / ROPE_CLIMB_SPEED;
export function ropeParamClamp(r: RopeDef, y: number): { t: number; inRange: boolean } {
  const t = ropeParamAt(r, y);
  return { t: Math.max(0, Math.min(1, t)), inRange: t >= -0.15 && t <= 1.15 };
}
export function nearestOnRope(r: RopeDef, x: number, y: number, z: number, maxDistance = Infinity): { t: number; dist: number } | null {
  const p = path(r), total = ropeLength(r);
  let best = maxDistance * maxDistance, bestT = 0, offset = 0, found = false;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1], b = p[i], dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const length = Math.hypot(dx, dy, dz);
    const u = length ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy + (z - a[2]) * dz) / (length * length))) : 0;
    const d2 = (x - a[0] - u * dx) ** 2 + (y - a[1] - u * dy) ** 2 + (z - a[2] - u * dz) ** 2;
    if (d2 <= best) { best = d2; bestT = total ? (offset + u * length) / total : 0; found = true; }
    offset += length;
  }
  return found ? { t: bestT, dist: Math.sqrt(best) } : null;
}
export function ropeHorizontalDistance(r: RopeDef, x: number, z: number, y: number): number {
  return nearestOnRope(r, x, y, z)?.dist ?? Infinity;
}
export function nearestRope(ropes: readonly RopeDef[], x: number, y: number, z: number, radiusScale = 1): { index: number; rope: RopeDef; t: number; dist: number } | null {
  let result: { index: number; rope: RopeDef; t: number; dist: number } | null = null;
  for (let i = 0; i < ropes.length; i++) {
    const rope = ropes[i], hit = nearestOnRope(rope, x, y, z, (rope.radius ?? ROPE_ATTACH_RADIUS) * radiusScale);
    if (hit && (!result || hit.dist < result.dist)) result = { index: i, rope, ...hit };
  }
  return result;
}
