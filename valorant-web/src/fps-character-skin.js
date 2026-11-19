import * as THREE from 'three';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { filterArmGeometry } from './view-arms.js';

const fingers = ['Index', 'Middle', 'Ring', 'Pinky', 'Thumb'];
const sourceFingers = [5, 9, 13, 17, 20];
// Idle reference directions in the view camera. The donor's right elbow and
// left shoulder are hidden by its own camera and sit inside our wider frame.
const idleRightForearm = new THREE.Vector3(-.32, .53, -.79).normalize();
const idleRightUpperArm = new THREE.Vector3(-.15, .93, -.33).normalize();
const idleLeftUpperArm = new THREE.Vector3(-.34, .88, -.34).normalize();
const idleLeftForearm = new THREE.Vector3(.32, .84, -.44).normalize();
const phantomCurl = [[-.35, -1.15, -.8], [-.8, -1.6, -1.45], [-.8, -1.6, -1.45], [-.8, -1.6, -1.5]];
const v = () => new THREE.Vector3();
const q = () => new THREE.Quaternion();
const position = (bone) => v().setFromMatrixPosition(bone.matrixWorld);
const rotation = (bone) => q().setFromRotationMatrix(new THREE.Matrix4().extractRotation(bone.matrixWorld));
const direction = (a, b) => position(b).sub(position(a)).normalize();

function frame(along, across) {
  const y = across.clone().projectOnPlane(along).normalize();
  return q().setFromRotationMatrix(new THREE.Matrix4().makeBasis(along, y, v().crossVectors(along, y)));
}

function setRotation(bone, world) {
  bone.quaternion.copy(rotation(bone.parent).invert().multiply(world)).normalize();
  bone.updateMatrixWorld(true);
}

function armGeometry(mesh) {
  const source = mesh.geometry;
  const joints = source.attributes.skinIndex;
  const weights = source.attributes.skinWeight;
  const arms = mesh.skeleton.bones.map((bone) => /^[LR]_(Shoulder_|Elbow|Hand|Thumb|Index|Middle|Pinky|Ring|Sleeve)/.test(bone.name) && !/shoulder_?pad/i.test(bone.name));
  const armWeight = new Float32Array(weights.count);
  for (let i = 0; i < weights.count; i++) {
    for (let j = 0; j < 4; j++) if (arms[joints.getComponent(i, j)]) armWeight[i] += weights.getComponent(i, j);
  }
  const geometry = filterArmGeometry(source, (i) => armWeight[i] > .45, Array.isArray(mesh.material));
  // The arm roots move with the authored clip. Discard residual torso weights
  // at the cropped shoulder, otherwise those vertices stay back on the torso.
  const skin = new Float32Array(weights.count * 4);
  for (const i of new Set(geometry.index.array)) {
    for (let j = 0; j < 4; j++) if (arms[joints.getComponent(i, j)]) skin[4 * i + j] = weights.getComponent(i, j) / armWeight[i];
  }
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skin, 4));
  return geometry;
}

