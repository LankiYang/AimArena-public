import * as THREE from 'three';
import type { MapId } from '../../shared/catalog.ts';

/** Solid-color skies are generated locally and require no image assets. */
export function installSky(scene: THREE.Scene, map: MapId): void {
  const colors: Record<string, number> = { ascent: 0x728ba5, bonsai: 0x678e9b, triad: 0x8599aa, plummet: 0x9ab5c4, infinity: 0x18263d, jam: 0x4c596a };
  scene.background = new THREE.Color(colors[map] ?? 0x718899);
}
