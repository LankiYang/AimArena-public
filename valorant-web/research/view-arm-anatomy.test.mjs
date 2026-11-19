import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ViewArms } from '../src/view-arms.js';
import { createFirstPersonPhantom } from '../src/weapon-model.js';
import { applyViewWeaponPose } from '../src/view-weapon-pose.js';

globalThis.ProgressEvent ||= class {
  constructor(type, data) { Object.assign(this, { type, ...data }); }
};

const sides = ['L', 'R'];
const loader = new GLTFLoader();
const point = () => new THREE.Vector3();
const degrees = THREE.MathUtils.radToDeg;
const unpack = (buffer) => `data:application/octet-stream;base64,${buffer.toString('base64')}`;

async function loadCharacter(name) {
  const bytes = fs.readFileSync(new URL(`../assets/agents/${name}.glb`, import.meta.url));
  const jsonEnd = 20 + bytes.readUInt32LE(12);
  const data = JSON.parse(bytes.toString('utf8', 20, jsonEnd));
  delete data.images;
  delete data.textures;
  for (const material of data.materials ?? []) {
    delete material.pbrMetallicRoughness?.baseColorTexture;
    delete material.pbrMetallicRoughness?.metallicRoughnessTexture;
    delete material.normalTexture;
    delete material.emissiveTexture;
    delete material.occlusionTexture;
  }
  data.buffers[0].uri = unpack(bytes.subarray(jsonEnd + 8, jsonEnd + 8 + bytes.readUInt32LE(jsonEnd)));
  return loader.parseAsync(JSON.stringify(data), '');
}

async function loadWeapon() {
  const url = new URL('../assets/weapons/res-phantom/scene.gltf', import.meta.url);
  const data = JSON.parse(fs.readFileSync(url, 'utf8'));
  for (const buffer of data.buffers) buffer.uri = unpack(fs.readFileSync(new URL(buffer.uri, url)));
  return loader.parseAsync(JSON.stringify(data), '');
}

function armChain(model, side) {
  return ['Shoulder', 'Elbow', 'Hand', 'Middle1'].map((joint) => {
    const pattern = new RegExp(`^${side}_${joint}_\\d+$`);
    let bone;
    model.traverse((object) => { if (object.isBone && pattern.test(object.name)) bone = object; });
    assert.ok(bone, `${side} ${joint} missing from source rig`);
    return bone;
  });
}

function articulation([shoulder, elbow, wrist, knuckle], camera) {
  const upper = elbow.clone().sub(shoulder);
  const forearm = wrist.clone().sub(elbow);
  const palm = knuckle.clone().sub(wrist);
  const pose = { wristBend: degrees(forearm.angleTo(palm)), elbowFlex: degrees(upper.angleTo(forearm)) };
  if (!camera) return pose;
  const projected = [elbow, wrist, knuckle].map((world) => world.clone().project(camera));
  const screen = projected.map(({ x, y }) => new THREE.Vector2(x * camera.aspect, y));
  const forearm2D = screen[1].clone().sub(screen[0]);
  const palm2D = screen[2].clone().sub(screen[1]);
  // Equal pixel units; an almost end-on segment has no stable screen angle.
  pose.screenBend = Math.min(forearm2D.length(), palm2D.length()) < .035
    ? null
    : degrees(Math.atan2(Math.abs(forearm2D.cross(palm2D)), forearm2D.dot(palm2D)));
  pose.wristInFrontOfElbow = camera.worldToLocal(elbow.clone()).z - camera.worldToLocal(wrist.clone()).z;
  return pose;
}

function assertIdle(pose, side, label) {
  assert.ok(pose.wristBend < 40, `${label}: wrist bends ${pose.wristBend.toFixed(1)} degrees (limit 40)`);
  if (pose.screenBend !== null) {
    assert.ok(pose.screenBend < 40, `${label}: visible wrist folds by ${pose.screenBend.toFixed(1)} degrees`);
  }
  if (side === 'R') {
    assert.ok(pose.wristInFrontOfElbow > .015, `${label}: right forearm points back toward the player`);
  }
  assert.ok(pose.elbowFlex > 15 && pose.elbowFlex < 140, `${label}: elbow is locked or acutely folded`);
}

