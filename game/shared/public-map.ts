import * as THREE from 'three';
import type { MapId } from './catalog.ts';
import type { MapData, P3, SiteData } from './mapdata.ts';
import type { CollisionDoc, CollisionSet } from './world/terrain.ts';

// All maps use the same metre-based coordinate system. The visible boxes are also
// the collision geometry; the document's additional collision sets are empty.
type Box = readonly [x: number, y: number, z: number, width: number, height: number, depth: number, color: number];
const FLOOR = 0x394b52;
const WALL = 0x687d80;
const COVER = 0x967a59;
const ACCENT = 0x527e85;

const shell: readonly Box[] = [
  [0, -0.5, 0, 48, 1, 36, FLOOR],
  [0, 2, -18.5, 50, 4, 1, WALL], [0, 2, 18.5, 50, 4, 1, WALL],
  [-24.5, 2, 0, 1, 4, 36, WALL], [24.5, 2, 0, 1, 4, 36, WALL],
];

// Separate lanes, low cover and openings are authored in world coordinates.
// Spawn pads and site rectangles are deliberately kept clear of solid boxes.
const layouts: Record<MapId, readonly Box[]> = {
  ascent: [
    [0, 1.5, -8, 2, 3, 8, WALL], [0, 1.5, 8, 2, 3, 8, WALL],
    [-8, 0.75, 0, 3, 1.5, 3, COVER], [8, 0.75, 0, 3, 1.5, 3, COVER],
    [-5, 1, -13, 4, 2, 2, ACCENT], [-5, 1, 13, 4, 2, 2, ACCENT],
  ],
  bonsai: [
    [-3, 1.5, -8, 2, 3, 8, WALL], [3, 1.5, 8, 2, 3, 8, WALL],
    [0, 0.75, 0, 5, 1.5, 2, COVER], [-9, 1, 7, 2, 2, 3, ACCENT],
    [9, 1, -7, 2, 2, 3, ACCENT],
  ],
  infinity: [
    [0, 1.5, -10, 2, 3, 7, WALL], [0, 1.5, 10, 2, 3, 7, WALL],
    [0, 0.75, 0, 3, 1.5, 4, COVER], [-9, 1, -5, 3, 2, 2, ACCENT],
    [9, 1, 5, 3, 2, 2, ACCENT],
  ],
  jam: [
    [-2, 1.5, -9, 2, 3, 7, WALL], [2, 1.5, 9, 2, 3, 7, WALL],
    [-8, 0.75, 0, 3, 1.5, 3, COVER], [0, 0.75, 0, 3, 1.5, 3, COVER],
    [7, 1, 0, 2, 2, 3, ACCENT],
  ],
  plummet: [
    [-2, 1.5, -8, 2, 3, 8, WALL], [2, 1.5, 8, 2, 3, 8, WALL],
    [0, 0.75, 0, 3, 1.5, 3, COVER], [-9, 1, 8, 3, 2, 2, ACCENT],
    [9, 1, -8, 3, 2, 2, ACCENT],
  ],
  triad: [
    [0, 1.5, -9, 2, 3, 7, WALL], [0, 1.5, 9, 2, 3, 7, WALL],
    [-8, 0.75, 0, 3, 1.5, 3, COVER], [0, 0.75, 0, 3, 1.5, 3, COVER],
    [7, 1, 0, 2, 2, 3, ACCENT],
  ],
};

function emptySet(): CollisionSet {
  return { count: 0, tris: 0, prim: [], m: [] };
}

export function createPublicMap(map: MapId): { scene: THREE.Group; doc: CollisionDoc } {
  const scene = new THREE.Group();
  scene.name = `arena-${map}`;
  const materials = new Map<number, THREE.MeshStandardMaterial>();
  for (const [x, y, z, width, height, depth, color] of [...shell, ...layouts[map]]) {
    let material = materials.get(color);
    if (!material) {
      material = new THREE.MeshStandardMaterial({ color, roughness: 0.85 });
      materials.set(color, material);
    }
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
  scene.updateMatrixWorld(true);
  return {
    scene,
    doc: { map, space: 'world', prims: [], walkSets: ['pawn', 'greybox'],
      sets: { pawn: emptySet(), greybox: emptySet(), projectile: emptySet() } },
  };
}

function site(x: number, z: number): SiteData {
  return { center: [x, z], y: 0, box: { min: [x - 3, z - 3], max: [x + 3, z + 3] } };
}

export function getPublicMapData(map: MapId): MapData {
  const spawns = (x: number, yaw: number): P3[] => [-8, -4, 0, 4, 8].map((z) => ({ x, y: 0, z, yaw }));
  const attack = spawns(-20, -Math.PI / 2);
  const defend = spawns(20, Math.PI / 2);
  const sites: Record<string, SiteData> = { A: site(14, -12), B: site(14, 12) };
  if (map === 'jam' || map === 'triad') sites.C = site(13, 0);
  return {
    name: map,
    tdm: { BL: attack.map((p) => ({ ...p })), GR: defend.map((p) => ({ ...p })) },
    snd: { spawns: { attack: { spawns: attack }, defend: { spawns: defend } }, sites },
  };
}
