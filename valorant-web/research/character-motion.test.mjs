import fs from 'node:fs';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { MotionController } from '../src/character-motion.js';

// Parse the real assets without browser image APIs; geometry, skin weights,
// hierarchy and animation tracks remain exactly those of the source GLBs.
globalThis.ProgressEvent ||= class { constructor(type, data) { Object.assign(this, { type, ...data }); } };
async function loadAsset(name) {
  const bytes = fs.readFileSync(new URL(`../assets/agents/${name}.glb`, import.meta.url));
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength));
  const offset = 20 + jsonLength + 8, binaryLength = bytes.readUInt32LE(20 + jsonLength);
  delete json.images; delete json.textures;
  json.materials?.forEach(material => {
    delete material.pbrMetallicRoughness?.baseColorTexture;
    delete material.pbrMetallicRoughness?.metallicRoughnessTexture;
    delete material.normalTexture; delete material.emissiveTexture; delete material.occlusionTexture;
  });
  json.buffers[0].uri = 'data:application/octet-stream;base64,' + bytes.subarray(offset, offset + binaryLength).toString('base64');
  return new GLTFLoader().parseAsync(JSON.stringify(json), '');
}

function prepare(asset) {
  const model = cloneSkeleton(asset.scene);
  const mixer = new THREE.AnimationMixer(model);
  if (asset.animations[0]) mixer.clipAction(asset.animations[0]).play();
  mixer.update(0); model.updateMatrixWorld(true);
  const parent = new THREE.Group();
  parent.position.set(8, 0.4, -6); parent.rotation.y = 0.73; parent.add(model);
  const bounds = new THREE.Box3().setFromObject(model);
  model.scale.setScalar(1.82 / bounds.getSize(new THREE.Vector3()).y);
  model.updateWorldMatrix(true, true);
  return { model, mixer, controller: new MotionController(model) };
}

function pose(model) {
  const result = new Map();
  model.traverse(node => {
    if (node.isBone) result.set(node.name, { p: node.position.clone(), q: node.quaternion.clone(), s: node.scale.clone() });
  });
  return result;
}

function rotationDifference(a, b) {
  return 1 - Math.min(1, Math.abs(a.dot(b)) / Math.sqrt(a.lengthSq() * b.lengthSq()));
}

function assertRestored(model, original, tolerance = 1e-8) {
  model.traverse(node => {
    if (!node.isBone) return;
    const base = original.get(node.name);
    assert.ok(node.position.distanceTo(base.p) < tolerance, `${node.name} position failed to restore`);
    assert.ok(rotationDifference(node.quaternion, base.q) < tolerance, `${node.name} rotation failed to restore`);
    assert.deepEqual(node.scale.toArray(), base.s.toArray(), `${node.name} scale changed`);
  });
}

function boneDistances(controller) {
  return controller.legs.flatMap(leg => {
    const a = leg.hip.getWorldPosition(new THREE.Vector3()), b = leg.knee.getWorldPosition(new THREE.Vector3()), c = leg.foot.getWorldPosition(new THREE.Vector3());
    return [a.distanceTo(b), b.distanceTo(c)];
  });
}

function assertRigFinite(model, original, bodyRoot) {
  model.updateWorldMatrix(true, true);
  model.traverse(node => {
    for (const value of [...node.position, ...node.quaternion, ...node.scale, ...node.matrixWorld.elements]) assert.ok(Number.isFinite(value), `${node.name} contains non-finite transforms`);
    if (node.isBone) {
      const base = original.get(node.name);
      assert.deepEqual(node.scale.toArray(), base.s.toArray(), `${node.name} scale changed`);
      if (node !== bodyRoot) assert.ok(node.position.distanceTo(base.p) < 1e-8, `${node.name} local bone length changed`);
      assert.ok(Math.abs(node.quaternion.length() - 1) < 1e-5, `${node.name} quaternion not normalized`);
    }
    if (node.isSkinnedMesh) {
      node.skeleton.update();
      const position = node.geometry.attributes.position;
      for (let i = 0; i < position.count; i += Math.max(1, Math.floor(position.count / 120))) {
        const point = new THREE.Vector3().fromBufferAttribute(position, i);
        node.applyBoneTransform(i, point);
        assert.ok(point.toArray().every(Number.isFinite), `${node.name} skin deformation not finite`);
        assert.ok(point.length() < 20, `${node.name} mesh exploded`);
      }
    }
  });
}