function gameCamera() { return new THREE.PerspectiveCamera(76, 16 / 9, .06, 280); }

test('pose checks reject the actual previous Jett and Sage poses', () => {
  const camera = gameCamera();
  camera.updateMatrixWorld(true);
  // Camera-space shoulder, elbow, wrist and Middle1 sampled from the version
  // with gun position [.24, -.14, -.4] and fixed idle-derived elbow poles.
  const previous = {
    jett: {
      L: [[-.0703,-.527,-.23],[-.0185,-.3922,-.5286],[.1227,-.1996,-.6307],[.2193,-.1717,-.6534]],
      R: [[.2703,-.473,-.23],[.5098,-.2775,-.35],[.3055,-.1524,-.2495],[.2952,-.1693,-.3506]],
    },
    sage: {
      L: [[-.0778,-.4881,-.23],[.0032,-.4361,-.5619],[.1198,-.2016,-.6301],[.2205,-.1726,-.6537]],
      R: [[.2778,-.5119,-.23],[.5061,-.2906,-.3654],[.3068,-.1514,-.2464],[.2961,-.1691,-.3517]],
    },
  };
  for (const [name, chains] of Object.entries(previous)) {
    for (const side of sides) {
      const pose = articulation(chains[side].map((xyz) => point().fromArray(xyz)), camera);
      assert.throws(() => assertIdle(pose, side, name), /wrist (bends|folds)/);
    }
  }
});

const phantom = await loadWeapon();
for (const name of ['jett', 'sage']) {
  test(`${name}: production hold uses plausible wrist and elbow angles`, async (t) => {
    const asset = await loadCharacter(name);
    const source = new THREE.AnimationMixer(asset.scene);
    source.clipAction(asset.animations[0]).play();
    source.update(0);
    asset.scene.updateMatrixWorld(true);
    const sourceAngles = Object.fromEntries(sides.map((side) => [side, articulation(
      armChain(asset.scene, side).map((bone) => bone.getWorldPosition(point())),
    ).wristBend]));
    source.stopAllAction();
    const camera = gameCamera();
    const arms = new ViewArms(asset, camera);
    const weapon = createFirstPersonPhantom(phantom.scene);
    const root = new THREE.Group();
    camera.add(root);
    root.add(weapon.group);
    t.after(() => { arms.dispose(); weapon.dispose(); root.removeFromParent(); });
    const chains = Object.fromEntries(sides.map((side) => [side, armChain(arms.model, side)]));
    const read = (side) => articulation(chains[side].map((bone) => bone.getWorldPosition(point())), camera);
    applyViewWeaponPose(root);
    camera.updateMatrixWorld(true);
    arms.bindWeapon(weapon.anchors);
    const idle = Object.fromEntries(sides.map((side) => [side, read(side)]));
    t.diagnostic(`source wrist ${JSON.stringify(sourceAngles)}; idle ${JSON.stringify(idle)}`);
    for (const side of sides) assertIdle(idle[side], side, `${name} ${side}`);

    const maxDynamic = { L: 0, R: 0 };
    for (let frame = 0; frame < 180; frame++) {
      const time = frame / 60;
      camera.position.set(time, 1.62, -2);
      camera.rotation.set(.4 * Math.sin(time), time, 0, 'YXZ');
      applyViewWeaponPose(root, {
        bob: frame * .15,
        moving: frame % 90 > 30,
        recoil: frame % 45 < 6 ? .07 * Math.exp(-19 * (frame % 45) / 60) : 0,
        reloadRoll: frame > 90 ? -.4 * Math.sin(time * 5) : 0,
      });
      camera.updateMatrixWorld(true);
      arms.update(1 / 60);
      for (const side of sides) {
        const pose = read(side);
        maxDynamic[side] = Math.max(maxDynamic[side], pose.wristBend);
        assert.ok(pose.wristBend < 70, `${name} ${side} frame ${frame}: wrist folds ${pose.wristBend.toFixed(1)} degrees`);
      }
    }
    t.diagnostic(`max dynamic wrist bend ${JSON.stringify(maxDynamic)}`);
  });
}