export class FPSCharacterSkin {
  constructor(asset, driver, root, contacts, name) {
    this.model = clone(asset.scene);
    this.model.name = `FirstPersonArms_${name}`;
    this.model.scale.multiplyScalar(.82);
    this.geometries = [];
    this.skeletons = new Set();
    const target = new Map();
    const source = new Map();
    this.model.traverse((bone) => { if (bone.isBone) target.set(bone.name.replace(/_\d+$/, ''), bone); });
    driver.traverse((bone) => { if (bone.isBone) source.set(bone.name.replace(/_\d+$/, ''), bone); });
    this.model.traverse((mesh) => {
      if (!mesh.isMesh) return;
      if (!mesh.isSkinnedMesh) { mesh.visible = false; return; }
      this.skeletons.add(mesh.skeleton);
      mesh.geometry = armGeometry(mesh);
      this.geometries.push(mesh.geometry);
      mesh.visible = mesh.visible && mesh.geometry.index.count > 0;
      mesh.frustumCulled = mesh.castShadow = mesh.receiveShadow = false;
      mesh.renderOrder = 8;
    });
    this.model.updateMatrixWorld(true);
    this.arms = {};
    for (const side of ['L', 'R']) {
      const bone = (key) => target.get(`${side}_${key}`);
      const from = (key) => source.get(`${key}_${side}`);
      const [upper, elbow, hand, socket] = ['Shoulder', 'Elbow', 'Hand', 'WeaponPoint'].map(bone);
      const [sourceUpper, sourceElbow, sourceHand] = ['UpArm', 'Forearm', 'Hand'].map(from);
      const digits = fingers.map((finger, i) => [0, 1, 2].map((j) => ({
        bone: bone(`${finger}${j + 1}`),
        source: source.get(`Bone_${side}${String(sourceFingers[i] + j).padStart(3, '0')}`),
      })));
      if (!upper || elbow?.parent !== upper || hand?.parent !== elbow || socket?.parent !== hand
        || !sourceUpper || !sourceElbow || !sourceHand || digits.flat().some((joint) => !joint.bone || !joint.source)) {
        throw new Error(`Missing ${name} ${side} arm retarget joints`);
      }
      for (const [fingerIndex, digit] of digits.entries()) {
        for (let i = 0; i < digit.length; i++) {
          const joint = digit[i];
          joint.rest = joint.bone.quaternion.clone();
          joint.axis = digit[i + 1]?.bone.position.clone().normalize() || new THREE.Vector3(side === 'R' ? -1 : 1, 0, 0);
          joint.sourceAxis = joint.source.children.find((child) => child.isBone).position.clone().normalize();
          if (side === 'R') {
            if (phantomCurl[fingerIndex]) {
              const grip = joint.bone.rotation.clone();
              grip.z = phantomCurl[fingerIndex][i];
              joint.grip = q().setFromEuler(grip);
            } else joint.grip = joint.rest;
            const gripLocal = joint.sourceAxis.clone().applyQuaternion(joint.source.quaternion);
            joint.sourceGripDirection = gripLocal;
          }
        }
      }
      const targetPalm = frame(direction(hand, digits[1][0].bone), direction(digits[0][0].bone, digits[3][0].bone));
      const sourcePalm = frame(direction(sourceHand, digits[1][0].source), direction(digits[0][0].source, digits[3][0].source));
      const palmOffset = rotation(sourceHand).invert().multiply(sourcePalm).multiply(targetPalm.invert()).multiply(rotation(hand));
      const upperAxis = direction(upper, elbow);
      const lowerAxis = direction(elbow, hand);
      const hinge = v().crossVectors(upperAxis, lowerAxis).normalize();
      const sourceUpperAxis = direction(sourceUpper, sourceElbow);
      const sourceLowerAxis = direction(sourceElbow, sourceHand);
      const sourceHinge = v().crossVectors(sourceUpperAxis, sourceLowerAxis).normalize();
      const cameraRotation = rotation(root.parent || root);
      this.arms[side] = {
        upper, elbow, hand, socket, sourceUpper, sourceElbow, sourceHand, digits, palmOffset,
        upperMapping: rotation(sourceUpper).invert().multiply(frame(sourceUpperAxis, sourceHinge))
          .multiply(frame(upperAxis, hinge).invert()).multiply(rotation(upper)),
        forearmFromPalm: rotation(hand).invert().multiply(rotation(elbow)),
        gripDriverRest: rotation(contacts[side]).invert().multiply(rotation(sourceHand)).invert(),
        upperReference: (side === 'R' ? idleRightUpperArm : idleLeftUpperArm).clone().applyQuaternion(cameraRotation).applyQuaternion(rotation(sourceUpper).invert()),
        lowerReference: (side === 'R' ? idleRightForearm : idleLeftForearm).clone().applyQuaternion(cameraRotation).applyQuaternion(rotation(sourceElbow).invert()),
        upperAxis: elbow.position.clone().normalize(), lowerAxis: hand.position.clone().normalize(),
        upperLength: position(upper).distanceTo(position(elbow)), lowerLength: position(elbow).distanceTo(position(hand)),
        wristRest: hand.quaternion.clone(),
        twist: elbow.children.filter((joint) => /_Twst3_/.test(joint.name)).map((joint) => [joint, joint.quaternion.clone()]),
      };
    }
    root.add(this.model);
  }

