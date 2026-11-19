import * as THREE from 'three';
import { RemoteLocomotion } from './remote-locomotion.js';

const TAU = Math.PI * 2;
const clamp = THREE.MathUtils.clamp;
const number = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const damp = (value, target, rate, dt) => {
  const next = THREE.MathUtils.lerp(value, target, 1 - Math.exp(-rate * dt));
  return Math.abs(next - target) < 0.0001 ? target : next;
};

/**
 * Original procedural transitions layered over the imported holding animation.
 * Call after mixer.update(dt). speed is metres/second, forward/strafe are local
 * direction components, time is seconds, and casting may be a skill name.
 * Do not squash the player root for crouching: this controller bends the rig.
 * Optional state.hit (rising edge) or triggerHit() supplies a damage reaction.
 */
export class MotionController {
  constructor(model, { clips, root } = {}) {
    if (!model?.isObject3D) throw new TypeError('MotionController needs a THREE.Object3D model');
    this.model = model;
    this.bones = {};
    const names = ['Pelvis', 'Spine1', 'Spine3', 'Spine4', 'Head',
      'L_Hip', 'L_Knee', 'L_Foot', 'L_Toe', 'R_Hip', 'R_Knee', 'R_Foot', 'R_Toe',
      'L_Shoulder', 'L_Elbow', 'R_Shoulder'];
    model.traverse(node => {
      if (!node.isBone) return;
      for (const name of names) {
        // Match primary joints, excluding Ndl/Twst/IK/end helper bones.
        if (!this.bones[name] && new RegExp(`^${name}(?:_\\d+)?$`, 'i').test(node.name)) this.bones[name] = node;
      }
    });
    this.bodyRoot = this.bones.Pelvis?.parent;
    if (!this.bodyRoot?.isBone || !this.bones.Spine1 || !this._contains(this.bodyRoot, this.bones.Spine1)) this.bodyRoot = null;
    this.legs = ['L', 'R'].map(side => ({ side, hip: this.bones[`${side}_Hip`], knee: this.bones[`${side}_Knee`], foot: this.bones[`${side}_Foot`], toe: this.bones[`${side}_Toe`] }))
      .filter(leg => leg.hip && leg.knee?.parent === leg.hip && leg.foot?.parent === leg.knee);
    this.enabled = this.legs.length === 2;
    const authored = Boolean(clips && root && this.enabled && this.legs.every(leg => leg.toe?.parent === leg.foot));
    this.metadata = Object.freeze({
      kind: authored ? 'retargeted-tps-locomotion' : 'procedural-skeletal-transition',
      authoredAnimation: authored,
      legSolver: 'world-space two-bone IK without stretching',
      primaryBones: Object.keys(this.bones).length,
      completeLegRig: this.enabled
    });
    model.userData.proceduralMotion = this.metadata;
    this.records = [...new Set([...Object.values(this.bones), this.bodyRoot].filter(Boolean))].map(bone => ({
      bone, baseQ: bone.quaternion.clone(), baseP: bone.position.clone(),
      outputQ: bone.quaternion.clone(), outputP: bone.position.clone(), written: false
    }));
    this.speed = this.motionWeight = this.crouchWeight = this.airWeight = this.castWeight = 0;
    this.phase = this.clock = this.landing = this.hitWeight = this.recoil = 0;
    this.hitSide = 1;
    this.wasGrounded = true;
    this.wasHit = this.wasShooting = false;
    this.gait = { phase: 0, frequency: 0, speed: 0 };
    model.updateWorldMatrix(true, true);
    // The GLBs contain rotated skeleton roots. Derive their facing from the
    // head's current world orientation, then retain it in model coordinates.
    const modelQ = model.getWorldQuaternion(new THREE.Quaternion());
    const headQ = this.bones.Head?.getWorldQuaternion(new THREE.Quaternion()) || modelQ;
    this.forwardLocal = new THREE.Vector3(0, 0, 1).applyQuaternion(headQ).applyQuaternion(modelQ.clone().invert());
    this.forwardLocal.y = 0;
    if (this.forwardLocal.lengthSq() < 0.01) this.forwardLocal.set(0, 0, 1);
    this.forwardLocal.normalize();
    const head = this.bones.Head?.getWorldPosition(new THREE.Vector3());
    const ankleY = this.legs.length ? Math.min(...this.legs.map(leg => leg.foot.getWorldPosition(new THREE.Vector3()).y)) : 0;
    this.nominalHeight = head ? Math.max(0.2, head.y - ankleY) / Math.max(0.0001, model.getWorldScale(new THREE.Vector3()).y) * 1.1 : 1.8;
    this.locomotion = authored ? new RemoteLocomotion(this, clips, root) : null;
  }

