// UTF-8. Verify reconstruction never loses, moves or duplicates source triangles.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { parseAscentGLB } from '../src/ascent-collision.mjs';
import { buildAscentSurfaceGeometry, createAscentSkyline, ASCENT_ENVIRONMENT_METADATA } from '../src/ascent-environment.js';
const source = parseAscentGLB(fs.readFileSync(new URL('../assets/maps/ascent-b.glb', import.meta.url))).geometry;
const originalPositions = source.attributes.position.array.slice(), originalIndices = source.index.array.slice();
const { geometry, statistics } = buildAscentSurfaceGeometry(source);
assert.equal(statistics.triangles, 192209);
assert.equal(geometry.index.count, source.index.count);
assert.deepEqual(source.attributes.position.array, originalPositions, 'collision positions remain untouched');
assert.deepEqual(source.index.array, originalIndices, 'collision triangle order remains untouched');
const visited = new Uint8Array(statistics.triangles);
for (let i = 0; i < geometry.index.count; i += 3) {
  const render = geometry.index.array[i], originalTriangle = render / 3;
  assert.ok(Number.isInteger(originalTriangle));
  assert.equal(visited[originalTriangle], 0, 'no duplicate rendering triangle'); visited[originalTriangle] = 1;
  for (let corner = 0; corner < 3; corner++) {
    const target = geometry.index.array[i + corner], input = source.index.array[render + corner];
    for (let axis = 0; axis < 3; axis++) assert.equal(geometry.attributes.position.array[target * 3 + axis], source.attributes.position.array[input * 3 + axis], 'world position preserved');
  }
}
assert.ok(visited.every(value => value === 1), 'all original triangles retained exactly once');
for (const value of geometry.attributes.uv.array) assert.ok(Number.isFinite(value));
assert.equal(geometry.groups.reduce((sum, group) => sum + group.count, 0), source.index.count);
assert.ok(statistics.materialTriangles.roof >= 60, 'audited roof components receive roof reconstruction');
assert.equal(statistics.materialTriangles.wood, 26, 'only audited door entity receives wood');
assert.ok(statistics.materialTriangles.paving > 248, 'real floor geometry receives paving');
assert.match(ASCENT_ENVIRONMENT_METADATA.materialStatus, /Reconstructed/);
function snapshotSkyline(root) {
  root.updateMatrixWorld(true); const materials = new Map(); let meshes = 0, triangles = 0;
  root.traverse(mesh => {
    if (!mesh.isMesh) return;
    meshes++; const g = mesh.geometry, count = g.index?.count || g.attributes.position.count; triangles += count / 3;
    let data = materials.get(mesh.material.name); if (!data) { data = { positions: [], normals: [], uv: [], color: mesh.material.color.getHex(), roughness: mesh.material.roughness, metalness: mesh.material.metalness, flatShading: mesh.material.flatShading, side: mesh.material.side }; materials.set(mesh.material.name, data); }
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    for (let i = 0; i < count; i++) {
      const index = g.index ? g.index.getX(i) : i;
      data.positions.push(...new THREE.Vector3().fromBufferAttribute(g.attributes.position, index).applyMatrix4(mesh.matrixWorld).toArray());
      data.normals.push(...new THREE.Vector3().fromBufferAttribute(g.attributes.normal, index).applyNormalMatrix(normalMatrix).toArray());
      data.uv.push(g.attributes.uv.getX(index), g.attributes.uv.getY(index));
    }
  }); return { materials, meshes, triangles };
}
const originalSky = createAscentSkyline({merge:false}), mergedSky = createAscentSkyline();
// The containing environment may itself be transformed; verify world coordinates
// after nonidentity translation, rotation and scale as well as original offsets.
for (const sky of [originalSky, mergedSky]) { sky.root.position.set(2, -3, 4); sky.root.rotation.set(.02, .3, -.01); sky.root.scale.setScalar(1.1); }
const beforeSky = snapshotSkyline(originalSky.root), afterSky = snapshotSkyline(mergedSky.root);
assert.equal(beforeSky.meshes,45);assert.equal(afterSky.meshes,2);assert.equal(afterSky.triangles,beforeSky.triangles);
let maximumWorldPositionError = 0, maximumWorldNormalError = 0;
for (const [material, before] of beforeSky.materials) {
  const after = afterSky.materials.get(material); assert.ok(after, 'same original material retained');
  for (const property of ['color','roughness','metalness','flatShading','side']) assert.equal(after[property],before[property]);
  assert.deepEqual(after.uv,before.uv,'all original per-triangle UV values retained'); assert.equal(after.positions.length,before.positions.length);
  for (let i=0;i<before.positions.length;i++) maximumWorldPositionError=Math.max(maximumWorldPositionError,Math.abs(after.positions[i]-before.positions[i]));
  for (let i=0;i<before.normals.length;i++) maximumWorldNormalError=Math.max(maximumWorldNormalError,Math.abs(after.normals[i]-before.normals[i]));
}
assert.ok(maximumWorldPositionError<.00003,'world vertex coordinates differ only by Float32 transform baking precision');
assert.ok(maximumWorldNormalError<.000001,'world normals retain original shading');
statistics.skyline = {...mergedSky.statistics, maximumWorldPositionError, maximumWorldNormalError};
for (const sky of [originalSky,mergedSky]) { const materials=new Set();sky.root.traverse(mesh=>{if(mesh.isMesh){mesh.geometry.dispose();materials.add(mesh.material);}});materials.forEach(material=>material.dispose()); }
fs.writeFileSync(new URL('./ascent-environment-results.json', import.meta.url), JSON.stringify(statistics, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(statistics, null, 2));
console.log('Ascent material geometry preservation self-test passed.');
geometry.dispose(); source.dispose();