let checks = 0;
function test(name, fn) { fn(); checks++; console.log('PASS ' + name); }

for (const name of ['jett', 'sage']) {
  const asset = await loadAsset(name);
  const { model, mixer, controller } = prepare(asset);
  const rest = pose(model), segments = boneDistances(controller);
  const modelTransform = { p: model.position.clone(), q: model.quaternion.clone(), s: model.scale.clone() };

  test(`${name}: discovers both real leg chains, excluding helper joints`, () => {
    assert.equal(controller.enabled, true);
    assert.equal(controller.legs.length, 2);
    for (const leg of controller.legs) {
      assert.equal(leg.knee.parent, leg.hip); assert.equal(leg.foot.parent, leg.knee);
      assert.ok(!/Twst|Ndl|IK|end/.test(leg.foot.name));
    }
    assert.ok(controller.bodyRoot?.isBone);
    assert.equal(model.userData.proceduralMotion.authoredAnimation, false);
  });

  test(`${name}: idle preserves the original imported holding pose`, () => {
    for (let i = 0; i < 120; i++) controller.update(1 / 60, { speed: 0, grounded: true });
    assertRestored(model, rest);
  });

  test(`${name}: walking uses opposite leg phases and repeats without drift`, () => {
    for (let i = 0; i < 360; i++) controller.update(1 / 60, { speed: 2.8, forward: 1 });
    const first = pose(model), ankleStart = controller.legs.map(leg => leg.foot.getWorldPosition(new THREE.Vector3()));
    const period = 1 / controller.gait.frequency;
    const samples = [];
    for (let i = 0; i < 120; i++) {
      controller.update(period / 120, { speed: 2.8, forward: 1 });
      samples.push(controller.legs.map(leg => leg.foot.getWorldPosition(new THREE.Vector3())));
    }
    for (const leg of controller.legs) {
      assert.ok(rotationDifference(leg.hip.quaternion, first.get(leg.hip.name).q) < 1e-6, 'full gait cycle did not return');
      assert.ok(rotationDifference(leg.knee.quaternion, first.get(leg.knee.name).q) < 1e-6, 'knee cycle did not return');
    }
    for (let leg = 0; leg < 2; leg++) {
      assert.ok(samples.some(frame => frame[leg].distanceTo(ankleStart[leg]) > 0.15), 'foot never strides');
      const ys = samples.map(frame => frame[leg].y);
      assert.ok(Math.max(...ys) - Math.min(...ys) > 0.025, 'foot never lifts during swing');
    }
    assert.ok(samples.some(frame => Math.abs(frame[0].y - frame[1].y) > 0.025), 'feet move identically rather than alternating');
  });

  test(`${name}: running increases cadence, and strafe/backward poses remain bounded`, () => {
    const walkingCadence = controller.gait.frequency;
    for (const direction of [{ forward: 1, strafe: 0 }, { forward: -1, strafe: 0 }, { forward: 0, strafe: 1 }, { forward: 0.7, strafe: -0.7 }]) {
      for (let i = 0; i < 120; i++) controller.update(1 / 60, { speed: 5.2, ...direction });
      assertRigFinite(model, rest, controller.bodyRoot);
      boneDistances(controller).forEach((distance, i) => assert.ok(Math.abs(distance - segments[i]) < 1e-6, 'IK changed bone length'));
    }
    assert.ok(controller.gait.frequency > walkingCadence);
    assert.deepEqual(model.position.toArray(), modelTransform.p.toArray());
    assert.deepEqual(model.scale.toArray(), modelTransform.s.toArray());
    assert.deepEqual(model.quaternion.toArray(), modelTransform.q.toArray());
  });

  test(`${name}: crouch lowers the skeleton, bends legs and keeps feet planted without squash`, () => {
    controller.reset();
    const before = controller.bodyRoot.getWorldPosition(new THREE.Vector3());
    const footY = controller.legs.map(leg => leg.foot.getWorldPosition(new THREE.Vector3()).y);
    for (let i = 0; i < 180; i++) controller.update(1 / 60, { speed: 0, crouch: true });
    const after = controller.bodyRoot.getWorldPosition(new THREE.Vector3());
    assert.ok(before.y - after.y > 0.25, 'crouch did not lower the body');
    controller.legs.forEach((leg, i) => assert.ok(Math.abs(leg.foot.getWorldPosition(new THREE.Vector3()).y - footY[i]) < 0.015, 'crouch foot slid vertically'));
    assertRigFinite(model, rest, controller.bodyRoot);
    for (let i = 0; i < 240; i++) controller.update(1 / 60, { speed: 0, crouch: false });
    assertRestored(model, rest);
  });

  test(`${name}: jumping tucks feet, landing settles, and action overlays restore`, () => {
    controller.reset();
    const baseline = controller.legs.map(leg => leg.foot.getWorldPosition(new THREE.Vector3()).y);
    for (let i = 0; i < 90; i++) controller.update(1 / 60, { grounded: false, speed: 0 });
    controller.legs.forEach((leg, i) => assert.ok(leg.foot.getWorldPosition(new THREE.Vector3()).y > baseline[i] + 0.08, 'airborne leg did not tuck'));
    controller.update(1 / 60, { grounded: true });
    assert.ok(controller.landing > 0.5, 'landing transition missing');
    for (let i = 0; i < 180; i++) controller.update(1 / 60, {});
    const shoulder = controller.bones.L_Shoulder, baseShoulder = shoulder.quaternion.clone();
    for (let i = 0; i < 30; i++) controller.update(1 / 60, { casting: 'heal', time: i / 60 });
    assert.ok(rotationDifference(shoulder.quaternion, baseShoulder) > 0.003, 'casting did not affect the real arm');
    controller.triggerHit(1, -1);
    controller.update(1 / 60, { shooting: true, casting: false });
    assert.ok(controller.hitWeight > 0.5 && controller.recoil > 0.5);
    assertRigFinite(model, rest, controller.bodyRoot);
    for (let i = 0; i < 300; i++) controller.update(1 / 60, {});
    assertRestored(model, rest);
  });

  test(`${name}: long mixer playback stays finite, retains real animation and resets cleanly`, () => {
    const reference = prepare(asset);
    for (let i = 0; i < 600; i++) {
      mixer.update(1 / 60); reference.mixer.update(1 / 60);
      controller.update(1 / 60, { speed: i % 240 < 120 ? 4.8 : 0, crouch: i % 180 > 150, grounded: i % 210 < 190, shooting: i % 13 === 0, casting: i % 150 > 130 });
      if (i % 80 === 0) assertRigFinite(model, rest, controller.bodyRoot);
    }
    controller.reset();
    assertRestored(model, pose(reference.model), 1e-6);
    assertRigFinite(model, rest, controller.bodyRoot);
    reference.controller.dispose();
  });

  test(`${name}: invalid input cannot corrupt rig transforms; disposal restores the base`, () => {
    controller.update(NaN, { speed: Infinity, forward: NaN, strafe: Infinity, time: NaN });
    controller.update(100, { speed: 100000, forward: -100, strafe: 100, crouch: true, grounded: false });
    assertRigFinite(model, rest, controller.bodyRoot);
    controller.dispose();
    assert.equal(model.userData.proceduralMotion, undefined);
    assert.deepEqual(model.scale.toArray(), modelTransform.s.toArray());
  });
}

test('incomplete rigs remain intact and explicitly report missing locomotion joints', () => {
  const model = new THREE.Group(), bone = new THREE.Bone(); bone.name = 'Head_01'; model.add(bone);
  const before = pose(model), controller = new MotionController(model);
  assert.equal(controller.enabled, false);
  assert.equal(controller.metadata.completeLegRig, false);
  controller.update(1 / 60, { speed: 5.2, crouch: true });
  assertRestored(model, before);
  controller.dispose();
});

console.log(`\n${checks} character motion checks passed on real Jett/Sage geometry and rigs.`);