  _contains(parent, child) {
    for (let p = child; p; p = p.parent) if (p === parent) return true;
    return false;
  }

  _captureBase() {
    for (const record of this.records) {
      const { bone } = record;
      // A mixer only writes animated channels. Strip the previous overlay from
      // untouched channels; retain fresh mixer output on all other channels.
      const sign = bone.quaternion.dot(record.outputQ) < 0 ? -1 : 1;
      const sameRotation = ['x', 'y', 'z', 'w'].every(axis => Math.abs(bone.quaternion[axis] - record.outputQ[axis] * sign) < 1e-11);
      if (record.written && sameRotation) bone.quaternion.copy(record.baseQ);
      else record.baseQ.copy(bone.quaternion);
      if (record.written && bone.position.distanceToSquared(record.outputP) < 1e-16) bone.position.copy(record.baseP);
      else record.baseP.copy(bone.position);
    }
    this.model.updateWorldMatrix(true, true);
  }

  _rememberOutput() {
    for (const record of this.records) {
      record.outputQ.copy(record.bone.quaternion);
      record.outputP.copy(record.bone.position);
      record.written = true;
    }
  }

  _rotateWorld(bone, axis, angle) {
    if (!bone || Math.abs(angle) < 1e-8 || !Number.isFinite(angle)) return;
    const worldQ = bone.getWorldQuaternion(new THREE.Quaternion());
    worldQ.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, angle));
    const parentQ = bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
    bone.quaternion.copy(parentQ.multiply(worldQ)).normalize();
    bone.updateWorldMatrix(false, true);
  }

  _aimSegment(bone, child, target) {
    const origin = bone.getWorldPosition(new THREE.Vector3());
    const current = child.getWorldPosition(new THREE.Vector3()).sub(origin);
    const desired = target.clone().sub(origin);
    if (current.lengthSq() < 1e-12 || desired.lengthSq() < 1e-12) return;
    const rotation = new THREE.Quaternion().setFromUnitVectors(current.normalize(), desired.normalize());
    const worldQ = bone.getWorldQuaternion(new THREE.Quaternion()).premultiply(rotation);
    const parentQ = bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
    bone.quaternion.copy(parentQ.multiply(worldQ)).normalize();
    bone.updateWorldMatrix(false, true);
  }

  _solveLeg(leg, target, pole, orientation) {
    const a = leg.hip.getWorldPosition(new THREE.Vector3());
    const b = leg.knee.getWorldPosition(new THREE.Vector3());
    const c = leg.foot.getWorldPosition(new THREE.Vector3());
    const upper = a.distanceTo(b), lower = b.distanceTo(c);
    const direction = target.clone().sub(a);
    if (upper < 1e-6 || lower < 1e-6 || direction.lengthSq() < 1e-12) return;
    // Clamp unreachable goals; never stretch a bone or change its scale.
    const distance = clamp(direction.length(), Math.abs(upper - lower) + 0.0001, (upper + lower) * 0.995);
    direction.normalize();
    const reachableTarget = a.clone().addScaledVector(direction, distance);
    pole = pole.clone().addScaledVector(direction, -pole.dot(direction));
    if (pole.lengthSq() < 1e-8) pole.set(1, 0, 0).addScaledVector(direction, -direction.x);
    if (pole.lengthSq() < 1e-8) pole.set(0, 0, 1).addScaledVector(direction, -direction.z);
    pole.normalize();
    const along = (upper * upper + distance * distance - lower * lower) / (2 * distance);
    const bend = Math.sqrt(Math.max(0, upper * upper - along * along));
    const kneeTarget = a.clone().addScaledVector(direction, along).addScaledVector(pole, bend);
    this._aimSegment(leg.hip, leg.knee, kneeTarget);
    this._aimSegment(leg.knee, leg.foot, reachableTarget);
    const parentQ = leg.foot.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
    leg.foot.quaternion.copy(parentQ.multiply(orientation)).normalize();
    leg.foot.updateWorldMatrix(false, true);
  }

  triggerHit(strength = 1, side = 1) {
    this.hitWeight = Math.max(this.hitWeight, clamp(number(strength, 1), 0, 1));
    this.hitSide = number(side, 1) >= 0 ? 1 : -1;
  }

  triggerShot() { this.recoil = 1; }

  update(dt, state = {}) {
    dt = clamp(number(dt), 0, 0.1);
    this.clock += dt;
    const time = number(state.time, this.clock);
    const requestedSpeed = clamp(Math.abs(number(state.speed)), 0, 12);
    const grounded = state.grounded !== false;
    const hit = Boolean(state.hit || state.hurt);
    if (hit && !this.wasHit) this.triggerHit(number(state.hitStrength, 1), number(state.hitSide, 1));
    if (state.shooting && !this.wasShooting) this.triggerShot();
    if (grounded && !this.wasGrounded) this.landing = 1;
    this.wasGrounded = grounded;
    this.wasHit = hit;
    this.wasShooting = Boolean(state.shooting);
    this.speed = damp(this.speed, requestedSpeed, 13, dt);
    this.motionWeight = damp(this.motionWeight, requestedSpeed > 0.06 ? clamp(requestedSpeed / 0.9, 0, 1) : 0, 12, dt);
    this.crouchWeight = damp(this.crouchWeight, state.crouch ? 1 : 0, 12, dt);
    this.airWeight = damp(this.airWeight, grounded ? 0 : 1, 16, dt);
    this.castWeight = damp(this.castWeight, state.casting ? 1 : 0, state.casting ? 18 : 10, dt);
    this.hitWeight = damp(this.hitWeight, 0, 9, dt);
    this.recoil = damp(this.recoil, 0, 16, dt);
    this.landing = damp(this.landing, 0, 13, dt);
    const frequency = (1.2 + this.speed * 0.22) * (1 - this.crouchWeight * 0.22);
    if (this.motionWeight > 0.0001) this.phase = (this.phase + TAU * frequency * dt * (1 - this.airWeight * 0.88)) % TAU;
    this.gait = { phase: this.phase, frequency, speed: this.speed };
    this._captureBase();

    const modelQ = this.model.getWorldQuaternion(new THREE.Quaternion());
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(modelQ).normalize();
    const forward = this.forwardLocal.clone().applyQuaternion(modelQ).normalize();
    const right = new THREE.Vector3().crossVectors(up, forward).normalize();
    const modelScale = this.model.getWorldScale(new THREE.Vector3());
    const height = this.nominalHeight * Math.max(0.0001, Math.abs(modelScale.y));
    let f = number(state.forward, 1), s = number(state.strafe);
    const directionLength = Math.hypot(f, s);
    if (directionLength > 0.001) { f /= directionLength; s /= directionLength; }
    else { f = 1; s = 0; }
    const travel = forward.clone().multiplyScalar(f).addScaledVector(right, s).normalize();
    const groundMotion = this.motionWeight * (1 - this.airWeight);
    const run = clamp((this.speed - 2.4) / 2.8, 0, 1);
    const legSamples = this.legs.map(leg => {
      const hip = leg.hip.getWorldPosition(new THREE.Vector3());
      const knee = leg.knee.getWorldPosition(new THREE.Vector3());
      const foot = leg.foot.getWorldPosition(new THREE.Vector3());
      const line = foot.clone().sub(hip).normalize();
      const restPole = knee.clone().sub(hip).addScaledVector(line, -knee.clone().sub(hip).dot(line));
      return { leg, hip, knee, foot, restPole, orientation: leg.foot.getWorldQuaternion(new THREE.Quaternion()) };
    });

    if (this.locomotion) this.locomotion.update(dt, state, legSamples);
    else this._proceduralLegs(legSamples, { up, forward, right, travel, height, groundMotion, run, frequency });

    const gaitSway = Math.sin(this.gait.phase) * groundMotion;
    const aimPitch = clamp(number(state.aimPitch), -.8, .8);
    const sustainedRecoil = state.shooting ? 0.014 * (0.5 + 0.5 * Math.sin(time * 70)) : 0;
    this._rotateWorld(this.bones.Spine1, right, -f * groundMotion * (0.035 + run * 0.065) - this.crouchWeight * 0.10 + this.hitWeight * 0.12);
    this._rotateWorld(this.bones.Spine1, forward, s * groundMotion * 0.055 + this.hitWeight * this.hitSide * 0.085);
    this._rotateWorld(this.bones.Spine3, up, -gaitSway * 0.035);
    this._rotateWorld(this.bones.Spine3, right, -aimPitch * .26);
    this._rotateWorld(this.bones.Spine4, right, -aimPitch * .74 + (this.recoil * 0.035 + sustainedRecoil) - this.castWeight * 0.035);
    this._rotateWorld(this.bones.Head, right, -this.hitWeight * 0.07 - this.recoil * 0.012);
    this._rotateWorld(this.bones.R_Shoulder, right, this.recoil * 0.05);
    const castWave = this.castWeight;
    this._rotateWorld(this.bones.L_Shoulder, right, -castWave * 0.30);
    this._rotateWorld(this.bones.L_Shoulder, up, castWave * 0.16);
    this._rotateWorld(this.bones.L_Elbow, right, castWave * 0.18);
    this.model.updateWorldMatrix(true, true);
    this._rememberOutput();
    return this;
  }

  _proceduralLegs(legSamples, { up, forward, right, travel, height, groundMotion, run, frequency }) {

    // Translate the shared pelvis/spine ancestor, not the model or any scale.
    // Counter-solving both legs holds the feet at their ground targets.
    if (this.bodyRoot) {
      const bob = Math.sin(this.phase * 2) * height * 0.006 * groundMotion;
      const drop = height * (0.22 * this.crouchWeight + 0.027 * this.landing);
      const world = this.bodyRoot.getWorldPosition(new THREE.Vector3()).addScaledVector(up, bob - drop);
      this.bodyRoot.position.copy(this.bodyRoot.parent.worldToLocal(world));
      this.bodyRoot.updateWorldMatrix(false, true);
    }

    for (let index = 0; index < legSamples.length; index++) {
      const sample = legSamples[index], opposite = index === 0 ? 0 : Math.PI;
      const cycle = ((this.phase + opposite) / TAU) % 1;
      // During the planted half-cycle the foot travels backwards at a nearly
      // constant speed. The swing half returns it with a smooth lifted arc.
      const stance = 0.52;
      let along, lift;
      if (cycle < stance) { along = 0.5 - cycle / stance; lift = 0; }
      else {
        const swing = (cycle - stance) / (1 - stance);
        along = -0.5 + (0.5 - 0.5 * Math.cos(swing * Math.PI));
        lift = Math.sin(swing * Math.PI) ** 1.5;
      }
      const stride = Math.min(this.speed / Math.max(1, frequency) * stance, height * 0.67) * (1 - this.crouchWeight * 0.26);
      const anchor = sample.hip.clone().addScaledVector(up, sample.foot.clone().sub(sample.hip).dot(up));
      anchor.addScaledVector(forward, height * 0.022);
      const target = sample.foot.clone().lerp(anchor, this.motionWeight);
      target.addScaledVector(travel, along * stride * groundMotion);
      target.addScaledVector(up, lift * height * (0.045 + run * 0.035) * groundMotion);
      target.addScaledVector(up, this.airWeight * height * (0.09 + 0.025 * Math.sin(this.phase + opposite)));
      target.addScaledVector(forward, this.airWeight * height * (index === 0 ? 0.04 : -0.015));
      const blend = Math.max(groundMotion, this.crouchWeight, this.airWeight, this.landing);
      if (blend > 0.0001 && this.enabled) {
        const pole = sample.restPole.lengthSq() > 1e-8 ? sample.restPole.clone().normalize() : forward.clone();
        pole.lerp(forward, 0.72 * Math.max(this.motionWeight, this.crouchWeight, this.airWeight)).normalize();
        const sole = sample.orientation.clone().premultiply(new THREE.Quaternion().setFromAxisAngle(right, -lift * 0.1 * groundMotion));
        this._solveLeg(sample.leg, target, pole, sole);
      }
    }

  }

  reset() {
    this._captureBase();
    this.speed = this.motionWeight = this.crouchWeight = this.airWeight = this.castWeight = 0;
    this.phase = this.clock = this.landing = this.hitWeight = this.recoil = 0;
    this.wasGrounded = true;
    this.wasHit = this.wasShooting = false;
    this.gait = { phase: 0, frequency: 0, speed: 0 };
    this.locomotion?.reset();
    for (const record of this.records) record.written = false;
    return this;
  }

  dispose() {
    this.reset();
    if (this.model.userData.proceduralMotion === this.metadata) delete this.model.userData.proceduralMotion;
  }
}
