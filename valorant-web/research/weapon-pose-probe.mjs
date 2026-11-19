// UTF-8. Search the real Phantom pose against the imported Jett/Sage rigs.
// This probe never edits production files or changes arm bones/IK settings.
import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ViewArms } from '../src/view-arms.js';
import { createFirstPersonPhantom } from '../src/weapon-model.js';

globalThis.ProgressEvent ||= class { constructor(type, data) { Object.assign(this, { type, ...data }); } };

async function loadRig(name) {
  const bytes = fs.readFileSync(new URL(`../assets/agents/${name}.glb`, import.meta.url));
  const length = bytes.readUInt32LE(12), json = JSON.parse(bytes.toString('utf8', 20, 20 + length));
  const binary = bytes.subarray(28 + length, 28 + length + bytes.readUInt32LE(20 + length));
  delete json.images; delete json.textures;
  json.materials?.forEach(material => {
    delete material.pbrMetallicRoughness?.baseColorTexture;
    delete material.pbrMetallicRoughness?.metallicRoughnessTexture;
    delete material.normalTexture; delete material.emissiveTexture; delete material.occlusionTexture;
  });
  json.buffers[0].uri = 'data:application/octet-stream;base64,' + binary.toString('base64');
  return new GLTFLoader().parseAsync(JSON.stringify(json), '');
}

async function loadPhantom() {
  const base = new URL('../assets/weapons/res-phantom/', import.meta.url);
  const json = JSON.parse(fs.readFileSync(new URL('scene.gltf', base), 'utf8'));
  for (const buffer of json.buffers) {
    buffer.uri = 'data:application/octet-stream;base64,' + fs.readFileSync(new URL(buffer.uri, base)).toString('base64');
  }
  return new GLTFLoader().parseAsync(JSON.stringify(json), '');
}

function swingDegrees(hand, rest) {
  const delta = hand.quaternion.clone().multiply(rest.clone().invert()).normalize();
  const axis = hand.position.clone().normalize();
  const projection = delta.x * axis.x + delta.y * axis.y + delta.z * axis.z;
  const twist = new THREE.Quaternion(axis.x * projection, axis.y * projection, axis.z * projection, delta.w).normalize();
  const swing = delta.multiply(twist.invert()).normalize();
  return THREE.MathUtils.radToDeg(swing.angleTo(new THREE.Quaternion()));
}

