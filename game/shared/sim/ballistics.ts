import { raycastAll, type BVH } from '../world/bvh.ts';
import type { HitPart, SurfaceImpact, V3 } from '../combat.ts';

export const DEFAULT_SURFACE_CODE = 5;
export const MIN_SEGMENT_THICKNESS = 0.1;
export const MAX_PENETRATION_SEGMENTS = 2;
export const DEDUPE_T = 0.002;
export const MAX_IMPACTS = 6;
export const HEAD_RADIUS = 0.18, HEAD_HEIGHT = 1.64, HEAD_CROUCH = 0.4;
export const TORSO_HALF = 0.27, TORSO_LOW = 0.75, TORSO_HIGH = 1.45, TORSO_CROUCH = 0.3;
export const LEGS_HALF = 0.22, LEGS_LOW = 0.05, LEGS_HIGH = 0.75, LEGS_CROUCH = 0.15;
export interface BallisticsWorld { projectile: BVH; codes: Uint8Array | null }
export interface HitBox { x: number; y: number; z: number; crouch: number }
export interface HumanRayHit { t: number; part: HitPart }
export interface SurfaceSegment { t0: number; t1: number; code: number; cost: number }
export interface Penetration { used: number; remaining: number; segments: number; penetrated: boolean; blockedAt: number | null; segs: SurfaceSegment[]; impacts: SurfaceImpact[] }
export interface HumanCandidate extends HitBox { id: number }
export interface RayTrace { endT: number; end: V3; human: { id: number; part: HitPart; t: number } | null; penetration: Penetration; blocked: boolean }

