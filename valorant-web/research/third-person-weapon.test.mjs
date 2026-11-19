import fs from 'node:fs';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { attachThirdPersonWeapon } from '../src/third-person-weapon.js';
import { MotionController } from '../src/character-motion.js';

globalThis.ProgressEvent ||= class { constructor(type, data) { Object.assign(this, { type, ...data }); } };
async function character(name) {
  const bytes = fs.readFileSync(new URL(`../assets/agents/${name}.glb`, import.meta.url));
  const n = bytes.readUInt32LE(12), json = JSON.parse(bytes.toString('utf8', 20, 20 + n));
  delete json.images; delete json.textures;
  json.materials?.forEach(m => {
    delete m.pbrMetallicRoughness?.baseColorTexture; delete m.pbrMetallicRoughness?.metallicRoughnessTexture;
    delete m.normalTexture; delete m.emissiveTexture; delete m.occlusionTexture;
  });
  json.buffers[0].uri = 'data:application/octet-stream;base64,' + bytes.subarray(28 + n, 28 + n + bytes.readUInt32LE(20 + n)).toString('base64');
  return new GLTFLoader().parseAsync(JSON.stringify(json), '');
}
async function rifle() {
  const json = JSON.parse(fs.readFileSync(new URL('../assets/weapons/res-phantom/scene.gltf', import.meta.url), 'utf8'));
  for (const buffer of json.buffers) buffer.uri = 'data:application/octet-stream;base64,' + fs.readFileSync(new URL('../assets/weapons/res-phantom/' + buffer.uri, import.meta.url)).toString('base64');
  return new GLTFLoader().parseAsync(JSON.stringify(json), '');
}
function rotations(model) { const result = new Map(); model.traverse(o => { if (o.isBone) result.set(o.name, o.quaternion.clone()); }); return result; }
function difference(a, b) { return 1 - Math.min(1, Math.abs(a.dot(b)) / Math.sqrt(a.lengthSq() * b.lengthSq())); }
function finite(root) { root.updateWorldMatrix(true, true); root.traverse(o => { for (const n of [...o.position, ...o.quaternion, ...o.scale, ...o.matrixWorld.elements]) assert.ok(Number.isFinite(n), `${o.name} invalid transform`); }); }
let checks = 0;
function test(name, fn) { fn(); checks++; console.log('PASS ' + name); }

const source = await rifle(), sourceTransforms = source.scene.toJSON().object;
const sourceResources = new Set(); let sourceMeshes = 0;
source.scene.traverse(o => { if (o.isMesh) { sourceMeshes++; sourceResources.add(o.geometry); } });
let disposedSourceResources = 0;
for (const geometry of sourceResources) geometry.addEventListener('dispose', () => disposedSourceResources++);