const weaponBoundsCache = new WeakMap();
function evaluate(arms, camera, gunRoot, weapon, position, rotation) {
  gunRoot.position.copy(position);
  gunRoot.rotation.set(rotation.pitch, rotation.yaw, rotation.roll, 'XYZ');
  camera.updateMatrixWorld(true);
  arms.update(0);
  const data = {};
  let weaponBounds = weaponBoundsCache.get(weapon.group);
  if (!weaponBounds) { weaponBounds = localBounds(weapon.group); weaponBoundsCache.set(weapon.group, weaponBounds); }
  const muzzle = gunRoot.localToWorld(new THREE.Vector3(weaponBounds.getCenter(new THREE.Vector3()).x,
    weaponBounds.min.y + weaponBounds.getSize(new THREE.Vector3()).y * 0.75, weaponBounds.min.z));
  const muzzleNdc = muzzle.project(camera).toArray();
  const weaponNdcBounds = projectedBox(weaponBounds, weapon.group, camera);
  let maxSocketError = 0, maxShoulderY = -Infinity;
  for (const side of ['L', 'R']) {
    const shoulder = arms.bones[side + '_Shoulder'];
    const elbow = arms.bones[side + '_Elbow'];
    const hand = arms.bones[side + '_Hand'];
    const middle = arms.bones[side + '_Middle1'];
    const socket = arms.bones[side + '_WeaponPoint'].getWorldPosition(new THREE.Vector3());
    const anchor = weapon.anchors[side];
    const anchorPosition = anchor.getWorldPosition(new THREE.Vector3());
    const anchorRotation = anchor.getWorldQuaternion(new THREE.Quaternion());
    const socketError = socket.distanceTo(anchorPosition);
    maxSocketError = Math.max(maxSocketError, socketError);
    const elbowToWrist = hand.getWorldPosition(new THREE.Vector3()).sub(elbow.getWorldPosition(new THREE.Vector3())).normalize();
    const wristToPalm = middle.getWorldPosition(new THREE.Vector3()).sub(hand.getWorldPosition(new THREE.Vector3())).normalize();
    const palmAxisDeviation = THREE.MathUtils.radToDeg(elbowToWrist.angleTo(wristToPalm));
    const middleNdc = middle.getWorldPosition(new THREE.Vector3()).project(camera);
    const anchorNdc = anchorPosition.clone().project(camera);
    const handNdc = hand.getWorldPosition(new THREE.Vector3()).project(camera);
    const localShoulder = arms.root.worldToLocal(shoulder.getWorldPosition(new THREE.Vector3()));
    maxShoulderY = Math.max(maxShoulderY, localShoulder.y);
    data[side] = {
      swingDeg: swingDegrees(hand, arms.restRotations.get(hand)),
      palmAxisDeviationDeg: palmAxisDeviation,
      middleNdc: middleNdc.toArray(),
      handNdc: handNdc.toArray(),
      anchorNdc: anchorNdc.toArray(),
      wristAnchorAngleDeg: THREE.MathUtils.radToDeg(hand.getWorldQuaternion(new THREE.Quaternion()).angleTo(anchorRotation)),
      socketErrorMm: socketError * 1000,
      shoulderY: localShoulder.y,
      upperArmM: shoulder.getWorldPosition(new THREE.Vector3()).distanceTo(elbow.getWorldPosition(new THREE.Vector3())),
      forearmM: elbow.getWorldPosition(new THREE.Vector3()).distanceTo(hand.getWorldPosition(new THREE.Vector3()))
    };
  }
  return { position: position.toArray(), rotation, muzzleNdc, weaponNdcBounds, ...data, maxSocketErrorMm: maxSocketError * 1000, maxShoulderY };
}

function localBounds(root) {
  root.updateWorldMatrix(true, true);
  const inverse = root.matrixWorld.clone().invert(), box = new THREE.Box3();
  root.traverse(mesh => {
    if (!mesh.isMesh) return;
    const position = mesh.geometry.attributes.position, matrix = inverse.clone().multiply(mesh.matrixWorld);
    const point = new THREE.Vector3();
    for (let i = 0; i < position.count; i++) box.expandByPoint(point.fromBufferAttribute(position, i).applyMatrix4(matrix));
  });
  return box;
}

function projectedBox(bounds, root, camera) {
  const min = new THREE.Vector3(Infinity, Infinity, Infinity), max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  let count = 0;
  for (let mask = 0; mask < 8; mask++) {
    const point = root.localToWorld(new THREE.Vector3(mask & 1 ? bounds.max.x : bounds.min.x,
      mask & 2 ? bounds.max.y : bounds.min.y, mask & 4 ? bounds.max.z : bounds.min.z));
    if (camera.worldToLocal(point.clone()).z >= -0.1) continue;
    point.project(camera); min.min(point); max.max(point); count++;
  }
  if (!count) return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], clippedArea: 0 };
  const x0 = Math.max(-1, min.x), x1 = Math.min(1, max.x), y0 = Math.max(-1, min.y), y1 = Math.min(1, max.y);
  return { min: min.toArray(), max: max.toArray(), clippedArea: Math.max(0, x1 - x0) * Math.max(0, y1 - y0) };
}

