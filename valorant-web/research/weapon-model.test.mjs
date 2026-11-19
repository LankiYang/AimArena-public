// UTF-8. Verify batching against the actual RES Phantom artist geometry/materials.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createPhantomModel } from '../src/weapon-model.js';

globalThis.ProgressEvent ||= class { constructor(type, data) { Object.assign(this, { type, ...data }); } };
const sourceUrl = new URL('../assets/weapons/res-phantom/scene.gltf', import.meta.url);
const json = JSON.parse(fs.readFileSync(sourceUrl, 'utf8'));
assert.equal(json.images?.length || 0, 0, 'The actual asset must remain texture-free for this headless loader');
for (const buffer of json.buffers) {
  const bytes = fs.readFileSync(new URL(buffer.uri, sourceUrl));
  assert.equal(bytes.byteLength, buffer.byteLength, 'Actual external binary length');
  buffer.uri = 'data:application/octet-stream;base64,' + bytes.toString('base64');
}
const asset = await new GLTFLoader().parseAsync(JSON.stringify(json), '');
const f32 = Math.fround;
const tolerance = 2e-6;

function meshList(root) {
  const result = []; root.traverse(node => { if (node.isMesh) result.push(node); }); return result;
}

function materialResponse(material) {
  return {
    type: material.type, roughness: material.roughness, metalness: material.metalness,
    emissive: material.emissive?.toArray() || [], emissiveIntensity: material.emissiveIntensity,
    side: material.side, flatShading: material.flatShading,
    transparent: material.transparent, opacity: material.opacity,
    depthWrite: material.depthWrite, blending: material.blending
  };
}

function nearArray(actual, expected, label) {
  assert.equal(actual.length, expected.length, label + ' component count');
  for (let i = 0; i < actual.length; i++) assert.ok(Math.abs(actual[i] - expected[i]) <= tolerance * Math.max(1, Math.abs(expected[i])), `${label}[${i}]: ${actual[i]} vs ${expected[i]}`);
}

// Triangle identity uses exact Float32 world positions, including winding.
// Colours and materials are checked separately so an accidental colour/material
// swap between coincident surfaces cannot silently pass a vertex-only hash.
function triangleRecords(root) {
  root.updateWorldMatrix(true, true);
  const records = new Map(); let triangles = 0, meshes = 0, sourceColoredMeshes = 0;
  const point = new THREE.Vector3(), normal = new THREE.Vector3(), normalMatrix = new THREE.Matrix3();
  for (const node of meshList(root)) {
    meshes++; assert.ok(!Array.isArray(node.material), 'The actual source has single-material primitives');
    const geometry = node.geometry, position = geometry.getAttribute('position'), normals = geometry.getAttribute('normal'), colors = geometry.getAttribute('color'), uv = geometry.getAttribute('uv'), material = node.material;
    if (colors) sourceColoredMeshes++;
    normalMatrix.getNormalMatrix(node.matrixWorld);
    const count = geometry.index?.count || position.count;
    assert.equal(count % 3, 0, 'All actual source primitives are triangles');
    for (let offset = 0; offset < count; offset += 3) {
      const positions = [], values = [];
      for (let corner = 0; corner < 3; corner++) {
        const index = geometry.index ? geometry.index.getX(offset + corner) : offset + corner;
        point.fromBufferAttribute(position, index).applyMatrix4(node.matrixWorld);
        positions.push(f32(point.x), f32(point.y), f32(point.z));
        assert.ok(normals, 'Artist normals must be available');
        normal.fromBufferAttribute(normals, index).applyNormalMatrix(normalMatrix);
        values.push(f32(normal.x), f32(normal.y), f32(normal.z));
        // glTF baseColorFactor is already linear in GLTFLoader. No sRGB roundtrip.
        const color = colors && material.vertexColors ? [colors.getX(index), colors.getY(index), colors.getZ(index)] : [1, 1, 1];
        values.push(material.color.r * color[0], material.color.g * color[1], material.color.b * color[2]);
        values.push(uv ? uv.getX(index) : 0, uv ? uv.getY(index) : 0);
      }
      const key = positions.join(','), record = { values, response: materialResponse(material) };
      if (!records.has(key)) records.set(key, []);
      records.get(key).push(record); triangles++;
    }
  }
  return { records, triangles, meshes, sourceColoredMeshes };
}

