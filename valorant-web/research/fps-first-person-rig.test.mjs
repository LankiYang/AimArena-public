import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FPSFirstPersonRig } from '../src/fps-first-person-rig.js';

globalThis.ProgressEvent ||= class { constructor(type, data) { Object.assign(this, { type, ...data }); } };

async function loadAsset() {
  const folder = new URL('../assets/animations/fps-ak74m/', import.meta.url);
  const gltf = JSON.parse(fs.readFileSync(new URL('scene.gltf', folder), 'utf8'));
  gltf.buffers[0].uri = `data:application/octet-stream;base64,${fs.readFileSync(new URL('scene.bin', folder)).toString('base64')}`;
  delete gltf.images;
  delete gltf.textures;
  gltf.materials = gltf.materials.map(({ name }) => ({ name }));
  delete gltf.extensionsUsed;
  delete gltf.extensionsRequired;
  delete gltf.extensions;
  return new GLTFLoader().parseAsync(JSON.stringify(gltf), folder.href);
}

test('borrowed AK-74M rig includes its original weapon and authored actions', async () => {
  const asset = await loadAsset();
  const expected = ['AK_Idle', 'AK_Draw', 'AK_Walk', 'AK_Run', 'AK_Shot', 'AK_Reload', 'AK_Reload_var2', 'AK_Reload_full'];
  assert.deepEqual(asset.animations.map(({ name }) => name.replace('Rig|', '')), expected);
  assert.ok(asset.scene.getObjectByName('Object_11')?.isSkinnedMesh, 'the source rig has its original gloved arms');
  assert.ok(asset.scene.getObjectByName('Object_97')?.isSkinnedMesh, 'the source rig has its original AK-74M');
  assert.ok(asset.scene.getObjectByName('Object_99')?.isSkinnedMesh, 'the source rig has its original spare magazine');

  const assetFolder = new URL('../assets/animations/fps-ak74m/', import.meta.url);
  const source = JSON.parse(fs.readFileSync(new URL('scene.gltf', assetFolder), 'utf8'));
  for (const { uri } of source.images) {
    const bytes = fs.readFileSync(new URL(uri, assetFolder));
    assert.ok(bytes.length > 100, `${uri}: texture file is present`);
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${uri}: valid PNG signature`);
  }
  assert.ok(fs.statSync(new URL('license.txt', assetFolder)).size > 100);
});

test('first-person controller switches the authored idle, run, shot, and reload clips', async () => {
  const asset = await loadAsset();
  const camera = new THREE.PerspectiveCamera(76, 16 / 9, .06, 280);
  const rig = new FPSFirstPersonRig(asset, camera);
  try {
    assert.equal(rig.model.getObjectByName('Object_97').visible, true, 'the original AK-74M remains visible');
    assert.equal(rig.model.getObjectByName('Object_99').visible, false, 'the spare magazine stays hidden in idle');
    assert.equal(rig.model.getObjectByName('Object_11').visible, true, 'the authored arms and gloves remain visible');
    assert.equal(rig.model.getObjectByName('FirstPersonPhantom'), undefined);
    assert.deepEqual(rig.root.position.toArray(), [0, 0, 0], 'the original camera mount has no extra view offset');
    assert.equal(rig.current, rig.actions.get('idle'));
    rig.update(.25);
    assert.ok(rig.current.time > 0, 'idle clip advances');
    rig.update(1 / 60, { moving: true });
    assert.equal(rig.current, rig.actions.get('run'));
    rig.fire();
    assert.equal(rig.oneShot, rig.actions.get('shot'));
    const shotTime = rig.oneShot.time;
    rig.fire();
    assert.equal(rig.oneShot.time, shotTime, 'automatic fire does not restart an unfinished authored shot clip');
    rig.update(.4, { moving: true });
    rig.update(0, { moving: true });
    assert.equal(rig.current, rig.actions.get('run'), 'completed shot returns to the movement clip');
    rig.update(0, { moving: true, reloadRemaining: 2.5 });
    assert.equal(rig.oneShot, rig.actions.get('reload'));
    assert.ok(Math.abs(rig.oneShot.getClip().duration / rig.oneShot.timeScale - 2.5) < .001);
    rig.fire();
    assert.equal(rig.oneShot, rig.actions.get('reload'), 'reload cannot be interrupted by a shot event');
    rig.update(2.49, { moving: true, reloadRemaining: .01 });
    assert.equal(rig.oneShot, rig.actions.get('reload'));
    rig.update(.01, { moving: true, reloadRemaining: 0 });
    assert.equal(rig.oneShot, null, 'completed reload returns to the base clip');
    assert.equal(rig.current, rig.actions.get('run'));
    rig.update(0, { moving: true, walk: true });
    assert.equal(rig.current, rig.actions.get('walk'));
    assert.ok(rig.model.getObjectByName('Forearm_R_010'));
    assert.equal(rig.root.visible, true);
    rig.update(1 / 60, { alive: false });
    assert.equal(rig.root.visible, false);
    assert.ok([...rig.actions.values()].every((action) => Number.isFinite(action.time)));
  } finally {
    rig.dispose();
  }
});

test('production scene uses the AK-74M view model with its original arm rig', () => {
  const scene = fs.readFileSync(new URL('../src/scene.js', import.meta.url), 'utf8');
  const rig = fs.readFileSync(new URL('../src/fps-first-person-rig.js', import.meta.url), 'utf8');
  assert.match(scene, /new FPSFirstPersonRig\(this\.assets\.viewModel,this\.camera\)/);
  assert.doesNotMatch(scene, /FPSCharacterSkin|\bViewArms\b|\bthis\.arms\b|\bthis\.hands\b/);
  assert.doesNotMatch(rig, /createFirstPersonPhantom|PhantomReceiverOnPBody|originalGun\.visible\s*=\s*false/);
});

test('original AK-74M, arms, and spare magazine follow the authored actions', async () => {
  const asset = await loadAsset();
  const camera = new THREE.PerspectiveCamera(76, 16 / 9, .06, 280);
  const rig = new FPSFirstPersonRig(asset, camera);
  const forearm = rig.model.getObjectByName('Forearm_L_04');
  const spareBone = rig.model.getObjectByName('Pmag2_063');
  try {
    const arms = rig.model.getObjectByName('Object_11');
    const ak = rig.model.getObjectByName('Object_97');
    const spare = rig.model.getObjectByName('Object_99');
    assert.equal(arms.visible, true, 'the original arm and glove mesh remains visible');
    assert.equal(ak.visible, true, 'the original black AK-74M remains visible');
    assert.equal(spare.visible, false, 'the spare magazine stays hidden in idle');
    const idleArmPose = forearm.quaternion.clone();
    rig.update(.25, { moving: true, walk: true });
    assert.ok(forearm.quaternion.angleTo(idleArmPose) > .001, 'the original arm follows its authored walk animation');
    assert.equal(rig.current, rig.actions.get('walk'));

    rig.update(0, { reloadRemaining: 2.5 });
    assert.equal(rig.oneShot, rig.actions.get('reload'));
    rig.root.updateMatrixWorld(true);
    const initialSparePose = spareBone.matrixWorld.clone();
    for (let i = 1; i < 40; i++) {
      const fraction = i / 40;
      rig.update(.0625, { reloadRemaining: 2.5 * (1 - fraction) });
      rig.root.updateMatrixWorld(true);
      assert.equal(arms.visible, true, 'the original arms stay visible throughout reload');
      assert.equal(ak.visible, true, 'the original AK-74M stays visible throughout reload');
      assert.equal(spare.visible, true, 'the original spare magazine stays visible throughout reload');
      if (fraction === .5) {
        assert.ok(Math.abs(rig.oneShot.time / rig.oneShot.getClip().duration - .5) < .001);
        assert.notDeepEqual(spareBone.matrixWorld.elements, initialSparePose.elements, 'the authored spare magazine moves during reload');
      }
    }
    rig.update(.0625, { reloadRemaining: 0 });
    assert.equal(rig.oneShot, null, 'completed reload returns to the base clip');
    assert.equal(spare.visible, false, 'the spare magazine is hidden again after reload');
  } finally {
    rig.dispose();
  }
});
