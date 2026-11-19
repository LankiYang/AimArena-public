// UTF-8. Actual weighted skin-matrix regression for the Jett/Sage wrist seam.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {ViewArms} from '../src/view-arms.js';
import {createFirstPersonPhantom} from '../src/weapon-model.js';
globalThis.ProgressEvent ||= class{constructor(type,data){Object.assign(this,{type,...data});}};
async function loadRig(name){
 const bytes=fs.readFileSync(new URL(`../assets/agents/${name}.glb`,import.meta.url)),n=bytes.readUInt32LE(12),j=JSON.parse(bytes.toString('utf8',20,20+n));
 delete j.images;delete j.textures;j.materials?.forEach(m=>{delete m.pbrMetallicRoughness?.baseColorTexture;delete m.pbrMetallicRoughness?.metallicRoughnessTexture;delete m.normalTexture;delete m.emissiveTexture;delete m.occlusionTexture;});
 j.buffers[0].uri='data:application/octet-stream;base64,'+bytes.subarray(28+n,28+n+bytes.readUInt32LE(20+n)).toString('base64');return new GLTFLoader().parseAsync(JSON.stringify(j),'');
}
const j=JSON.parse(fs.readFileSync(new URL('../assets/weapons/res-phantom/scene.gltf',import.meta.url),'utf8'));
for(const b of j.buffers)b.uri='data:application/octet-stream;base64,'+fs.readFileSync(new URL('../assets/weapons/res-phantom/'+b.uri,import.meta.url)).toString('base64');
const phantom=await new GLTFLoader().parseAsync(JSON.stringify(j),'');
const summary=values=>{const v=values.slice().sort((a,b)=>a-b);return{count:v.length,min:v[0],p05:v[Math.floor(v.length*.05)],median:v[Math.floor(v.length*.5)]};};
function wristVertices(arms,side){
 const output=[];
 arms.model.traverse(mesh=>{if(!mesh.isSkinnedMesh||!mesh.visible)return;const hi=mesh.skeleton.bones.indexOf(arms.bones[side+'_Hand']),ti=mesh.skeleton.bones.findIndex(b=>new RegExp('^'+side+'_Elbow_Twst3_\\d+$').test(b.name)),si=mesh.geometry.attributes.skinIndex,sw=mesh.geometry.attributes.skinWeight;
  for(const index of new Set(mesh.geometry.index.array)){let wh=0,wt=0;for(let c=0;c<4;c++){if(si.array[index*4+c]===hi)wh+=sw.array[index*4+c];if(si.array[index*4+c]===ti)wt+=sw.array[index*4+c];}if(wh>.15&&wt>.15)output.push({mesh,index});}
 });assert.ok(output.length>50,`${side}: actual Hand/Twst3 mixed seam must be represented`);return output;
}
function deformationDeterminants(vertices){
 const determinants=[];const boneMatrix=new THREE.Matrix4(),blend=new THREE.Matrix4(),linear=new THREE.Matrix3();
 for(const{mesh,index}of vertices){const si=mesh.geometry.attributes.skinIndex,sw=mesh.geometry.attributes.skinWeight,sk=mesh.skeleton;blend.elements.fill(0);let normalizer=0;
  for(let c=0;c<4;c++){const weight=sw.array[index*4+c];if(!weight)continue;const bi=si.array[index*4+c];boneMatrix.multiplyMatrices(sk.bones[bi].matrixWorld,sk.boneInverses[bi]);const determinant=linear.setFromMatrix4(boneMatrix).determinant();normalizer+=Math.cbrt(Math.abs(determinant))*weight;for(let e=0;e<16;e++)blend.elements[e]+=boneMatrix.elements[e]*weight;}
  // Strip the common world/model scale. For rigid skin transforms this ratio is
  // 1; an LBS 180-degree cancellation drives it towards 0 and pinches the seam.
  const determinant=linear.setFromMatrix4(blend).determinant()/normalizer**3;assert.ok(Number.isFinite(determinant),'finite weighted skin Jacobian');determinants.push(determinant);
 }return determinants;
}
const results=[];
for(const name of ['jett','sage']){
 const asset=await loadRig(name),camera=new THREE.PerspectiveCamera(),arms=new ViewArms(asset,camera),weapon=createFirstPersonPhantom(phantom.scene),gunRoot=new THREE.Group();camera.add(gunRoot);gunRoot.add(weapon.group);gunRoot.position.set(.24,-.23,-.4);camera.updateMatrixWorld(true);arms.bindWeapon(weapon.anchors);
 const seam=Object.fromEntries(['L','R'].map(s=>[s,wristVertices(arms,s)])),helpers=[];arms.model.traverse(b=>{if(b.isBone&&/^[LR]_Elbow_Twst[23]_\d+$/.test(b.name))helpers.push(b);});assert.equal(helpers.length,4);
 const fixed={L:[],R:[]},broken={L:[],R:[]},worstSocket={L:0,R:0},maxHelperStep={L:0,R:0},previousHelper=new Map();
 for(let frame=0;frame<240;frame++){
  const time=frame/60,recoil=frame%60<6?.07:0,bob=frame*.15;camera.position.set(Math.sin(time)*10,2+time,-30);camera.rotation.set(Math.sin(time)*.5,time,0,'YXZ');
  gunRoot.position.set(.24+Math.sin(bob)*.006,-.23+Math.abs(Math.cos(bob))*.009-recoil*.35,-.4+recoil);gunRoot.rotation.set(recoil*1.5,0,Math.sin(time*5)*.4);camera.updateMatrixWorld(true);arms.update(1/60);arms.model.updateMatrixWorld(true);
  for(const b of helpers){const previous=previousHelper.get(b),side=b.name[0];if(previous)maxHelperStep[side]=Math.max(maxHelperStep[side],previous.angleTo(b.quaternion));previousHelper.set(b,b.quaternion.clone());}
  for(const side of ['L','R']){fixed[side].push(...deformationDeterminants(seam[side]));worstSocket[side]=Math.max(worstSocket[side],arms.bones[side+'_WeaponPoint'].getWorldPosition(new THREE.Vector3()).distanceTo(weapon.anchors[side].getWorldPosition(new THREE.Vector3())));}
  // Exact negative control for the reported bug: retain every primary bone and
  // the gun-aligned palm, but return the unanimated sibling skin helpers to rest.
  const saved=helpers.map(b=>b.quaternion.clone());helpers.forEach(b=>b.quaternion.copy(arms.restRotations.get(b)||new THREE.Quaternion()));arms.model.updateMatrixWorld(true);
  for(const side of ['L','R'])broken[side].push(...deformationDeterminants(seam[side]));helpers.forEach((b,i)=>b.quaternion.copy(saved[i]));arms.model.updateMatrixWorld(true);
 }
 const result={agent:name,seamVertices:Object.fromEntries(['L','R'].map(s=>[s,seam[s].length])),fixed:Object.fromEntries(['L','R'].map(s=>[s,summary(fixed[s])])),helpersAtRest:Object.fromEntries(['L','R'].map(s=>[s,summary(broken[s])])),worstSocket,maxHelperStep};
 for(const side of ['L','R']){
  // A determinant measures local volume rather than only skeletal lengths.
  // The source seam blends a bent wrist, so demand a conservative 65% volume
  // floor instead of an unrealistic determinant of exactly 1.
  assert.ok(result.fixed[side].min>.65,`${name} ${side}: near-wrist skin collapses below 65% local volume`);
  assert.ok(result.fixed[side].p05>.70,`${name} ${side}: too many mixed wrist vertices lose volume`);
  assert.ok(worstSocket[side]<.001,`${name} ${side}: skin correction must preserve the exact palm anchor`);
  assert.ok(result.helpersAtRest[side].p05<.10,`${name} ${side}: negative control should reproduce the sugar-wrapper pinch`);
  assert.ok(result.fixed[side].p05>result.helpersAtRest[side].p05*5,`${name} ${side}: helpers must materially repair actual weighted deformation`);
 }
 results.push(result);arms.dispose();weapon.dispose();gunRoot.removeFromParent();
}
fs.writeFileSync(new URL('./wrist-skin-results.json',import.meta.url),JSON.stringify(results,null,2)+'\n','utf8');
console.log(JSON.stringify(results,null,2));
console.log('Actual wrist-skin volume self-test passed, including helpers-at-rest negative control.');
