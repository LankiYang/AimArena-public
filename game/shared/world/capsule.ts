import * as THREE from 'three';
import type { BVH } from './bvh.ts';

export interface Contact { nx: number; ny: number; nz: number; depth: number; fny: number; atFoot: number; faceDist: number }
export interface MoveResult { x: number; y: number; z: number; grounded: boolean; groundNy: number; hitWall: boolean; wallNx: number; wallNy: number; wallNz: number; perchable: boolean }
export const RADIUS = 0.42;
export const HALF_HEIGHT = 0.98;
export const SEG_HALF = HALF_HEIGHT - RADIUS;
export const STEP = 0.45;
export const WALK_NY = Math.cos(Math.PI / 4);
const EPS = 1e-6;
const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
const lo = new THREE.Vector3(), hi = new THREE.Vector3(), normal = new THREE.Vector3();
const p = new THREE.Vector3(), q = new THREE.Vector3(), bestP = new THREE.Vector3(), bestQ = new THREE.Vector3();
const u = new THREE.Vector3(), v = new THREE.Vector3(), w = new THREE.Vector3(), tmp = new THREE.Vector3();
const tri = new THREE.Triangle();

// Candidate closest points between the capsule axis and a triangle edge.
function edgeClosest(e0: THREE.Vector3, e1: THREE.Vector3) {
  u.subVectors(hi, lo); v.subVectors(e1, e0); w.subVectors(lo, e0);
  const aa = u.dot(u), bb = u.dot(v), cc = v.dot(v), dd = u.dot(w), ee = v.dot(w);
  const den = aa * cc - bb * bb;
  let s = den > EPS ? Math.max(0, Math.min(1, (bb * ee - cc * dd) / den)) : 0;
  let t = cc > EPS ? (bb * s + ee) / cc : 0;
  if (t < 0 || t > 1) { t = Math.max(0, Math.min(1, t)); s = aa > EPS ? Math.max(0, Math.min(1, (bb * t - dd) / aa)) : 0; }
  p.copy(lo).addScaledVector(u, s); q.copy(e0).addScaledVector(v, t);
}
function visit(bvh: BVH, x: number, y: number, z: number, r: number, hs: number, fn: (index: number) => boolean | void) {
  if (!bvh.count) return;
  const stack = [0], bounds = bvh.bounds;
  while (stack.length) {
    const n = stack.pop()!, k = n * 6;
    if (x + r < bounds[k] || x - r > bounds[k + 3] || y + hs + r < bounds[k + 1] || y - hs - r > bounds[k + 4] || z + r < bounds[k + 2] || z - r > bounds[k + 5]) continue;
    if (bvh.right[n] < 0) {
      for (let j = 0; j < bvh.leafCount[n]; j++) if (fn(bvh.order[bvh.start[n] + j])) return;
    } else { stack.push(bvh.right[n], n + 1); }
  }
}
function contactTriangle(bvh: BVH, index: number, x: number, y: number, z: number, r: number, hs: number, out: Contact): boolean {
  const t = bvh.tris, i = index * 9;
  a.set(t[i], t[i + 1], t[i + 2]); b.set(t[i + 3], t[i + 4], t[i + 5]); c.set(t[i + 6], t[i + 7], t[i + 8]);
  tri.set(a, b, c); tri.getNormal(normal);
  if (normal.lengthSq() < EPS) return false;
  lo.set(x, y - hs, z); hi.set(x, y + hs, z);
  let best = Infinity;
  const take = () => { const d = p.distanceToSquared(q); if (d < best) { best = d; bestP.copy(p); bestQ.copy(q); } };
  p.copy(lo); tri.closestPointToPoint(p, q); take();
  p.copy(hi); tri.closestPointToPoint(p, q); take();
  edgeClosest(a, b); take(); edgeClosest(b, c); take(); edgeClosest(c, a); take();
  const d0 = tmp.subVectors(lo, a).dot(normal), d1 = tmp.subVectors(hi, a).dot(normal);
  if (d0 * d1 <= 0 && Math.abs(d0 - d1) > EPS) {
    p.copy(lo).lerp(hi, d0 / (d0 - d1));
    if (tri.containsPoint(p)) { best = 0; bestP.copy(p); bestQ.copy(p); }
  }
  if (best >= r * r) return false;
  const dist = Math.sqrt(best);
  if (dist > EPS) tmp.subVectors(bestP, bestQ).multiplyScalar(1 / dist);
  else { tmp.copy(normal); if (tmp.dot(w.set(x - a.x, y - a.y, z - a.z)) < 0) tmp.negate(); }
  out.nx = tmp.x; out.ny = tmp.y; out.nz = tmp.z; out.depth = r - dist;
  out.fny = Math.abs(normal.y); out.atFoot = bestP.y <= y - hs + 1e-4 ? 1 : 0;
  out.faceDist = Math.hypot(bestP.x - bestQ.x, bestP.z - bestQ.z);
  return true;
}
export const makeContacts = (): Contact[] => Array.from({ length: 32 }, () => ({ nx: 0, ny: 0, nz: 0, depth: 0, fny: 0, atFoot: 0, faceDist: 0 }));
export function contacts(bvh: BVH, x: number, y: number, z: number, r: number, hs: number, out: Contact[]): number {
  let count = 0;
  visit(bvh, x, y, z, r, hs, i => { if (count < out.length && contactTriangle(bvh, i, x, y, z, r, hs, out[count])) count++; });
  return count;
}
const scratch = makeContacts();
export function overlaps(bvh: BVH, x: number, y: number, z: number, r: number, hs: number): boolean {
  let hit = false;
  visit(bvh, x, y, z, r, hs, i => { if (contactTriangle(bvh, i, x, y, z, r, hs, scratch[0])) { hit = true; return true; } });
  return hit;
}
function resolve(bvh: BVH, result: MoveResult, r: number, hs: number) {
  for (let iter = 0; iter < 8; iter++) {
    const count = contacts(bvh, result.x, result.y, result.z, r, hs, scratch);
    if (!count) break;
    let deepest = scratch[0];
    for (let j = 1; j < count; j++) if (scratch[j].depth > deepest.depth) deepest = scratch[j];
    const d = deepest.depth + 1e-5;
    result.x += deepest.nx * d; result.y += deepest.ny * d; result.z += deepest.nz * d;
    if (deepest.ny >= WALK_NY) { result.grounded = true; result.groundNy = Math.max(result.groundNy, deepest.ny); result.perchable = true; }
    else if (Math.abs(deepest.ny) < WALK_NY) { result.hitWall = true; result.wallNx = deepest.nx; result.wallNy = deepest.ny; result.wallNz = deepest.nz; }
  }
}
export function moveCapsule(bvh: BVH, x: number, y: number, z: number, dx: number, dy: number, dz: number, r = RADIUS, hs = SEG_HALF, step = STEP, snap = true): MoveResult {
  const result: MoveResult = { x, y, z, grounded: false, groundNy: 0, hitWall: false, wallNx: 0, wallNy: 0, wallNz: 0, perchable: false };
  const count = Math.max(1, Math.ceil(Math.hypot(dx, dy, dz) / Math.max(r * 0.4, 0.02)));
  for (let i = 0; i < count; i++) {
    const ox = result.x, oy = result.y, oz = result.z;
    result.x += dx / count; result.y += dy / count; result.z += dz / count;
    resolve(bvh, result, r, hs);
    if (step > 0 && snap && dy <= 0 && result.hitWall && (dx || dz)) {
      const sx = ox + dx / count, sz = oz + dz / count, sy = oy + step;
      if (!overlaps(bvh, ox, sy, oz, r, hs) && !overlaps(bvh, sx, sy, sz, r, hs)) {
        result.x = sx; result.y = sy; result.z = sz;
        const slices = Math.max(1, Math.ceil((step + 0.05) / 0.04));
        for (let j = 0; j < slices; j++) { result.y -= (step + 0.05) / slices; resolve(bvh, result, r, hs); if (result.grounded) break; }
      }
    }
  }
  if (snap && dy <= 0 && !result.grounded) { result.y -= 0.035; resolve(bvh, result, r, hs); if (!result.grounded) result.y += 0.035; }
  return result;
}
