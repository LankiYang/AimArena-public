// A triangle soup is stored as consecutive xyz triples, three vertices per triangle.
export const STACK = 128;

export interface BVH {
  tris: Float32Array;
  count: number;
  bounds: Float32Array;
  right: Int32Array;
  start: Int32Array;
  leafCount: Uint8Array;
  order: Int32Array;
  nodes: number;
}

export interface RayHit { t: number; nx: number; ny: number; nz: number; tri: number }
export interface RayHitAll { t: number; tri: number; facing: number }

export function buildBVH(tris: Float32Array): BVH {
  if (tris.length % 9 !== 0) throw new Error('Triangle array length must be a multiple of 9');
  const count = tris.length / 9;
  const capacity = Math.max(1, count * 2 - 1);
  const bounds = new Float32Array(capacity * 6);
  const right = new Int32Array(capacity).fill(-1);
  const start = new Int32Array(capacity);
  const leafCount = new Uint8Array(capacity);
  const order = new Int32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  let nodes = 0;

  function build(first: number, end: number): void {
    const node = nodes++;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let cminX = Infinity, cminY = Infinity, cminZ = Infinity;
    let cmaxX = -Infinity, cmaxY = -Infinity, cmaxZ = -Infinity;
    for (let i = first; i < end; i++) {
      const p = order[i] * 9;
      for (let v = 0; v < 9; v += 3) {
        const x = tris[p + v], y = tris[p + v + 1], z = tris[p + v + 2];
        minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
      }
      const x = tris[p] + tris[p + 3] + tris[p + 6];
      const y = tris[p + 1] + tris[p + 4] + tris[p + 7];
      const z = tris[p + 2] + tris[p + 5] + tris[p + 8];
      cminX = Math.min(cminX, x); cminY = Math.min(cminY, y); cminZ = Math.min(cminZ, z);
      cmaxX = Math.max(cmaxX, x); cmaxY = Math.max(cmaxY, y); cmaxZ = Math.max(cmaxZ, z);
    }
    const b = node * 6;
    bounds[b] = minX; bounds[b + 1] = minY; bounds[b + 2] = minZ;
    bounds[b + 3] = maxX; bounds[b + 4] = maxY; bounds[b + 5] = maxZ;
    start[node] = first;
    if (end - first <= 4) { leafCount[node] = end - first; return; }

    const sx = cmaxX - cminX, sy = cmaxY - cminY, sz = cmaxZ - cminZ;
    const axis = sx >= sy && sx >= sz ? 0 : sy >= sz ? 1 : 2;
    const pivot = axis === 0 ? (cminX + cmaxX) / 2 : axis === 1 ? (cminY + cmaxY) / 2 : (cminZ + cmaxZ) / 2;
    let left = first, rightIndex = end - 1;
    while (left <= rightIndex) {
      const p = order[left] * 9 + axis;
      if (tris[p] + tris[p + 3] + tris[p + 6] < pivot) left++;
      else {
        const tmp = order[left]; order[left] = order[rightIndex]; order[rightIndex--] = tmp;
      }
    }
    // Avoid pathological tree depth for highly skewed or coincident centroids.
    const size = end - first;
    const mid = left - first < size / 8 || end - left < size / 8 ? first + Math.floor(size / 2) : left;
    build(first, mid);
    right[node] = nodes;
    build(mid, end);
  }
  if (count) build(0, count);
  else nodes = 1;
  return { tris, count, bounds, right, start, leafCount, order, nodes };
}

