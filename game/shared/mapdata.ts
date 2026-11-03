// Horizontal coordinates are x/z in metres; y is the elevation of the feet.
export interface P3 { x: number; y: number; z: number; yaw?: number }
export interface Rect2 { min: [number, number]; max: [number, number] }
export interface SiteData { box: Rect2; center: [number, number]; y: number; floor?: Rect2 }
export interface MapData {
  name: string;
  tdm: { BL: P3[]; GR: P3[] };
  snd: { calibrated?: boolean; spawns: { attack: { spawns: P3[] }; defend: { spawns: P3[] } }; sites: Record<string, SiteData> };
}
export interface MapsFile { version: number; maps: Record<string, MapData> }
export function sitePoint(map: MapData, key: string): P3 {
  const site = map.snd.sites[key];
  return { x: site.center[0], y: site.y, z: site.center[1] };
}
export function inSite(map: MapData, x: number, y: number, z: number): string | null {
  for (const [key, site] of Object.entries(map.snd.sites)) {
    if (Math.abs(y - site.y) >= 3) continue;
    const { min, max } = site.box;
    if (x >= min[0] && x <= max[0] && z >= min[1] && z <= max[1]) return key;
  }
  return null;
}