  update(contacts, supportWeight, magazineContact, magazineWeight) {
    this.model.updateMatrixWorld(true);
    for (const side of ['L', 'R']) {
      const a = this.arms[side];
      const sourcePalmRotation = rotation(a.sourceHand);
      const handQ = side === 'R' ? sourcePalmRotation.clone().multiply(a.gripDriverRest) : sourcePalmRotation.clone().multiply(a.palmOffset);
      const upper = a.upperReference.clone().transformDirection(a.sourceUpper.matrixWorld);
      const lower = a.lowerReference.clone().transformDirection(a.sourceElbow.matrixWorld);
      const forearmQ = handQ.clone().multiply(a.forearmFromPalm);
      const neutral = a.lowerAxis.clone().applyQuaternion(forearmQ);
      const swing = q().setFromUnitVectors(neutral, lower);
      const angle = neutral.angleTo(lower);
      const limit = THREE.MathUtils.degToRad(38);
      const palmCorrection = q();
      if (angle > limit) {
        if (side === 'R') lower.copy(neutral).applyQuaternion(q().slerp(swing, limit / angle));
        else handQ.premultiply(palmCorrection.slerp(swing, 1 - limit / angle));
      }
      const wrist = position(a.sourceHand);
      const weight = side === 'R' ? 1 : supportWeight;
      const socketOffset = a.socket.position.clone().multiplyScalar(a.lowerLength / a.hand.position.length()).applyQuaternion(handQ);
      if (weight > 0) wrist.lerp(position(contacts[side]).sub(socketOffset), weight);
      if (side === 'L' && magazineWeight > 0) wrist.lerp(position(magazineContact).sub(socketOffset), magazineWeight);
      const shoulder = wrist.addScaledVector(lower, -a.lowerLength).addScaledVector(upper, -a.upperLength);
      a.upper.position.copy(a.upper.parent.worldToLocal(shoulder));
      const upperQ = rotation(a.sourceUpper).multiply(a.upperMapping);
      upperQ.premultiply(q().setFromUnitVectors(a.upperAxis.clone().applyQuaternion(upperQ), upper));
      setRotation(a.upper, upperQ);
      // Carry the palm's axial roll through the forearm. The last helper
      // shares only the remaining wrist bend, which keeps the cuff continuous.
      forearmQ.premultiply(q().setFromUnitVectors(neutral, lower));
      setRotation(a.elbow, forearmQ);
      setRotation(a.hand, handQ);
      const bend = a.hand.quaternion.clone().multiply(a.wristRest.clone().invert());
      for (const [joint, rest] of a.twist) joint.quaternion.copy(q().slerp(bend, .8)).multiply(rest);

      for (const digit of a.digits) for (const joint of digit) {
        if (joint.grip) {
          const current = joint.sourceAxis.clone().applyQuaternion(joint.source.quaternion);
          const delta = q().setFromUnitVectors(joint.sourceGripDirection, current);
          joint.bone.quaternion.copy(joint.grip).multiply(delta);
          joint.bone.updateMatrixWorld(true);
          continue;
        }
        const rest = rotation(joint.bone.parent).multiply(joint.rest);
        const goal = joint.sourceAxis.clone().transformDirection(joint.source.matrixWorld).applyQuaternion(palmCorrection);
        rest.premultiply(q().setFromUnitVectors(joint.axis.clone().applyQuaternion(rest), goal));
        setRotation(joint.bone, rest);
      }
    }
    this.model.updateMatrixWorld(true);
  }

  dispose() {
    this.model.removeFromParent();
    this.geometries.forEach((geometry) => geometry.dispose());
    this.skeletons.forEach((skeleton) => skeleton.dispose());
  }
}
