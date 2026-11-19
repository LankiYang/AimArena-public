import * as THREE from 'three';
import { createPhantomModel } from './weapon-model.js';

const primary = (model, name) => {
  let result;
  model.traverse(node => {
    if (!result && node.isBone && new RegExp(`^${name}(?:_\\d+)?$`, 'i').test(node.name)) result = node;
  });
  return result;
};

const sameQuaternion = (a, b) => {
  const sign = a.dot(b) < 0 ? -1 : 1;
  return ['x', 'y', 'z', 'w'].every(axis => Math.abs(a[axis] - b[axis] * sign) < 1e-10);
};

/**
 * Attach the actual RES Phantom geometry to an imported character's right hand.
 * Restore the previous support pose before updating the character animation,
 * then call update() to reapply the grip to the new pose.
 * update({casting,pitch,visible,correctLeftHand,supportWeight}) sets aim pitch
 * (positive up) and controls how strongly the support hand follows the rifle.
 */
export function attachThirdPersonWeapon(model, source) {
  const sourceModel = source?.scene || source;
  if (!model?.isObject3D || !sourceModel?.isObject3D) throw new TypeError('A real character and weapon Object3D are required');
  const rightHand = primary(model, 'R_Hand');
  if (!rightHand) throw new Error('Cannot attach Phantom: character has no primary right-hand bone');
  const gripBone = primary(model, 'R_WeaponPoint') || rightHand;
  if (gripBone !== rightHand && gripBone.parent !== rightHand) throw new Error('Weapon grip must belong to the real right-hand bone');
  const head = primary(model, 'Head');
  const left = { shoulder: primary(model, 'L_Shoulder'), elbow: primary(model, 'L_Elbow'), hand: primary(model, 'L_Hand'), socket: primary(model, 'L_WeaponPoint') };
  const leftChain = left.shoulder && left.elbow?.parent === left.shoulder && left.hand?.parent === left.elbow;
  const frame = new THREE.Group();
  frame.name = 'ThirdPersonPhantomGrip';
  const visual = new THREE.Group();
  visual.name = 'ThirdPersonPhantomGeometry';
  const resource = createPhantomModel(sourceModel);
  const weapon = resource.group;
  // Preserve every actual source mesh/material and its author transforms. The
  // normalization lives on wrappers and never mutates shared asset resources.
  weapon.name = 'RES_Phantom_OriginalMeshes';
  weapon.updateWorldMatrix(true, true);
  const sourceBounds = new THREE.Box3().setFromObject(weapon);
  const sourceSize = sourceBounds.getSize(new THREE.Vector3());
  if (!sourceSize.toArray().every(Number.isFinite) || Math.max(sourceSize.x, sourceSize.y, sourceSize.z) < 0.001) throw new Error('Phantom source has invalid geometry bounds');
  visual.add(weapon);
  // Actual asset inspection: muzzle is the long blue cylinder at source -X;
  // the stock ends at +X. +Y is up. +pi/2 sends -X to character-forward +Z.
  const sourceAxis = sourceSize.x >= sourceSize.z && sourceSize.x >= sourceSize.y ? 'x' : sourceSize.z >= sourceSize.y ? 'z' : 'y';
  if (sourceAxis === 'x') visual.rotation.y = Math.PI / 2;
  else if (sourceAxis === 'y') visual.rotation.x = Math.PI / 2;
  const unitScale = 0.91 / Math.max(sourceSize.x, sourceSize.y, sourceSize.z);
  const gripSource = sourceAxis === 'x' ? new THREE.Vector3(
    sourceBounds.min.x + sourceSize.x * 0.704,
    sourceBounds.min.y + sourceSize.y * 0.32,
    sourceBounds.getCenter(new THREE.Vector3()).z
  ) : sourceBounds.getCenter(new THREE.Vector3());
  const sourceRotation = new THREE.Quaternion().setFromEuler(visual.rotation);
  visual.scale.setScalar(unitScale);
  visual.position.copy(gripSource).applyQuaternion(sourceRotation).multiplyScalar(-unitScale);
  frame.add(visual);
  frame.updateWorldMatrix(true, true);
  const normalizedBounds = new THREE.Box3().setFromObject(visual);
  const grip = new THREE.Object3D(); grip.name = 'PhantomTriggerGrip'; frame.add(grip);
  const muzzle = new THREE.Object3D(); muzzle.name = 'PhantomMuzzle';
  muzzle.position.set(0, normalizedBounds.min.y + (normalizedBounds.max.y - normalizedBounds.min.y) * 0.75, normalizedBounds.max.z);
  frame.add(muzzle);
  const support = new THREE.Object3D(); support.name = 'PhantomSupportGrip';
  support.position.set(0, 0.008, 0.24); frame.add(support);
  const stock = new THREE.Object3D(); stock.name = 'PhantomStock';
  stock.position.set(0, muzzle.position.y, normalizedBounds.min.z); frame.add(stock);
  let meshCount = 0;
  weapon.traverse(node => {
    if (!node.isMesh) return;
    meshCount++;
    node.castShadow = node.receiveShadow = true;
    node.frustumCulled = false;
  });

  model.updateWorldMatrix(true, true);
  const modelQ = model.getWorldQuaternion(new THREE.Quaternion());
  const initialHeadQ = head?.getWorldQuaternion(new THREE.Quaternion()) || modelQ;
  const forwardLocal = new THREE.Vector3(0, 0, 1).applyQuaternion(initialHeadQ).applyQuaternion(modelQ.clone().invert());
  forwardLocal.y = 0;
  if (forwardLocal.lengthSq() < 0.001) forwardLocal.set(0, 0, 1);
  forwardLocal.normalize();
  const aimFrame = (forward, right) => new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(right, new THREE.Vector3().crossVectors(forward, right).normalize(), forward)
  );
  const aimUp = new THREE.Vector3(0, 1, 0).applyQuaternion(modelQ);
  const aimForward = forwardLocal.clone().applyQuaternion(modelQ);
  const aimRight = new THREE.Vector3().crossVectors(aimUp, aimForward).normalize();
  // Keep the authored palm angle in rifle space, including the roll about
  // the handguard. The old wrist angle was taken from the animated torso.
  const palmInRifle = leftChain ? aimFrame(aimForward, aimRight).invert()
    .multiply(left.hand.getWorldQuaternion(new THREE.Quaternion())) : null;
  const socketInPalm = left.socket?.parent === left.hand ? left.socket.position.clone() : null;
  const handRecords = leftChain ? [left.shoulder, left.elbow, left.hand].map(bone => ({ bone, base: bone.quaternion.clone(), output: bone.quaternion.clone(), applied: false })) : [];
  gripBone.add(frame);
  let disposed = false;

  function restoreSupportHand() {
    for (const record of handRecords) {
      if (record.applied && sameQuaternion(record.bone.quaternion, record.output)) record.bone.quaternion.copy(record.base);
      else record.base.copy(record.bone.quaternion);
      record.applied = false;
    }
  }

  function aimBone(bone, child, target) {
    const origin = bone.getWorldPosition(new THREE.Vector3());
    const from = child.getWorldPosition(new THREE.Vector3()).sub(origin);
    const to = target.clone().sub(origin);
    if (from.lengthSq() < 1e-12 || to.lengthSq() < 1e-12) return;
    const delta = new THREE.Quaternion().setFromUnitVectors(from.normalize(), to.normalize());
    const q = bone.getWorldQuaternion(new THREE.Quaternion()).premultiply(delta);
    bone.quaternion.copy(bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(q)).normalize();
    bone.updateWorldMatrix(false, true);
  }

  function correctSupportHand(up, right, forward, rifleQ, weight) {
    if (!leftChain) return;
    const a = left.shoulder.getWorldPosition(new THREE.Vector3());
    const b = left.elbow.getWorldPosition(new THREE.Vector3());
    const c = left.hand.getWorldPosition(new THREE.Vector3());
    const upper = a.distanceTo(b), lower = b.distanceTo(c);
    if (upper < 1e-6 || lower < 1e-6) return;
    const holdQ = rifleQ.clone().multiply(palmInRifle);
    // Preserve the character's palm/fingers, and move its true WeaponPoint to
    // the underside of the handguard rather than putting the wrist in it.
    const target = support.getWorldPosition(new THREE.Vector3());
    if (socketInPalm) {
      const offset = socketInPalm.clone().multiply(left.hand.getWorldScale(new THREE.Vector3())).applyQuaternion(holdQ);
      target.sub(offset);
    }
    const direction = target.clone().sub(a);
    if (direction.lengthSq() < 1e-10) return;
    const distance = THREE.MathUtils.clamp(direction.length(), Math.abs(upper - lower) + 0.0001, (upper + lower) * 0.994);
    direction.normalize();
    const reachable = a.clone().addScaledVector(direction, distance);
    const pole = up.clone().multiplyScalar(-1).addScaledVector(right, -0.2).addScaledVector(forward, -0.08);
    pole.addScaledVector(direction, -pole.dot(direction)).normalize();
    const along = (upper * upper - lower * lower + distance * distance) / (2 * distance);
    const bend = Math.sqrt(Math.max(0, upper * upper - along * along));
    const elbowTarget = a.clone().addScaledVector(direction, along).addScaledVector(pole, bend);
    aimBone(left.shoulder, left.elbow, elbowTarget);
    aimBone(left.elbow, left.hand, reachable);
    left.hand.quaternion.copy(left.hand.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(holdQ)).normalize();
    if (weight < 1) {
      for (const { bone, base } of handRecords) bone.quaternion.slerp(base, 1 - weight).normalize();
    }
    left.shoulder.updateWorldMatrix(false, true);
    for (const record of handRecords) { record.output.copy(record.bone.quaternion); record.applied = true; }
  }

  function update(options = {}) {
    if (disposed) return api;
    if (typeof options !== 'object' || options === null) options = {};
    restoreSupportHand();
    model.updateWorldMatrix(true, true);
    const characterQ = model.getWorldQuaternion(new THREE.Quaternion());
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(characterQ).normalize();
    const forward = forwardLocal.clone().applyQuaternion(characterQ).normalize();
    const right = new THREE.Vector3().crossVectors(up, forward).normalize();
    if (Number.isFinite(options.pitch)) forward.applyAxisAngle(right, -THREE.MathUtils.clamp(options.pitch, -1.2, 1.2));
    const desired = aimFrame(forward, right);
    const parentQ = gripBone.getWorldQuaternion(new THREE.Quaternion());
    frame.quaternion.copy(parentQ.invert().multiply(desired)).normalize();
    const scale = gripBone.getWorldScale(new THREE.Vector3());
    frame.scale.set(1 / Math.max(0.00001, Math.abs(scale.x)), 1 / Math.max(0.00001, Math.abs(scale.y)), 1 / Math.max(0.00001, Math.abs(scale.z)));
    frame.position.set(0, 0, 0);
    frame.visible = options.visible !== false;
    frame.updateWorldMatrix(false, true);
    const supportWeight = THREE.MathUtils.clamp(options.supportWeight ?? (options.casting ? 0 : 1), 0, 1);
    if (supportWeight > 0 && options.correctLeftHand !== false && frame.visible) {
      const rifleUp = new THREE.Vector3().crossVectors(forward, right).normalize();
      correctSupportHand(rifleUp, right, forward, desired, supportWeight);
    }
    return api;
  }

  function dispose() {
    if (disposed) return;
    restoreSupportHand();
    frame.removeFromParent();
    // The batch factory owns cloned buffers/materials and preserves the source.
    resource.dispose();
    disposed = true;
  }

  const api = {
    root: frame, weapon, gripBone, rightHand, leftHand: left.hand,
    anchors: { grip, muzzle, support, stock },
    metadata: Object.freeze({ kind: 'procedural-weapon-grip', sourceGeometry: 'RES Phantom', normalizedLengthMetres: 0.91, sourceLongAxis: sourceAxis, sourceMuzzleDirection: sourceAxis === 'x' ? '-X' : '+Z', originalMeshCount: resource.stats.sourceMeshes, renderMeshCount: meshCount, triangles: resource.stats.triangles, authoredAnimation: false }),
    restoreSupportHand, update, dispose
  };
  frame.userData.thirdPersonWeapon = api.metadata;
  update();
  return api;
}