// Slab intersection handles parallel rays explicitly, including origins on a face.
function intersectsBox(b: Float32Array, node: number, ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number, limit: number): boolean {
  const i = node * 6;
  let near = 0, far = limit;
  if (dx === 0) { if (ox < b[i] || ox > b[i + 3]) return false; }
  else {
    const a = (b[i] - ox) / dx, c = (b[i + 3] - ox) / dx;
    near = Math.max(near, Math.min(a, c)); far = Math.min(far, Math.max(a, c));
  }
  if (dy === 0) { if (oy < b[i + 1] || oy > b[i + 4]) return false; }
  else {
    const a = (b[i + 1] - oy) / dy, c = (b[i + 4] - oy) / dy;
    near = Math.max(near, Math.min(a, c)); far = Math.min(far, Math.max(a, c));
  }
  if (dz === 0) { if (oz < b[i + 2] || oz > b[i + 5]) return false; }
  else {
    const a = (b[i + 2] - oz) / dz, c = (b[i + 5] - oz) / dz;
    near = Math.max(near, Math.min(a, c)); far = Math.min(far, Math.max(a, c));
  }
  return near <= far;
}

function trace(bvh: BVH, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  maxT: number, minAbsNy: number, earlyT: number, skipA: number, skipB: number,
  all: RayHitAll[] | null): RayHit | null {
  if (!bvh.count || maxT < 0 || (dx === 0 && dy === 0 && dz === 0)) return null;
  const stack: number[] = [0];
  const { bounds, right, start, leafCount, order, tris } = bvh;
  let nearest: RayHit | null = null;
  let limit = maxT;
  while (stack.length) {
    const node = stack.pop()!;
    if (!intersectsBox(bounds, node, ox, oy, oz, dx, dy, dz, limit)) continue;
    if (right[node] !== -1) {
      stack.push(right[node], node + 1);
      continue;
    }
    const end = start[node] + leafCount[node];
    for (let j = start[node]; j < end; j++) {
      const tri = order[j];
      if (tri >= skipA && tri < skipB) continue;
      const p = tri * 9;
      const ax = tris[p], ay = tris[p + 1], az = tris[p + 2];
      const ux = tris[p + 3] - ax, uy = tris[p + 4] - ay, uz = tris[p + 5] - az;
      const vx = tris[p + 6] - ax, vy = tris[p + 7] - ay, vz = tris[p + 8] - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const length = Math.hypot(nx, ny, nz);
      if (length === 0 || Math.abs(ny) < minAbsNy * length) continue;
      const denom = nx * dx + ny * dy + nz * dz;
      if (denom === 0) continue;
      const t = (nx * (ax - ox) + ny * (ay - oy) + nz * (az - oz)) / denom;
      if (t < 0 || t > limit) continue;
      const px = ox + t * dx - ax, py = oy + t * dy - ay, pz = oz + t * dz - az;
      const uu = ux * ux + uy * uy + uz * uz, uv = ux * vx + uy * vy + uz * vz;
      const vv = vx * vx + vy * vy + vz * vz, pu = px * ux + py * uy + pz * uz;
      const pv = px * vx + py * vy + pz * vz, det = uu * vv - uv * uv;
      if (det <= 0) continue;
      const s = (pu * vv - pv * uv) / det, q = (pv * uu - pu * uv) / det;
      if (s < -1e-10 || q < -1e-10 || s + q > 1 + 1e-10) continue;
      if (all) all.push({ t, tri, facing: denom < 0 ? 1 : -1 });
      else {
        limit = t;
        nearest = { t, nx: nx / length, ny: ny / length, nz: nz / length, tri };
        if (t < earlyT) return nearest;
      }
    }
  }
  return nearest;
}

export function raycast(bvh: BVH, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  maxT = Infinity, minAbsNy = -Infinity, earlyT = -Infinity, skipA = 0, skipB = 0): RayHit | null {
  return trace(bvh, ox, oy, oz, dx, dy, dz, maxT, minAbsNy, earlyT, skipA, skipB, null);
}

export function raycastAll(bvh: BVH, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  maxT = Infinity): RayHitAll[] {
  const hits: RayHitAll[] = [];
  trace(bvh, ox, oy, oz, dx, dy, dz, maxT, -Infinity, -Infinity, 0, 0, hits);
  hits.sort((a, b) => a.t - b.t);
  return hits;
}