function boxIntersection(origin: number[], dir: number[], low: number[], high: number[]): number | null {
  let near = 0, far = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dir[i]) < 1e-10) { if (origin[i] < low[i] || origin[i] > high[i]) return null; continue; }
    const a = (low[i] - origin[i]) / dir[i], b = (high[i] - origin[i]) / dir[i];
    near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b));
    if (near > far) return null;
  }
  return near;
}
export function rayHuman(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, body: HitBox): HumanRayHit | null {
  const c = Math.max(0, Math.min(1, body.crouch)), x = ox - body.x, y = oy - (body.y + HEAD_HEIGHT - HEAD_CROUCH * c), z = oz - body.z;
  const b = x * dx + y * dy + z * dz, discriminant = b * b - (x * x + y * y + z * z - HEAD_RADIUS * HEAD_RADIUS);
  let best: HumanRayHit | null = null;
  if (discriminant >= 0) { const far = -b + Math.sqrt(discriminant), near = -b - Math.sqrt(discriminant); if (far >= 0 && Math.max(0, near) <= maxT) best = { t: Math.max(0, near), part: 'head' }; }
  for (const [part, half, lo, hi, shift] of [['body', TORSO_HALF, TORSO_LOW, TORSO_HIGH, TORSO_CROUCH], ['legs', LEGS_HALF, LEGS_LOW, LEGS_HIGH, LEGS_CROUCH]] as const) {
    const t = boxIntersection([ox, oy, oz], [dx, dy, dz], [body.x - half, body.y + lo - shift * c, body.z - half], [body.x + half, body.y + hi - shift * c, body.z + half]);
    if (t !== null && t <= maxT && (!best || t < best.t)) best = { t, part };
  }
  return best;
}
export function surfaceCode(w: BallisticsWorld, tri: number): number { const code = w.codes?.[tri]; return code === undefined || code > 7 ? DEFAULT_SURFACE_CODE : code; }
function normalOf(bvh: BVH, tri: number): V3 | null {
  const a = tri * 9, v = bvh.tris;
  if (a < 0 || a + 8 >= v.length) return null;
  const ux = v[a + 3] - v[a], uy = v[a + 4] - v[a + 1], uz = v[a + 5] - v[a + 2], vx = v[a + 6] - v[a], vy = v[a + 7] - v[a + 1], vz = v[a + 8] - v[a + 2];
  const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx, length = Math.hypot(x, y, z);
  return length > 1e-9 ? { x: x / length, y: y / length, z: z / length } : null;
}
/** Project-authored resistance per metre; 0/1 are non-solid and 7 is impenetrable. */
const RESISTANCE = [0, 0, 0.3, 0.45, 0.6, 1.4, 2.5, Infinity];
export function penetrate(w: BallisticsWorld, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, budget: number): Penetration {
  const hits: { t: number; tri: number; facing: number; code: number }[] = [];
  for (const h of raycastAll(w.projectile, ox, oy, oz, dx, dy, dz, maxT)) {
    const code = surfaceCode(w, h.tri); if (code < 2) continue;
    const previous = hits[hits.length - 1];
    if (previous && Math.abs(h.t - previous.t) <= DEDUPE_T && h.facing === previous.facing) {
      if (RESISTANCE[code] > RESISTANCE[previous.code]) Object.assign(previous, h, { code });
    } else hits.push({ ...h, code });
  }
  const initial = Math.max(0, budget), segs: SurfaceSegment[] = []; let remaining = initial, blockedAt: number | null = null;
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i]; let end = start.t + MIN_SEGMENT_THICKNESS;
    if (start.facing > 0 && i + 1 < hits.length && hits[i + 1].facing < 0) end = hits[++i].t;
    const cost = Math.max(MIN_SEGMENT_THICKNESS, end - start.t) * RESISTANCE[start.code];
    if (segs.length >= MAX_PENETRATION_SEGMENTS || !Number.isFinite(cost) || cost >= remaining) { blockedAt = start.t; remaining = 0; break; }
    remaining -= cost; segs.push({ t0: start.t, t1: end, code: start.code, cost });
  }
  const impacts: SurfaceImpact[] = [];
  for (const h of hits) {
    if ((blockedAt !== null && h.t > blockedAt + DEDUPE_T) || impacts.length >= MAX_IMPACTS) break;
    const normal = normalOf(w.projectile, h.tri); if (!normal) continue;
    impacts.push({ position: { x: ox + dx * h.t, y: oy + dy * h.t, z: oz + dz * h.t }, normal, surface: h.code });
  }
  return { used: initial - remaining, remaining, segments: segs.length, penetrated: segs.length > 0, blockedAt, segs, impacts };
}
export function penetrationDamage(base: number, pen: Pick<Penetration, 'remaining'>, budget: number): number { return budget <= 0 || pen.remaining <= 0 || base <= 0 ? 0 : Math.max(1, Math.floor(base * Math.min(1, pen.remaining / budget))); }
export function traceRay(w: BallisticsWorld, origin: V3, dir: V3, range: number, budget: number, humans: HumanCandidate[]): RayTrace {
  let human: RayTrace['human'] = null;
  for (const h of humans) { const hit = rayHuman(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, human?.t ?? range, h); if (hit && (!human || hit.t < human.t)) human = { id: h.id, ...hit }; }
  const pen = penetrate(w, origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, human?.t ?? range, budget), blocked = pen.blockedAt !== null;
  const endT = pen.blockedAt ?? human?.t ?? range;
  return { endT, end: { x: origin.x + dir.x * endT, y: origin.y + dir.y * endT, z: origin.z + dir.z * endT }, human: blocked ? null : human, penetration: pen, blocked };
}
export function traceMelee(w: BallisticsWorld, origin: V3, dir: V3, range: number, humans: HumanCandidate[]): RayTrace {
  let best = traceRay(w, origin, dir, range, 0, humans);
  if (best.human || best.blocked) return best;
  for (const h of humans) {
    const c = Math.max(0, Math.min(1, h.crouch));
    for (const height of [1.1 - TORSO_CROUCH * c, HEAD_HEIGHT - HEAD_CROUCH * c, 0.4 - LEGS_CROUCH * c]) {
      const x = h.x - origin.x, y = h.y + height - origin.y, z = h.z - origin.z, length = Math.hypot(x, y, z);
      if (length < 1e-9 || (x * dir.x + y * dir.y + z * dir.z) / length < Math.cos(35 * Math.PI / 180)) continue;
      const candidate = traceRay(w, origin, { x: x / length, y: y / length, z: z / length }, range, 0, humans);
      if (candidate.human && (!best.human || candidate.endT < best.endT)) best = candidate;
    }
  }
  return best;
}
