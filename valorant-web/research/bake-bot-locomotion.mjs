// node research/bake-bot-locomotion.mjs path/to/GodotTPS/player.glb
import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const source = 'https://github.com/godotengine/tps-demo/tree/a82f15448e9b015440d3bbdf5e10801b260c4e9f';
// Align left-foot contact when blending cycles. The lateral keys describe
// source coordinates: +X is the side of the source rig's L_ leg.
const names = { walk: ['walking_gun-cycle', 8], run: ['running_gun-cycle', 14], back: ['strafe_back-cycle', 26], negativeX: ['strafe_left-cycle', 22], positiveX: ['strafe_right-cycle', 0] };
const frames = 48;
globalThis.ProgressEvent ||= class { constructor(type, data) { Object.assign(this, { type, ...data }); } };

const bytes = fs.readFileSync(process.argv[2]);
const jsonSize = bytes.readUInt32LE(12), offset = 28 + jsonSize;
const gltf = JSON.parse(bytes.toString('utf8', 20, 20 + jsonSize));
// Export sampled skeleton motion alone. Do not redistribute the demo's mesh,
// textures or unused animation tracks in the game.
for (const field of ['meshes', 'materials', 'skins', 'textures', 'images', 'samplers']) delete gltf[field];
for (const node of gltf.nodes) { delete node.mesh; delete node.skin; }
gltf.animations = gltf.animations.filter(a => Object.values(names).some(([name]) => a.name === name));
gltf.buffers[0].uri = 'data:application/octet-stream;base64,' + bytes.subarray(offset, offset + bytes.readUInt32LE(offset - 8)).toString('base64');
const { scene, animations } = await new GLTFLoader().parseAsync(JSON.stringify(gltf), '');
const byName = Object.fromEntries(gltf.nodes.map(node => [node.name, scene.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(node.name))]));
const pos = name => byName[name].getWorldPosition(new THREE.Vector3());
const direction = (a, b) => b.clone().sub(a).normalize();
const legLength = ['L', 'R'].reduce((total, side) => total + pos(`thigh.${side}`).distanceTo(pos(`knee.${side}`)) + pos(`knee.${side}`).distanceTo(pos(`foot.${side}`)), 0) / 2;
const round = n => Math.round(n * 1e5) / 1e5;
const clipData = {};

for (const [key, [name, phaseOffset]] of Object.entries(names)) {
  const clip = animations.find(c => c.name === name);
  const mixer = new THREE.AnimationMixer(scene);
  const action = mixer.clipAction(clip).setLoop(THREE.LoopOnce, 0);
  action.clampWhenFinished = true; action.play();
  const poses = [];
  for (let i = 0; i <= frames; i++) {
    mixer.setTime(i / frames * clip.duration);
    scene.updateMatrixWorld(true);
    const hips = pos('hips'), leftHip = pos('thigh.L'), rightHip = pos('thigh.R');
    const left = direction(rightHip, leftHip), mid = leftHip.clone().add(rightHip).multiplyScalar(.5);
    const data = { hips, mid, left, root: pos('root'), legs: ['L', 'R'].map(side => {
      const hip = pos(`thigh.${side}`), knee = pos(`knee.${side}`), foot = pos(`foot.${side}`), toe = pos(`toe.${side}`);
      const axis = direction(hip, foot), bend = knee.clone().sub(hip);
      const pole = bend.addScaledVector(axis, -bend.dot(axis)).normalize();
      return { foot, toe, heading: direction(foot, toe), pole };
    }) };
    poses.push(data);
  }
  action.stop();
  const rootTravel = poses[frames].root.clone().sub(poses[0].root);
  rootTravel.y = 0;
  poses.pop();
  const height = poses.reduce((sum, pose) => sum + pose.mid.y, 0) / frames;
  const center = poses.reduce((sum, pose) => sum.add(pose.mid.clone().sub(pose.root)), new THREE.Vector3()).divideScalar(frames);
  const floor = Math.min(...poses.flatMap(pose => pose.legs.map(leg => leg.toe.y)));
  const strideScale = key === 'run' ? .77 : .92;
  clipData[key] = {
    name, duration: round(clip.duration), x: round(rootTravel.x / legLength * strideScale), z: round(rootTravel.z / legLength * strideScale),
    // Samples: pelvis dx/dy/dz, pelvis yaw and roll, then eight values per
    // foot (ball dx/dy/dz, heading, pitch, knee heading, knee elevation, contact).
    frames: poses.map((_, i) => {
      const { mid, left, root, legs } = poses[(i + phaseOffset) % frames];
      const scale = strideScale / legLength;
      return [(mid.x - root.x - center.x) * scale, (mid.y - height) / legLength * .62, (mid.z - root.z - center.z) * scale,
        -Math.atan2(left.z, left.x), Math.asin(left.y), ...legs.flatMap(({ toe, heading, pole }) => {
          const lift = Math.max(0, toe.y - floor);
          return [(toe.x - root.x - center.x) * scale, lift / legLength * (key === 'run' ? .61 : .83), (toe.z - root.z - center.z) * scale,
            Math.atan2(heading.x, heading.z), Math.asin(heading.y), Math.atan2(pole.x, pole.z), Math.asin(pole.y),
            1 - THREE.MathUtils.smoothstep(lift, .014, .068)];
        })].map(round);
    })
  };
  if (process.env.VW_DUMP_LOCOMOTION) {
    console.log(key, clip.duration, legLength.toFixed(3));
    for (let i = 0; i <= frames; i += 4) {
      const { hips, mid, left, root, legs } = poses[i];
      const pack = (...vecs) => vecs.map(v => v.toArray().map(n => +n.toFixed(2)).join(',')).join(' | ');
      console.log(i / frames, pack(root, hips, mid, left, ...legs.flatMap(v => [v.foot, v.toe, v.pole])));
    }
  }
}

fs.writeFileSync(new URL('../assets/animations/bot-locomotion.json', import.meta.url), JSON.stringify({ source, license: 'CC-BY-3.0', clips: clipData }) + '\n', 'utf8');
