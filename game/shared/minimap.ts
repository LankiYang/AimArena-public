import type { MapId } from './catalog.ts';
import type { V3 } from './combat.ts';
import { raycast, type BVH } from './world/bvh.ts';

export interface MinimapDoc {
  map: MapId;
  image: string;
  transform: { scaleU: number; scaleV: number; offsetU: number; offsetV: number };
  callouts: { name: string; x: number; z: number }[];
}
// Procedural arenas use the same world orientation for image and markers.
export const MINIMAP_TURNS: Record<MapId, number> = { ascent: 0, bonsai: 0, infinity: 0, jam: 0, plummet: 0, triad: 0 };
export function validMinimap(value: unknown, map: MapId): value is MinimapDoc {
  if (!value || typeof value !== 'object') return false;
  const doc = value as MinimapDoc;
  if (doc.map !== map || typeof doc.image !== 'string' || !doc.transform || !Array.isArray(doc.callouts)) return false;
  const { scaleU, scaleV, offsetU, offsetV } = doc.transform;
  return [scaleU, scaleV, offsetU, offsetV].every(Number.isFinite) && scaleU > 0 && scaleV > 0
    && doc.callouts.every(c => !!c && typeof c.name === 'string' && Number.isFinite(c.x) && Number.isFinite(c.z));
}
export function minimapPoint(doc: MinimapDoc, x: number, z: number): { u: number; v: number } {
  const { scaleU, scaleV, offsetU, offsetV } = doc.transform;
  return { u: x * scaleU + offsetU, v: z * scaleV + offsetV };
}
export function minimapHeading(doc: MinimapDoc, yaw: number): number {
  return Math.atan2(-Math.sin(yaw) * doc.transform.scaleU, Math.cos(yaw) * doc.transform.scaleV);
}
// Contacts require both camera visibility and an unobstructed line of sight.
export function radarEnemyVisible(world: BVH, eye: V3, target: V3, inView: boolean): boolean {
  if (!inView) return false;
  const dx = target.x - eye.x, dy = target.y - eye.y, dz = target.z - eye.z;
  const distance = Math.hypot(dx, dy, dz);
  return distance > 0.01 && distance <= 55 && !raycast(world, eye.x, eye.y, eye.z, dx / distance, dy / distance, dz / distance, distance);
}