for (const name of ['jett', 'sage']) {
  const asset = await character(name), model = cloneSkeleton(asset.scene);
  const mixer = new THREE.AnimationMixer(model); mixer.clipAction(asset.animations[0]).play(); mixer.update(0);
  model.updateWorldMatrix(true, true);
  // SkeletonUtils clones retain mesh.bindMode='attached'. Use the freshly
  // loaded asset's pre-clone bounds, as the production loader does, rather
  // than a stale detached clone's skinned bounds.
  asset.scene.updateWorldMatrix(true, true);
  const bounds = new THREE.Box3().setFromObject(asset.scene), height = bounds.getSize(new THREE.Vector3()).y;
  model.scale.setScalar(1.82 / height);
  const parent = new THREE.Group(); parent.position.set(-4, 0.5, 8); parent.rotation.y = 0.93; parent.add(model); model.updateWorldMatrix(true, true);
  const baseRotations = rotations(model), baseScale = model.scale.clone();
  const controller = new MotionController(model);
  const attachment = attachThirdPersonWeapon(model, source);

  test(`${name}: API binds real Phantom meshes below the real right-hand grip`, () => {
    assert.equal(typeof attachment.update, 'function'); assert.equal(typeof attachment.dispose, 'function');
    assert.match(attachment.rightHand.name, /^R_Hand_\d+$/);
    assert.match(attachment.gripBone.name, /^R_WeaponPoint_\d+$/);
    assert.equal(attachment.root.parent, attachment.gripBone);
    assert.equal(attachment.gripBone.parent, attachment.rightHand);
    assert.equal(attachment.metadata.originalMeshCount, sourceMeshes);
    let count = 0, triangles = 0; attachment.weapon.traverse(o => { if (o.isMesh) { count++; triangles += (o.geometry.index?.count || o.geometry.attributes.position.count) / 3; assert.ok(!sourceResources.has(o.geometry)); } });
    assert.ok(count < sourceMeshes, 'weapon meshes were not batched');
    assert.equal(count, attachment.metadata.renderMeshCount);
    assert.equal(triangles, attachment.metadata.triangles);
    assert.equal(attachment.metadata.authoredAnimation, false);
  });

  test(`${name}: muzzle-stock axis is exactly 0.91m and points toward the character's face direction`, () => {
    const { muzzle, stock } = attachment.anchors;
    const tip = muzzle.getWorldPosition(new THREE.Vector3()), butt = stock.getWorldPosition(new THREE.Vector3());
    assert.ok(Math.abs(tip.distanceTo(butt) - 0.91) < 0.0001, 'weapon length normalization failed');
    let head; model.traverse(o => { if (/^Head_\d+$/.test(o.name)) head = o; });
    const direction = new THREE.Vector3(0, 0, 1).applyQuaternion(head.getWorldQuaternion(new THREE.Quaternion())); direction.y = 0; direction.normalize();
    assert.ok(tip.sub(butt).normalize().dot(direction) > 0.99, 'muzzle points backwards or sideways');
    const grip = attachment.anchors.grip.getWorldPosition(new THREE.Vector3());
    assert.ok(grip.distanceTo(attachment.gripBone.getWorldPosition(new THREE.Vector3())) < 1e-7);
    const handDistance = grip.distanceTo(attachment.rightHand.getWorldPosition(new THREE.Vector3()));
    assert.ok(handDistance < 0.12, `trigger grip detached from hand: ${handDistance}m (character scale ${model.scale.y})`);
  });

  test(`${name}: left WeaponPoint reaches the handguard without altering bone lengths or model scale`, () => {
    let socket; model.traverse(o => { if (/^L_WeaponPoint_\d+$/.test(o.name)) socket = o; });
    const support = attachment.anchors.support.getWorldPosition(new THREE.Vector3());
    const gripError = socket.getWorldPosition(new THREE.Vector3()).distanceTo(support);
    assert.ok(gripError < 0.025, `left palm does not reach support grip: ${gripError}m`);
    assert.deepEqual(model.scale.toArray(), baseScale.toArray());
    finite(model);
  });

  test(`${name}: weapon follows moving and turning hands, remains finite during locomotion`, () => {
    for (let i = 0; i < 240; i++) {
      parent.rotation.y += 0.01; parent.position.x += 0.003;
      mixer.update(1 / 60); controller.update(1 / 60, { speed: 4.5, crouch: i % 160 > 140, grounded: i % 120 < 110, casting: i % 100 > 85, shooting: i % 7 === 0 });
      attachment.update({ casting: i % 100 > 85, pitch: Math.sin(i / 60) * 0.2 });
      const grip = attachment.anchors.grip.getWorldPosition(new THREE.Vector3());
      assert.ok(grip.distanceTo(attachment.gripBone.getWorldPosition(new THREE.Vector3())) < 1e-6);
      assert.ok(Math.abs(attachment.anchors.muzzle.getWorldPosition(new THREE.Vector3()).distanceTo(attachment.anchors.stock.getWorldPosition(new THREE.Vector3())) - 0.91) < 0.0002);
      if (i % 40 === 0) finite(model);
    }
  });

  test(`${name}: raised and lowered aim preserve the authored palm roll relative to the rifle`, () => {
    attachment.restoreSupportHand(); controller.reset(); mixer.setTime(0);
    const localPalm = () => attachment.root.getWorldQuaternion(new THREE.Quaternion()).invert()
      .multiply(attachment.leftHand.getWorldQuaternion(new THREE.Quaternion()));
    attachment.update();
    const reference = localPalm();
    for (const pitch of [-.65, -.25, .25, .65, 0]) {
      attachment.restoreSupportHand();
      controller.update(1 / 60, { aimPitch: pitch });
      attachment.update({ pitch });
      const { muzzle, stock } = attachment.anchors;
      const direction = muzzle.getWorldPosition(new THREE.Vector3()).sub(stock.getWorldPosition(new THREE.Vector3())).normalize();
      assert.ok(Math.abs(direction.y - Math.sin(pitch)) < 1e-5, 'the rifle aims opposite to the character pitch');
      assert.ok(localPalm().angleTo(reference) < .001, 'support palm spins independently of the rifle');
    }
    attachment.restoreSupportHand(); controller.reset();
  });

  test(`${name}: casting releases procedural left hand and disposal preserves shared weapon resources`, () => {
    controller.reset(); mixer.setTime(0);
    const before = rotations(model);
    attachment.update({ casting: true });
    for (const key of ['L_Shoulder', 'L_Elbow', 'L_Hand']) {
      const entry = [...before].find(([name]) => new RegExp(`^${key}_\\d+$`).test(name));
      let bone; model.traverse(o => { if (o.name === entry[0]) bone = o; });
      assert.ok(difference(bone.quaternion, entry[1]) < 1e-7, 'cast arm overwritten by weapon support IK');
    }
    attachment.update(); attachment.dispose(); attachment.dispose();
    assert.equal(attachment.root.parent, null);
    assert.equal(disposedSourceResources, 0);
    assert.deepEqual(model.scale.toArray(), baseScale.toArray());
    assert.deepEqual(source.scene.toJSON().object, sourceTransforms, 'source hierarchy mutated');
    controller.dispose();
    for (const value of baseRotations.values()) assert.ok(value.toArray().every(Number.isFinite));
  });
}

test('missing right-hand rig rejects attachment rather than using a fake body socket', () => {
  assert.throws(() => attachThirdPersonWeapon(new THREE.Group(), source), /right-hand bone/);
});
console.log(`\n${checks} real third-person Phantom attachment checks passed.`);