function sameResponse(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function sameValues(a, b) { return a.length === b.length && a.every((value, i) => Math.abs(value - b[i]) <= tolerance * Math.max(1, Math.abs(b[i]))); }

function verifyBatching(source, label) {
  const expected = triangleRecords(source);
  const sourceBounds = new THREE.Box3().setFromObject(source, true), sourceLength = Math.max(...sourceBounds.getSize(new THREE.Vector3()).toArray());
  const sourceState = meshList(source).map(mesh => ({ geometry: mesh.geometry, position: mesh.geometry.attributes.position.array.slice(), material: mesh.material, color: mesh.material.color.toArray(), response: materialResponse(mesh.material) }));
  const batched = createPhantomModel(source);
  try {
    const actual = triangleRecords(batched.group);
    assert.equal(actual.triangles, expected.triangles, label + ': no lost or added triangles');
    assert.equal(batched.stats.triangles, expected.triangles, label + ': reported triangle count');
    assert.equal(batched.stats.sourceMeshes, expected.meshes, label + ': reported source mesh count');
    assert.equal(batched.stats.drawCalls, actual.meshes, label + ': reported draw calls');
    assert.ok(actual.meshes < expected.meshes, label + ': actual mesh draw calls decrease');
    for (const [key, expectedTriangles] of expected.records) {
      const actualTriangles = actual.records.get(key);
      assert.ok(actualTriangles, label + ': original world-space triangle positions/winding retained');
      assert.equal(actualTriangles.length, expectedTriangles.length, label + ': coincident triangle multiplicity retained');
      for (const expectedTriangle of expectedTriangles) {
        const found = actualTriangles.findIndex(candidate => sameResponse(candidate.response, expectedTriangle.response) && sameValues(candidate.values, expectedTriangle.values));
        assert.notEqual(found, -1, label + ': per-corner linear baseColor × vertexColor, normals, UVs, roughness, metalness and emissive response preserved');
        const [candidate] = actualTriangles.splice(found, 1);
        nearArray(candidate.values, expectedTriangle.values, label + ': corner attributes');
        assert.deepEqual(candidate.response, expectedTriangle.response, label + ': material response');
      }
      actual.records.delete(key);
    }
    assert.equal(actual.records.size, 0, label + ': no extra world-space triangles');
    const outputBounds = new THREE.Box3().setFromObject(batched.group, true);
    nearArray(outputBounds.min.toArray(), sourceBounds.min.toArray(), label + ': bounds minimum');
    nearArray(outputBounds.max.toArray(), sourceBounds.max.toArray(), label + ': bounds maximum');
    assert.ok(Math.abs(batched.length - sourceLength) <= tolerance * Math.max(1, sourceLength), label + ': maximum model length unchanged');
    meshList(source).forEach((mesh, index) => {
      const before = sourceState[index];
      assert.equal(mesh.geometry, before.geometry, 'Source geometry object was not replaced');
      assert.deepEqual(mesh.geometry.attributes.position.array, before.position, 'Source vertices were not edited');
      assert.equal(mesh.material, before.material, 'Source material object was not replaced');
      assert.deepEqual(mesh.material.color.toArray(), before.color, 'Source base colour was not edited');
      assert.deepEqual(materialResponse(mesh.material), before.response, 'Source material response was not edited');
    });
    console.log(JSON.stringify({ label, sourceMeshes: expected.meshes, sourceColoredMeshes: expected.sourceColoredMeshes, triangles: expected.triangles, drawCalls: actual.meshes, length: batched.length, materialAndCornerTolerance: tolerance }));
  } finally { batched.dispose(); }
}

test('actual Radiant Entertainment Phantom batching retains artist shape and linear material colour', () => {
  assert.equal(meshList(asset.scene).length, 72, 'Testing the intended actual 72-mesh Phantom asset');
  verifyBatching(asset.scene, 'actual RES Phantom');
});

test('actual Phantom geometry with explicit vertex colours retains the linear colour product', () => {
  // The real asset currently has no COLOR_0. Exercise that otherwise-uncovered
  // branch on cloned real geometry, without changing the artist asset or source.
  const colored = asset.scene.clone(true);
  for (const mesh of meshList(colored)) {
    mesh.geometry = mesh.geometry.clone(); mesh.material = mesh.material.clone(); mesh.material.vertexColors = true;
    const positions = mesh.geometry.attributes.position, colors = new Float32Array(positions.count * 3);
    for (let i = 0; i < positions.count; i++) colors.set([0.15 + (i % 11) / 14, 0.25 + (i % 7) / 12, 0.35 + (i % 5) / 10], i * 3);
    mesh.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  try { verifyBatching(colored, 'real geometry + explicit linear COLOR_0 fixture'); }
  finally { for (const mesh of meshList(colored)) { mesh.geometry.dispose(); mesh.material.dispose(); } }
});