const phantom = await loadPhantom();
const positionAxes = {
  x: [0.28, 0.29, 0.30, 0.31, 0.32],
  y: [-0.17, -0.165, -0.16],
  z: [-0.45, -0.445, -0.44, -0.435, -0.43, -0.425, -0.42]
};
const angleAxes = {
  yaw: [0.18, 0.19, 0.20],
  pitch: [-0.05, -0.025, 0, 0.025, 0.05],
  roll: [0.20, 0.225, 0.25, 0.275, 0.30]
};
const baselinePosition = new THREE.Vector3(0.24, -0.23, -0.4);
const baselineRotation = { yaw: 0, pitch: 0, roll: 0 };
const contexts = [];
for (const agent of ['jett', 'sage']) {
  const asset = await loadRig(agent);
  const camera = new THREE.PerspectiveCamera(76, 16 / 9, 0.06, 280);
  const arms = new ViewArms(asset, camera);
  arms.model.traverse(bone => { if (bone.isBone) for (const side of ['L', 'R']) if (new RegExp('^' + side + '_Middle1_\\d+$').test(bone.name)) arms.bones[side + '_Middle1'] = bone; });
  const weapon = createFirstPersonPhantom(phantom.scene);
  const gunRoot = new THREE.Group();
  camera.add(gunRoot); gunRoot.add(weapon.group); camera.updateMatrixWorld(true);
  arms.bindWeapon(weapon.anchors);

  contexts.push({ agent, arms, camera, gunRoot, weapon });
}

let baselineWeaponArea = 0, baselineMetrics;
function evaluateBoth(position, rotation) {
  const agents = contexts.map(c => ({ agent: c.agent, ...evaluate(c.arms, c.camera, c.gunRoot, c.weapon, position, rotation) }));
  const maxL = Math.max(...agents.map(a => a.L.palmAxisDeviationDeg));
  const meanR = agents.reduce((sum, a) => sum + a.R.palmAxisDeviationDeg, 0) / agents.length;
  const meanLSwing = agents.reduce((sum, a) => sum + a.L.swingDeg, 0) / agents.length;
  const maxR = Math.max(...agents.map(a => a.R.palmAxisDeviationDeg));
  return {
    position: position.toArray(), rotation, agents,
    score: Math.max(maxL, maxR),
    valid: agents.every(a => a.maxSocketErrorMm < 1 && a.maxShoulderY < -0.4 &&
      (!baselineMetrics || ['L', 'R'].every(side => a[side].palmAxisDeviationDeg <= baselineMetrics.find(b => b.agent === a.agent)[side].palmAxisDeviationDeg - 10)) &&
      (baselineWeaponArea === 0 || a.weaponNdcBounds.clippedArea >= baselineWeaponArea * 0.75) &&
      a.muzzleNdc[1] >= -0.35 && a.muzzleNdc[1] <= 0.1 && a.muzzleNdc[2] < 1 &&
      ['L', 'R'].every(side => Math.abs(a[side].anchorNdc[0]) < 0.98 && a[side].anchorNdc[1] > -0.95 && a[side].anchorNdc[1] < 0.15 &&
        Math.abs(a[side].handNdc[0]) < 0.98 && a[side].handNdc[1] > -0.85 && a[side].handNdc[1] < 0.1 &&
        Math.abs(a[side].middleNdc[0]) < 0.98 && a[side].middleNdc[1] > -0.85 && a[side].middleNdc[1] < 0.1 && a[side].middleNdc[2] < 1))
  };
}
let baseline = evaluateBoth(baselinePosition, baselineRotation);
baselineWeaponArea = baseline.agents[0].weaponNdcBounds.clippedArea;
baselineMetrics = baseline.agents;
if (process.argv.includes('--single')) {
  console.log(JSON.stringify(evaluateBoth(new THREE.Vector3(.34, -.18, -.43), { pitch: -.05, yaw: .2, roll: .3 }), null, 2));
  for (const c of contexts) { c.arms.dispose(); c.weapon.dispose(); c.gunRoot.removeFromParent(); }
  process.exit(0);
}
const candidates = [], byCategory = { moderate: [], lowRoll: [] };
for (const x of positionAxes.x) for (const y of positionAxes.y) for (const z of positionAxes.z)
  for (const yaw of angleAxes.yaw) for (const pitch of angleAxes.pitch) for (const roll of angleAxes.roll) {
    const candidate = evaluateBoth(new THREE.Vector3(x, y, z), { yaw, pitch, roll });
    if (candidate.valid) {
      candidates.push(candidate);
      if (roll <= 0.20) byCategory.moderate.push(candidate);
      if (roll <= 0.10) byCategory.lowRoll.push(candidate);
    }
  }
