import * as THREE from 'three';

const { clamp, lerp, smoothstep } = THREE.MathUtils;
const TAU = 2 * Math.PI;
const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, 1);
const v3 = () => new THREE.Vector3();
const quat = () => new THREE.Quaternion();
const fromAngle = (axis, angle) => quat().setFromAxisAngle(axis, angle);
const ease = (rate, dt) => 1 - Math.exp(-rate * dt);

// Retarget foot trajectories instead of copying joint rotations: the two rigs
// use different bone axes, leg lengths and foot rest angles. A planted step
// uses the ball of the foot as its pivot during the heel-to-toe roll.
export class RemoteLocomotion {
  constructor(controller, clips, root) {
    this.controller = controller;
    this.clips = clips;
    this.root = root;
    this.direction = new THREE.Vector2(0, 1);
    this.samples = new Float32Array(21);
    const inv = root.getWorldQuaternion(quat()).invert();
    this.center = v3();
    this.legLength = 0;
    this.feet = controller.legs.map(leg => {
      const foot = leg.foot.getWorldPosition(v3()), ball = leg.toe.getWorldPosition(v3());
      const hip = leg.hip.getWorldPosition(v3()), knee = leg.knee.getWorldPosition(v3());
      const length = hip.distanceTo(knee) + knee.distanceTo(foot);
      this.legLength += length * .5;
      this.center.addScaledVector(root.worldToLocal(hip), .5);
      const offset = ball.clone().sub(foot).applyQuaternion(inv);
      const pitch = Math.atan2(offset.y, Math.hypot(offset.x, offset.z));
      const heading = Math.atan2(offset.x, offset.z);
      // Foot rotation when ball-to-ankle is aligned with the forward axis;
      // later compose the authored world heading and pitch onto this frame.
      const neutral = fromAngle(UP, -heading).multiply(inv.clone()).multiply(leg.foot.getWorldQuaternion(quat()));
      neutral.premultiply(fromAngle(new THREE.Vector3(1, 0, 0), pitch));
      return { length, offset: leg.foot.worldToLocal(ball), neutral, lock: v3(), stance: false, locked: false, weight: 0 };
    });
    this.reset();
  }

  reset() {
    this.phase = this.reachDrop = 0;
    this.direction.set(0, 1);
    for (const foot of this.feet) { foot.stance = foot.locked = false; foot.weight = 0; }
  }

