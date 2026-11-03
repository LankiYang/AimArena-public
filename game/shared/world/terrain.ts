import * as THREE from 'three';

export interface CollisionPrim { name: string; verts: number; tris: number; pos: number[]; idx: number[] }
export interface CollisionSet { count: number; tris: number; prim: number[]; m: number[] }
export interface CollisionDoc { map: string; space: string; prims: CollisionPrim[]; walkSets?: string[]; sets: Record<string, CollisionSet>; noCollision?: string[]; killSets?: string[] }
export interface SurfaceRuns { tris: number; runs: string }
export interface SurfacesDoc { v: number; map: string; codes: string[]; walk: SurfaceRuns; cable?: SurfaceRuns; projectile: number[] }
export interface Rope { name: string; label: string; points: number[][]; bottom: number[]; top: number[]; center: number[]; half: number[]; cable?: string; tuning?: Record<string, number> }
export interface RopesDoc { map: string; ropes: Rope[] }
export interface MeshEntry { name: string; geometry: THREE.BufferGeometry; matrix: THREE.Matrix4; mirrored: boolean }
export interface Terrain { pawnTris: Float32Array; projectileTris: Float32Array | null; codes: Uint8Array | null; projectileVolumeStart: number; surfErr: string | null }
export const MAPS_WITH_ROPES = new Set<string>();
export const SURFACE_CODES = ['non-solid', 'permeable', 'glass', 'earth', 'wood', 'stone', 'metal', 'solid'];
export const SURFACE_COST = [0, 0, 0.2, 0.3, 0.4, 1, 2, 100000];
export const WALK_COS = Math.cos(Math.PI / 4);

