// UTF-8. Exercise real Jett/Sage rigs with the first-person two-bone IK.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ViewArms, filterArmGeometry } from '../src/view-arms.js';
import { createFirstPersonPhantom } from '../src/weapon-model.js';
globalThis.ProgressEvent=class{constructor(type,data){Object.assign(this,{type,...data});}};
async function loadRig(name){
  const bytes=fs.readFileSync(new URL(`../assets/agents/${name}.glb`,import.meta.url)),length=bytes.readUInt32LE(12),json=JSON.parse(bytes.toString('utf8',20,20+length));
  const binary=bytes.subarray(28+length,28+length+bytes.readUInt32LE(20+length));
  delete json.images;delete json.textures;
  json.materials?.forEach(m=>{delete m.pbrMetallicRoughness?.baseColorTexture;delete m.pbrMetallicRoughness?.metallicRoughnessTexture;delete m.normalTexture;delete m.emissiveTexture;delete m.occlusionTexture;});
  json.buffers[0].uri='data:application/octet-stream;base64,'+binary.toString('base64');
  return new GLTFLoader().parseAsync(JSON.stringify(json),'');
}
async function loadPhantom(){
  const base=new URL('../assets/weapons/res-phantom/',import.meta.url);
  const json=JSON.parse(fs.readFileSync(new URL('scene.gltf',base),'utf8'));
  for(const buffer of json.buffers)buffer.uri='data:application/octet-stream;base64,'+fs.readFileSync(new URL(buffer.uri,base)).toString('base64');
  return new GLTFLoader().parseAsync(JSON.stringify(json),'');
}
const phantom=await loadPhantom();
// Object_94 is the imported pistol-grip mesh. Distances below use its actual
// triangles; no fabricated screen-space hand target or matching Euler values.
const gripMesh=phantom.scene.getObjectByName('Object_94');assert.ok(gripMesh?.isMesh,'real Phantom pistol grip is present');
phantom.scene.updateMatrixWorld(true);
const gripTriangles=[],gp=gripMesh.geometry.attributes.position,gi=gripMesh.geometry.index;
for(let i=0;i<(gi?.count||gp.count);i+=3)gripTriangles.push(new THREE.Triangle(...[0,1,2].map(k=>new THREE.Vector3().fromBufferAttribute(gp,gi?gi.getX(i+k):i+k).applyMatrix4(gripMesh.matrixWorld))));
function findBone(model,key){let result;model.traverse(b=>{if(b.isBone&&new RegExp('^'+key+'_\\d+$').test(b.name))result=b;});assert.ok(result,`real ${key} bone exists`);return result;}
function measureFingerGrip(arms,weapon){
  const gun=weapon.group.children[0],unit=gun.getWorldScale(new THREE.Vector3()).x,closest=new THREE.Vector3(),local=new THREE.Vector3();
  function surfaceDistance(world){gun.worldToLocal(local.copy(world));let distance=Infinity;for(const triangle of gripTriangles)distance=Math.min(distance,triangle.closestPointToPoint(local,closest).distanceTo(local));return distance*unit;}
  const landmarks={};
  for(const finger of ['Middle','Ring','Pinky']){
    const bones=[1,2,3].map(n=>findBone(arms.model,'R_'+finger+n)),positions=bones.map(b=>b.getWorldPosition(new THREE.Vector3()));
    const proximal=positions[1].clone().sub(positions[0]).normalize(),distal=new THREE.Vector3(-1,0,0).applyQuaternion(bones[2].getWorldQuaternion(new THREE.Quaternion())).normalize();
    const skin=[];
    arms.model.traverse(mesh=>{if(!mesh.isSkinnedMesh||!mesh.visible)return;const boneIndex=mesh.skeleton.bones.indexOf(bones[2]);if(boneIndex<0)return;const si=mesh.geometry.attributes.skinIndex,sw=mesh.geometry.attributes.skinWeight;
      for(const index of new Set(mesh.geometry.index.array)){let weight=0;for(let c=0;c<4;c++)if(si.array[index*4+c]===boneIndex)weight+=sw.array[index*4+c];if(weight<.6)continue;const point=mesh.localToWorld(mesh.getVertexPosition(index,new THREE.Vector3()));skin.push({point,axis:bones[2].worldToLocal(point.clone()).x});}
    });
    assert.ok(skin.length>20,`${finger} has actual distal skinned vertices`);skin.sort((a,b)=>a.axis-b.axis);
    // The terminal dummy points along +Y in this rig. Locate the fingertip from
    // its real distal skin along -X instead of trusting that dummy bone.
    const tips=skin.slice(0,Math.max(6,Math.ceil(skin.length*.2))),tip=tips.reduce((p,s)=>p.add(s.point),new THREE.Vector3()).multiplyScalar(1/tips.length);
    landmarks[finger]={proximalDistalDot:proximal.dot(distal),tipSurfaceDistance:surfaceDistance(tip),closestTipSkinDistance:Math.min(...tips.map(s=>surfaceDistance(s.point))),distalJointSurfaceDistance:surfaceDistance(positions[2]),tipInWeaponMetres:gun.worldToLocal(tip.clone()).multiplyScalar(unit).toArray(),skinVertices:skin.length};
  }
  return landmarks;
}
function assertFingerGrip(landmarks,label){
  for(const[finger,pose]of Object.entries(landmarks)){
    // These anatomical/geometry constraints permit pose refinement while
    // rejecting fingers that still extend in the source idle direction.
    assert.ok(pose.proximalDistalDot<-.4,`${label} ${finger}: distal finger must return around the pistol grip`);
    assert.ok(pose.tipSurfaceDistance<.015,`${label} ${finger}: real fingertip is too far from the grip triangles`);
    assert.ok(pose.closestTipSkinDistance<.015,`${label} ${finger}: distal skin must remain near the physical grip`);
    assert.ok(pose.distalJointSurfaceDistance<.04,`${label} ${finger}: distal joint overshoots the physical grip`);
  }
}
const results=[];
// An actual material-index regression: filtering removes triangles from three
// source groups and an active drawRange, so old offsets would draw wrong slots.
const grouped=new THREE.BufferGeometry();grouped.setAttribute('position',new THREE.Float32BufferAttribute(Array.from({length:72},(_,i)=>Math.sin(i)),3));grouped.setIndex(Array.from({length:24},(_,i)=>i));
grouped.addGroup(0,9,0);grouped.addGroup(9,9,1);grouped.addGroup(18,6,2);grouped.setDrawRange(6,15);
const filtered=filterArmGeometry(grouped,index=>[2,4,6].includes(Math.floor(index/3)),true);
assert.deepEqual([...filtered.index.array],[6,7,8,12,13,14,18,19,20]);
assert.deepEqual(filtered.groups,[{start:0,count:3,materialIndex:0},{start:3,count:3,materialIndex:1},{start:6,count:3,materialIndex:2}]);
assert.deepEqual(filtered.drawRange,{start:0,count:9});assert.deepEqual(grouped.drawRange,{start:6,count:15},'source draw range untouched');
const single=filterArmGeometry(grouped,()=>true,false);assert.equal(single.groups.length,0,'single material has no stale group offsets');assert.equal(single.drawRange.count,15);
const empty=filterArmGeometry(grouped,()=>false,true);assert.equal(empty.index.count,0);assert.equal(empty.drawRange.count,0);assert.equal(empty.groups.length,0);
for(const g of [grouped,filtered,single,empty])g.dispose();
for(const name of ['jett','sage']){
  const asset=await loadRig(name),camera=new THREE.PerspectiveCamera(76,16/9,.06,280),arms=new ViewArms(asset,camera);
  const weapon=createFirstPersonPhantom(phantom.scene),gunRoot=new THREE.Group();
  camera.add(gunRoot);gunRoot.add(weapon.group);gunRoot.position.set(.24,-.23,-.4);camera.updateMatrixWorld(true);
  arms.bindWeapon(weapon.anchors);
  let maxLengthError=0,maxTargetError=0,maxWristAngleError=0,maxWristLocalAngle=0,maxWristFrameAngle=0,maxShoulderY=-Infinity,keptTriangles=0;const meshDraws=[];const previousHands={};
  const gripErrors={L:{position:0,orientation:0},R:{position:0,orientation:0}};
  for(const side of ['L','R']){
    assert.ok(arms.bones[side+'_WeaponPoint']?.isBone,'grip test requires the actual imported palm socket');
    assert.equal(arms.bones[side+'_WeaponPoint'].parent,arms.bones[side+'_Hand'],'socket belongs to the real wrist');
    assert.ok(weapon.anchors[side]?.isObject3D,'grip test requires a real weapon anchor');
  }
  const localPositions=new Map();arms.model.traverse(b=>{if(b.isBone)localPositions.set(b,b.position.clone());if(b.isSkinnedMesh)keptTriangles+=b.geometry.index.count/3;});
  arms.model.traverse(mesh=>{if(!mesh.isSkinnedMesh)return;const g=mesh.geometry;assert.equal(g.drawRange.start,0);assert.equal(g.drawRange.count,g.index.count);if(!Array.isArray(mesh.material))assert.equal(g.groups.length,0);for(const group of g.groups)assert.ok(group.count>0&&group.start+group.count<=g.index.count,'only nonempty valid material groups');if(!g.index.count)assert.equal(mesh.visible,false,'zero-triangle source eye/hair/orb mesh skips rendering');meshDraws.push({name:mesh.name,triangles:g.index.count/3,visible:mesh.visible,groups:g.groups.length,materials:Array.isArray(mesh.material)?mesh.material.map(m=>m.name):[mesh.material.name],estimatedCalls:mesh.visible?(Array.isArray(mesh.material)?g.groups.length:1):0});});
  assert.ok(keptTriangles>1000,'retains actual textured arm geometry');
  for(let frame=0;frame<480;frame++){
    const time=frame*1000/60,recoil=frame%90<8?.07:0,reloading=frame%180>130,bob=frame*.17;
    camera.position.set(Math.sin(frame*.02)*10,2+frame*.01,-30);camera.rotation.set(Math.sin(frame*.01)*.7,frame*.01,0,'YXZ');camera.updateMatrixWorld(true);
    gunRoot.position.set(.24+Math.sin(bob)*.006,-.23+Math.abs(Math.cos(bob))*.009-recoil*.35,-.4+recoil);
    gunRoot.rotation.set(recoil*1.5,0,reloading?Math.sin(time*.005)*-.4:0);
    camera.updateMatrixWorld(true);arms.update(1/60,{recoil,reloading,time});
    for(const side of ['L','R']){
      const s=arms.bones[side+'_Shoulder'],e=arms.bones[side+'_Elbow'],h=arms.bones[side+'_Hand'];
      const a=s.getWorldPosition(new THREE.Vector3()),b=e.getWorldPosition(new THREE.Vector3()),c=h.getWorldPosition(new THREE.Vector3());
      maxLengthError=Math.max(maxLengthError,Math.abs(a.distanceTo(b)-arms.referenceLengths[side].upper),Math.abs(b.distanceTo(c)-arms.referenceLengths[side].lower));
      // Wrist-to-arbitrary-coordinate checks can pass with an empty palm. Check
      // the imported WeaponPoint against the moving real weapon instead.
      const socket=arms.bones[side+'_WeaponPoint'].getWorldPosition(new THREE.Vector3()),anchor=weapon.anchors[side];
      const positionError=socket.distanceTo(anchor.getWorldPosition(new THREE.Vector3()));
      const angleError=h.getWorldQuaternion(new THREE.Quaternion()).normalize().angleTo(anchor.getWorldQuaternion(new THREE.Quaternion()).normalize());
      const wristLocalAngle=arms.restRotations.get(h).angleTo(h.quaternion);
      maxWristLocalAngle=Math.max(maxWristLocalAngle,wristLocalAngle);
      if(previousHands[side])maxWristFrameAngle=Math.max(maxWristFrameAngle,previousHands[side].angleTo(h.quaternion));
      previousHands[side]=h.quaternion.clone();
      const aimDirection=c.clone().sub(a).normalize(),restPole=arms.root.localToWorld(arms.elbowPoles[side].clone()).sub(a).projectOnPlane(aimDirection).normalize(),currentPole=b.clone().sub(a).projectOnPlane(aimDirection).normalize();
      assert.ok(restPole.dot(currentPole)>0,'elbow bend remains on the natural side of the arm');
      gripErrors[side].position=Math.max(gripErrors[side].position,positionError);
      gripErrors[side].orientation=Math.max(gripErrors[side].orientation,angleError);
      maxTargetError=Math.max(maxTargetError,positionError);maxWristAngleError=Math.max(maxWristAngleError,angleError);
      assert.ok(positionError<.001,`${name} ${side} frame ${frame}: palm detached from weapon by ${positionError}m`);
      assert.ok(angleError<.00001,`${name} ${side} frame ${frame}: wrist fails to rotate with weapon (${angleError}rad)`);
      assert.ok(c.distanceTo(socket)>.06,'actual palm socket is distinct from the wrist');
      const local=arms.root.worldToLocal(a.clone());maxShoulderY=Math.max(maxShoulderY,local.y);
      assert.ok(local.y<-.4,'shoulder sockets stay below camera');
    }
    arms.model.traverse(b=>{if(b.isBone){for(const v of [...b.position,...b.quaternion,...b.scale,...b.matrixWorld.elements])assert.ok(Number.isFinite(v),'bone transforms remain finite');assert.ok(b.position.distanceTo(localPositions.get(b))<1e-9,'IK does not translate or stretch bones');}});
  }
  assert.ok(maxLengthError<.00001,'bone lengths preserved through aiming/recoil/reload');
  assert.ok(maxTargetError<.001,'both real palm sockets follow gun anchors within 1mm');
  assert.ok(maxWristAngleError<.00001,'both wrists follow weapon orientation during aiming/recoil/reload');
  // This sequence deliberately steps recoil/reload at phase boundaries; even
  // at those boundaries the wrist must not jump through a half/full turn.
  assert.ok(maxWristFrameAngle<Math.PI/2,'wrist orientation does not flip between adjacent frames');
  gunRoot.position.set(.24,-.23,-.4);gunRoot.rotation.set(0,0,0);camera.updateMatrixWorld(true);
  arms.update(NaN,{recoil:NaN,time:NaN});assert.ok(Number.isFinite(arms.root.position.y),'invalid optional timing cannot poison transforms');
  const skinBounds=new THREE.Box3();
  arms.model.traverse(mesh=>{if(!mesh.isSkinnedMesh)return;const used=new Set(mesh.geometry.index.array);for(const index of used){const point=mesh.getVertexPosition(index,new THREE.Vector3());mesh.localToWorld(point);arms.root.worldToLocal(point);assert.ok(point.toArray().every(Number.isFinite),'all retained deformed skin vertices finite');skinBounds.expandByPoint(point);}});
  assert.ok(skinBounds.max.y<-.15,'arm and shoulder skin no longer reaches camera horizon');
  const fingerGrip=measureFingerGrip(arms,weapon);
  assertFingerGrip(fingerGrip,name);
  const sourceMixer=new THREE.AnimationMixer(asset.scene);sourceMixer.clipAction(asset.animations[0]).play();sourceMixer.update(0);const savedFingers=new Map();
  arms.model.traverse(bone=>{if(!bone.isBone||!/^R_(Middle|Ring|Pinky)[123]_\d+$/.test(bone.name))return;savedFingers.set(bone,bone.quaternion.clone());const key=bone.name.replace(/_\d+$/,'');bone.quaternion.copy(findBone(asset.scene,key).quaternion);});arms.model.updateMatrixWorld(true);
  const sourceOpenFingerGrip=measureFingerGrip(arms,weapon);
  const sourceOpenSocketError=arms.bones.R_WeaponPoint.getWorldPosition(new THREE.Vector3()).distanceTo(weapon.anchors.R.getWorldPosition(new THREE.Vector3()));
  assert.ok(sourceOpenSocketError<.001,'negative control preserves socket alignment while opening the fingers');
  for(const finger of Object.keys(fingerGrip)){
    assert.throws(()=>assertFingerGrip({[finger]:sourceOpenFingerGrip[finger]},`${name} source idle`),/distal finger must return/,'each original open finger must fail even though the palm socket is aligned');
    assert.ok(fingerGrip[finger].tipSurfaceDistance<sourceOpenFingerGrip[finger].tipSurfaceDistance-.012,`${name} ${finger}: actual fingertip must move at least 12mm closer to the physical grip`);
  }
  for(const[bone,quaternion]of savedFingers)bone.quaternion.copy(quaternion);arms.model.updateMatrixWorld(true);sourceMixer.stopAllAction();
  results.push({agent:name,keptTriangles,meshDraws,estimatedDrawCalls:meshDraws.reduce((sum,m)=>sum+m.estimatedCalls,0),maxLengthError,maxTargetError,maxWristAngleError,maxWristLocalAngle,maxWristFrameAngle,gripErrors,maxShoulderY,fingerGrip,sourceOpenFingerGrip,sourceOpenSocketError,skinBounds:{min:skinBounds.min.toArray(),max:skinBounds.max.toArray()},shoulders:Object.fromEntries(['L','R'].map(side=>[side,arms.root.worldToLocal(arms.bones[side+'_Shoulder'].getWorldPosition(new THREE.Vector3())).toArray()]))});arms.dispose();weapon.dispose();gunRoot.removeFromParent();
}
fs.writeFileSync(new URL('./view-arms-results.json',import.meta.url),JSON.stringify(results,null,2)+'\n','utf8');
console.log(JSON.stringify(results,null,2));console.log('Real first-person arm IK self-test passed.');