  update(dt, state, samples) {
    const { controller: motion, clips, root } = this;
    const { speed, motionWeight, crouchWeight, airWeight, landing } = motion;
    const moving = motionWeight * (1 - airWeight);
    if (Math.hypot(state.forward || 0, state.strafe || 0) > .06) {
      this.direction.lerp(new THREE.Vector2(-(state.strafe || 0), state.forward || 0).normalize(), ease(15, dt));
    }
    const { x, y: z } = this.direction;
    const sum = Math.abs(x) + Math.abs(z) || 1;
    const forwardWeight = Math.max(0, z) / sum;
    const running = smoothstep(speed, 2.65, 4.8);
    const weights = [[clips.walk, forwardWeight * (1 - running)], [clips.run, forwardWeight * running],
      [clips.back, Math.max(0, -z) / sum], [x < 0 ? clips.negativeX : clips.positiveX, Math.abs(x) / sum]];
    const dx = weights.reduce((n, [clip, w]) => n + clip.x * w, 0);
    const dz = weights.reduce((n, [clip, w]) => n + clip.z * w, 0);
    const shortStep = (1 - crouchWeight * .26) * lerp(.58, 1, smoothstep(speed, .3, 2.3));
    const cycleLength = Math.max(.45, Math.hypot(dx, dz) * this.legLength * shortStep);
    const distance = Number.isFinite(state.distance) ? Math.max(0, state.distance) : speed * dt;
    this.phase = (this.phase + Math.min(.24, distance / cycleLength) * (1 - airWeight)) % 1;
    motion.gait = { phase: this.phase * TAU, frequency: speed / cycleLength, speed };
    const frame = this.samples;
    frame.fill(0);
    for (const [clip, weight] of weights) {
      if (weight < .0001) continue;
      const point = this.phase * clip.frames.length;
      const i = Math.floor(point), a = clip.frames[i], b = clip.frames[(i + 1) % clip.frames.length];
      for (let j = 0; j < frame.length; j++) frame[j] += lerp(a[j], b[j], point - i) * weight;
    }

    const rootQ = root.getWorldQuaternion(quat());
    const forward = FWD.clone().applyQuaternion(rootQ);
    const left = v3().crossVectors(UP, forward);
    const ground = root.localToWorld(v3().set(this.center.x, 0, this.center.z));
    const scale = this.legLength;
    const targets = samples.map((sample, i) => {
      const { leg } = sample, foot = this.feet[i], j = 5 + 8 * i;
      const orientation = rootQ.clone().multiply(fromAngle(UP, frame[j + 3]))
        .multiply(fromAngle(new THREE.Vector3(1, 0, 0), -frame[j + 4])).multiply(foot.neutral);
      const ballOffset = foot.offset.clone().multiply(leg.foot.getWorldScale(v3())).applyQuaternion(orientation);
      const ball = ground.clone().addScaledVector(left, frame[j] * scale * shortStep)
        .addScaledVector(forward, frame[j + 2] * scale * shortStep)
        .addScaledVector(UP, .035 + frame[j + 1] * scale * (1 - crouchWeight * .44));

      // Hold a contact in world space. Release it before an unreachable step,
      // on a floor change, or as the source pose enters swing.
      const contact = frame[j + 7];
      const plant = state.grounded !== false && moving > .55 && contact > .66;
      if (plant && !foot.stance) { foot.lock.copy(ball); foot.locked = true; }
      foot.stance = plant;
      const error = ball.distanceTo(foot.lock);
      if (!plant || error > scale * .31 || Math.abs(ball.y - foot.lock.y) > .14) foot.locked = false;
      const lockWeight = foot.locked ? 1 - smoothstep(error, scale * .11, scale * .31) : 0;
      foot.weight = lerp(foot.weight, lockWeight, ease(foot.locked ? 28 : 23, dt));
      if (foot.weight > .001 && error < scale * .31) {
        ball.x = lerp(ball.x, foot.lock.x, foot.weight);
        ball.z = lerp(ball.z, foot.lock.z, foot.weight);
      }

      const rest = sample.restPole.lengthSq() > 1e-8 ? sample.restPole.clone().normalize() : forward.clone();
      const kneeYaw = clamp(frame[j + 5], -.82, .82), kneePitch = frame[j + 6] * .7;
      const pole = forward.clone().multiplyScalar(Math.cos(kneeYaw) * Math.cos(kneePitch))
        .addScaledVector(left, Math.sin(kneeYaw) * Math.cos(kneePitch)).addScaledVector(UP, Math.sin(kneePitch));
      rest.lerp(pole, moving).normalize();
      const position = sample.foot.clone().lerp(ball.sub(ballOffset), moving)
        .addScaledVector(UP, airWeight * scale * (i === 0 ? .19 : .14));
      return { leg, position, orientation: sample.orientation.clone().slerp(orientation, moving), pole: rest };
    });

    if (motion.bodyRoot) {
      const hipMid = samples[0].hip.clone().add(samples[1].hip).multiplyScalar(.5);
      const rise = ground.y + scale * (1.015 + frame[1]) - hipMid.y;
      const offset = left.clone().multiplyScalar(frame[0] * scale * moving)
        .addScaledVector(forward, frame[2] * scale * moving)
        .addScaledVector(UP, rise * moving - scale * (.39 * crouchWeight + .05 * landing));
      let drop = 0;
      for (let i = 0; i < targets.length; i++) {
        const gap = samples[i].hip.clone().add(offset).sub(targets[i].position);
        const reach = this.feet[i].length * .99;
        const verticalRoom = Math.sqrt(Math.max(.04, reach * reach - gap.x * gap.x - gap.z * gap.z));
        drop = Math.max(drop, gap.y - verticalRoom);
      }
      this.reachDrop = lerp(this.reachDrop, Math.min(.18, drop) * moving, ease(32, dt));
      offset.y -= this.reachDrop;
      const body = motion.bodyRoot;
      body.position.copy(body.parent.worldToLocal(body.getWorldPosition(v3()).add(offset)));
      body.updateWorldMatrix(false, true);
      motion._rotateWorld(motion.bones.Pelvis, UP, clamp(frame[3], -.36, .36) * moving);
      motion._rotateWorld(motion.bones.Pelvis, forward, frame[4] * moving);
    }
    if (Math.max(moving, crouchWeight, airWeight, landing) > .0001) {
      for (const { leg, position, pole, orientation } of targets) motion._solveLeg(leg, position, pole, orientation);
    }
  }
}