candidates.sort((a, b) => a.score - b.score);
const centers = [];
const refined = [...candidates];
for (const center of centers) {
  for (const dx of [-0.02, 0, 0.02]) for (const dy of [-0.01, 0, 0.01]) for (const dz of [-0.02, 0, 0.02])
    for (const da of [-0.025, 0, 0.025]) {
      const position = new THREE.Vector3(center.position[0] + dx, center.position[1] + dy, center.position[2] + dz);
      const rotation = { yaw: center.rotation.yaw + da, pitch: center.rotation.pitch + da, roll: center.rotation.roll + da };
      if (position.x < 0.08 || position.x > 0.36 || position.y < -0.22 || position.y > -0.16 || position.z < -0.57 || position.z > -0.29 || Math.abs(rotation.yaw) > 0.20 || Math.abs(rotation.pitch) > 0.175 || rotation.roll < 0 || rotation.roll > 0.30) continue;
      const candidate = evaluateBoth(position, rotation);
      if (candidate.valid) refined.push(candidate);
    }
}
refined.sort((a, b) => a.score - b.score);
function select(predicate) {
  return refined.find(candidate => predicate(candidate) && !selected.some(prior => new THREE.Vector3(...prior.position).distanceTo(new THREE.Vector3(...candidate.position)) < 0.045 &&
    Math.abs(prior.rotation.yaw - candidate.rotation.yaw) + Math.abs(prior.rotation.roll - candidate.rotation.roll) < 0.16));
}
const selected = [];
for (const predicate of [() => true]) {
  const candidate = select(predicate); if (candidate) selected.push(candidate);
}
function projectedBounds(root, camera, skinned) {
  root.updateWorldMatrix(true, true);
  const min = new THREE.Vector3(Infinity, Infinity, Infinity), max = new THREE.Vector3(-Infinity, -Infinity, -Infinity), p = new THREE.Vector3();
  root.traverse(mesh => {
    if (!mesh.isMesh) return;
    const g = mesh.geometry, position = g.attributes.position;
    const indices = skinned && g.index ? new Set(g.index.array) : null;
    for (const i of indices || { *[Symbol.iterator]() { for (let i = 0; i < position.count; i++) yield i; } }) {
      mesh.localToWorld(mesh.isSkinnedMesh ? mesh.getVertexPosition(i, p) : p.fromBufferAttribute(position, i));
      p.project(camera); min.min(p); max.max(p);
    }
  });
  return { min: min.toArray().map(v => +v.toFixed(4)), max: max.toArray().map(v => +v.toFixed(4)), area: +((max.x - min.x) * (max.y - min.y)).toFixed(4) };
}
const best = selected.map(candidate => {
  const perAgent = [];
  for (const c of contexts) {
    evaluate(c.arms, c.camera, c.gunRoot, c.weapon, new THREE.Vector3(...candidate.position), candidate.rotation);
    const hand = {};
    for (const side of ['L', 'R']) {
      const palm = c.arms.bones[side + '_Middle1'].getWorldPosition(new THREE.Vector3()).project(c.camera);
      hand[side] = palm.toArray().map(v => +v.toFixed(4));
    }
    perAgent.push({ agent: c.agent, armNdcBounds: projectedBounds(c.arms.model, c.camera, true), weaponNdcBounds: projectedBounds(c.weapon.group, c.camera, false), palmNdc: hand });
  }
  return { ...candidate, projectedBounds: perAgent };
});
const results = { constraints: { maxSocketErrorMm: 1, maxShoulderY: -0.4, handAndPalmNdcY: [-0.85, 0.1], gripAnchorNdcY: [-0.95, 0.15], muzzleNdcY: [-0.35, 0.1], minImprovementEverySideDeg: 10, positionAxes, angleAxes }, baseline, validCandidates: candidates.length, best };
fs.writeFileSync(new URL('./weapon-pose-probe-results.json', import.meta.url), JSON.stringify(results, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(results, null, 2));
for (const c of contexts) { c.arms.dispose(); c.weapon.dispose(); c.gunRoot.removeFromParent(); }