export function concat(a: Float32Array, b: Float32Array): Float32Array { const out = new Float32Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; }
export function bbox(t: Float32Array): number[] {
  const out = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < t.length; i += 3) for (let j = 0; j < 3; j++) { out[j] = Math.min(out[j], t[i + j]); out[j + 3] = Math.max(out[j + 3], t[i + j]); }
  return out;
}
export function expandSet(doc: CollisionDoc, setName: string): Float32Array {
  const set = doc.sets[setName];
  if (!set) throw new Error(`Missing collision set: ${setName}`);
  const result = new Float32Array(set.tris * 9); let n = 0;
  for (let i = 0; i < set.count; i++) {
    const prim = doc.prims[set.prim[i]], offset = i * 12, m = set.m;
    if (!prim || m.length < offset + 12) throw new Error(`Invalid collision instance in ${setName}`);
    for (const index of prim.idx) {
      const k = index * 3, x = prim.pos[k], y = prim.pos[k + 1], z = prim.pos[k + 2];
      result[n++] = m[offset] * x + m[offset + 1] * y + m[offset + 2] * z + m[offset + 3];
      result[n++] = m[offset + 4] * x + m[offset + 5] * y + m[offset + 6] * z + m[offset + 7];
      result[n++] = m[offset + 8] * x + m[offset + 9] * y + m[offset + 10] * z + m[offset + 11];
    }
  }
  if (n !== result.length) throw new Error(`Collision triangle count mismatch in ${setName}`);
  return result;
}
export function expandInstances(doc: CollisionDoc, setName: string, filter: (name: string, i: number) => boolean = () => true): { name: string; index: number; tris: Float32Array; box: number[] }[] {
  const set = doc.sets[setName], result: { name: string; index: number; tris: Float32Array; box: number[] }[] = [];
  for (let i = 0; i < set.count; i++) {
    const prim = doc.prims[set.prim[i]]; if (!filter(prim.name, i)) continue;
    const tris = expandSet({ ...doc, sets: { instance: { count: 1, tris: prim.tris, prim: [set.prim[i]], m: set.m.slice(i * 12, i * 12 + 12) } } }, 'instance');
    result.push({ name: prim.name, index: i, tris, box: bbox(tris) });
  }
  return result;
}
export function decodeRuns(block: SurfaceRuns): { counts: number[]; codes: number[] } {
  if (!Number.isSafeInteger(block.tris) || block.tris < 0) throw new Error('Invalid surface triangle count');
  const bytes = atob(block.runs), counts: number[] = [], codes: number[] = []; let p = 0, sum = 0;
  while (p < bytes.length) {
    let count = 0, factor = 1, byte: number;
    do { if (p >= bytes.length || factor > 2 ** 35) throw new Error('Invalid surface run'); byte = bytes.charCodeAt(p++); count += (byte & 127) * factor; factor *= 128; } while (byte & 128);
    if (p >= bytes.length) throw new Error('Missing surface code');
    const code = bytes.charCodeAt(p++); if (code > 7) throw new Error('Invalid surface code');
    counts.push(count); codes.push(code); sum += count;
  }
  if (sum !== block.tris) throw new Error('Surface triangle count mismatch');
  return { counts, codes };
}
export function buildSurfaceCodes(surf: SurfacesDoc, doc: CollisionDoc, walkTris: number, cableTris: number): Uint8Array {
  if (surf.v !== 1 || surf.map !== doc.map || surf.walk.tris !== walkTris || (surf.cable?.tris ?? 0) !== cableTris) throw new Error('Surface metadata mismatch');
  const projectile = doc.sets.projectile; if (surf.projectile.length !== (projectile?.count ?? 0)) throw new Error('Projectile surface count mismatch');
  const out = new Uint8Array(walkTris + cableTris + (projectile?.tris ?? 0)); let pos = 0;
  for (const block of [surf.walk, surf.cable]) if (block) { const runs = decodeRuns(block); for (let i = 0; i < runs.counts.length; i++) { out.fill(runs.codes[i], pos, pos + runs.counts[i]); pos += runs.counts[i]; } }
  for (let i = 0; i < surf.projectile.length; i++) { const code = surf.projectile[i]; if (!Number.isInteger(code) || code < 0 || code > 7) throw new Error('Invalid projectile surface'); const count = doc.prims[projectile!.prim[i]].tris; out.fill(code, pos, pos + count); pos += count; }
  if (pos !== out.length) throw new Error('Projectile triangle count mismatch');
  return out;
}
export function instName(o: THREE.Object3D): string { let node: THREE.Object3D | null = o; while (node) { if (node.name) return node.name; node = node.parent; } return ''; }
export function meshList(scene: THREE.Object3D): MeshEntry[] {
  const result: MeshEntry[] = []; scene.updateMatrixWorld(true);
  scene.traverse(o => {
    const mesh = o as THREE.InstancedMesh; if (!mesh.isMesh || !mesh.geometry) return;
    if (mesh.isInstancedMesh) { for (let i = 0; i < mesh.count; i++) { const matrix = new THREE.Matrix4(); mesh.getMatrixAt(i, matrix); matrix.premultiply(mesh.matrixWorld); result.push({ name: instName(mesh), geometry: mesh.geometry, matrix, mirrored: matrix.determinant() < 0 }); } }
    else { const matrix = mesh.matrixWorld.clone(); result.push({ name: instName(mesh), geometry: mesh.geometry, matrix, mirrored: matrix.determinant() < 0 }); }
  });
  return result;
}
function matches(name: string, names: Set<string>): boolean { return names.has(name) || names.has(name.split('#')[0]); }
export function soup(list: MeshEntry[], exclude: Set<string> | null, includeOnly?: Set<string>): Float32Array {
  let count = 0; const selected: MeshEntry[] = [];
  for (const mesh of list) { const pos = mesh.geometry.getAttribute('position'); if (!pos || (exclude && matches(mesh.name, exclude)) || (includeOnly && !matches(mesh.name, includeOnly))) continue; selected.push(mesh); count += Math.floor((mesh.geometry.index?.count ?? pos.count) / 3) * 9; }
  const out = new Float32Array(count), point = new THREE.Vector3(); let cursor = 0;
  for (const mesh of selected) {
    const pos = mesh.geometry.getAttribute('position'), index = mesh.geometry.index, vertices = Math.floor((index?.count ?? pos.count) / 3) * 3;
    for (let i = 0; i < vertices; i++) { const j = mesh.mirrored && i % 3 ? i + (i % 3 === 1 ? 1 : -1) : i; const vertex = index ? index.getX(j) : j; point.fromBufferAttribute(pos, vertex).applyMatrix4(mesh.matrix); out[cursor++] = point.x; out[cursor++] = point.y; out[cursor++] = point.z; }
  }
  return out;
}
export function buildSoups(list: MeshEntry[], doc: CollisionDoc, ropes: Rope[] | null): { walk: Float32Array; cable: Float32Array | null } {
  const excluded = new Set(doc.noCollision ?? []), cables = new Set((ropes ?? []).flatMap(r => r.cable ? [r.cable] : []));
  return { walk: soup(list, new Set([...excluded, ...cables])), cable: cables.size ? soup(list, excluded, cables) : null };
}
// Public block maps are authored without coincident decorative surfaces.
export function zfightLift(_scene: THREE.Object3D): void { }
// The public map uses scene meshes themselves as the collision representation.
export function artAugment(_collision: Float32Array, art: Float32Array, _codes: Uint8Array | null = null): Float32Array { return art; }
export function buildTerrain(scene: THREE.Object3D, doc: CollisionDoc, surf: SurfacesDoc | null, ropesDoc: RopesDoc | null, opts: { projectile?: boolean; lifted?: boolean } = {}): Terrain {
  const walkSets = doc.walkSets ?? ['pawn', 'greybox'];
  let collision = new Float32Array(0); for (const set of walkSets) collision = concat(collision, expandSet(doc, set));
  const { walk, cable } = buildSoups(meshList(scene), doc, ropesDoc?.ropes ?? null);
  const base = cable ? concat(walk, cable) : walk;
  const projectile = doc.sets.projectile ? expandSet(doc, 'projectile') : new Float32Array(0);
  let codes: Uint8Array | null = null, surfErr: string | null = null;
  if (surf) { try { codes = buildSurfaceCodes(surf, doc, walk.length / 9, (cable?.length ?? 0) / 9); } catch (e) { surfErr = String(e); } } else surfErr = 'no surfaces';
  return { pawnTris: concat(collision, artAugment(collision, walk, codes)), projectileTris: opts.projectile === false ? null : concat(base, projectile), codes, projectileVolumeStart: base.length / 9, surfErr };
}
