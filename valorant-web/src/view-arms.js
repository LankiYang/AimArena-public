import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';

const SIDES = ['L', 'R'];
const ELBOW_BIAS = { L: [-.12, -.20, .12], R: [.4, -.6, -.1] };

function boneFrame(along, hinge) {
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
    along, hinge, new THREE.Vector3().crossVectors(along, hinge)
  )).normalize();
}

// Preserve source material membership when compacting a skinned index buffer.
// Source group offsets address the OLD index buffer and cannot be reused.
export function filterArmGeometry(source, keepVertex, multipleMaterials = false) {
  const geometry=source.clone(),indices=source.index?.array||Array.from({length:source.attributes.position.count},(_,i)=>i);
  const kept=[],offsets=new Int32Array(Math.ceil(indices.length/3));offsets.fill(-1);
  const drawStart=Math.max(0,source.drawRange.start),drawEnd=Math.min(indices.length,drawStart+source.drawRange.count);
  for(let i=0;i+2<indices.length;i+=3){
    if(i<drawStart||i+3>drawEnd)continue;
    if(keepVertex(indices[i])&&keepVertex(indices[i+1])&&keepVertex(indices[i+2])){offsets[i/3]=kept.length;kept.push(indices[i],indices[i+1],indices[i+2]);}
  }
  geometry.setIndex(kept);geometry.clearGroups();geometry.setDrawRange(0,kept.length);
  if(multipleMaterials){
    for(const group of source.groups){
      const start=Math.max(0,group.start,drawStart),end=Math.min(indices.length,group.start+group.count,drawEnd);let first=-1,count=0;
      for(let i=Math.ceil(start/3)*3;i+2<end;i+=3){const offset=offsets[i/3];if(offset<0)continue;if(first<0)first=offset;count+=3;}
      if(count)geometry.addGroup(first,count,group.materialIndex);
    }
  }
  geometry.computeBoundingSphere();return geometry;
}

// First-person arms use the character's original skinned vertices and textures.
// Only triangles weighted to the real arm bones are kept; no replacement hands.
export class ViewArms {
  constructor(asset,camera){
    this.root=new THREE.Group();camera.add(this.root);this.model=cloneSkeleton(asset.scene);this.root.add(this.model);
    this.mixer=new THREE.AnimationMixer(this.model);if(asset.animations[0])this.mixer.clipAction(asset.animations[0]).play();this.mixer.update(0);this.mixer.timeScale=0;this.model.updateMatrixWorld(true);
    const bounds=new THREE.Box3().setFromObject(this.model),scale=1.82/bounds.getSize(new THREE.Vector3()).y;this.model.scale.setScalar(scale);this.model.rotation.y=Math.PI;this.model.position.set(.02,-1.43,-.2);
    this.bones={};this.model.traverse(o=>{
      if(o.isBone){const key=o.name.replace(/_\d+$/,'');if(/^[LR]_(Shoulder|Elbow|Hand|Middle1|WeaponPoint)$/.test(key)&&!this.bones[key])this.bones[key]=o;}
      if(!o.isSkinnedMesh)return;const si=o.geometry.attributes.skinIndex,sw=o.geometry.attributes.skinWeight;
      const allowed=new Set(o.skeleton.bones.map((b,i)=>/^[LR]_(Shoulder|Elbow|Hand|Thumb|Index|Middle|Pinky|Ring|Sleeve)/.test(b.name)?i:-1).filter(i=>i>=0));
      // Keep the weighted shoulder transition. A high cutoff removes mixed
      // shoulder triangles and leaves the forearm visibly severed at the edge
      // of the first-person view; .30 preserves the real skin bridge without
      // pulling the torso into the arm mesh.
      const armVertex=i=>{let weight=0;for(let c=0;c<4;c++)if(allowed.has(si.array[i*4+c]))weight+=sw.array[i*4+c];return weight>.30;};
      const multipleMaterials=Array.isArray(o.material),g=filterArmGeometry(o.geometry,armVertex,multipleMaterials);
      o.geometry=g;o.visible=o.visible&&g.index.count>0;o.frustumCulled=false;o.castShadow=false;o.receiveShadow=false;o.renderOrder=8;const mats=multipleMaterials?o.material:[o.material];const clones=mats.map(m=>{const c=m.clone();c.depthTest=true;c.depthWrite=true;return c;});o.material=multipleMaterials?clones:clones[0];
    });
    this.root.updateMatrixWorld(true);this.armTargets={R:new THREE.Vector3(.245,-.34,-.31),L:new THREE.Vector3(.22,-.29,-.59)};
    this.elbowPoles={};this.chains={};
    this.restRotations=new Map();this.forearmTwists={L:[],R:[]};this.twistAngles={L:null,R:null};this.referenceLengths={};
    for(const side of SIDES){
      for(const joint of ['Shoulder','Elbow','Hand']){const bone=this.bones[side+'_'+joint];if(bone)this.restRotations.set(bone,bone.quaternion.clone());}
      const hand=this.bones[side+'_Hand'];
      if(hand){const elbow=this.bones[side+'_Elbow'];this.model.traverse(bone=>{if(bone.isBone&&new RegExp('^'+side+'_Elbow_Twst[23]_\\d+$').test(bone.name)&&bone.parent===elbow){this.forearmTwists[side].push({bone,rest:bone.quaternion.clone(),fraction:THREE.MathUtils.clamp(Math.abs(bone.position.x/hand.position.x),0,1)});this.restRotations.set(bone,bone.quaternion.clone());}});}
    }
    // Calibrate the torso from the actual rig. The source idle poses turn the
    // chest obliquely, so a fixed model offset leaves one shoulder in mid-screen.
    // A rigid transform moves BOTH shoulder sockets below the camera frustum;
    // no bone translation, scaling, clipped shoulder mesh or synthetic arm.
    const left=this.bones.L_Shoulder,right=this.bones.R_Shoulder;
    if(left&&right){
      const axis=right.getWorldPosition(new THREE.Vector3()).sub(left.getWorldPosition(new THREE.Vector3()));
      axis.transformDirection(this.root.matrixWorld.clone().invert());this.model.rotation.y+=Math.atan2(axis.z,axis.x);this.root.updateMatrixWorld(true);
      const midpoint=left.getWorldPosition(new THREE.Vector3()).add(right.getWorldPosition(new THREE.Vector3())).multiplyScalar(.5);this.root.worldToLocal(midpoint);
      this.model.position.add(new THREE.Vector3(.10,-.50,-.38).sub(midpoint));this.root.updateMatrixWorld(true);
    }
    const rootToLocal = this.root.getWorldQuaternion(new THREE.Quaternion()).normalize().invert();
    for (const side of SIDES) {
      const shoulder = this.bones[side+'_Shoulder'], elbow = this.bones[side+'_Elbow'];
      const hand = this.bones[side+'_Hand'], middle = this.bones[side+'_Middle1'];
      if (!shoulder || !elbow || !hand || !middle) continue;
      const shoulderQ = shoulder.getWorldQuaternion(new THREE.Quaternion()).normalize();
      const elbowQ = elbow.getWorldQuaternion(new THREE.Quaternion()).normalize();
      const handQ = hand.getWorldQuaternion(new THREE.Quaternion()).normalize();
      const a = shoulder.getWorldPosition(new THREE.Vector3()), b = elbow.getWorldPosition(new THREE.Vector3());
      const c = hand.getWorldPosition(new THREE.Vector3());
      const upper = b.clone().sub(a), lower = c.clone().sub(b);
      const upperLength = upper.length(), lowerLength = lower.length();
      const hinge = new THREE.Vector3().crossVectors(upper, lower);
      if (hinge.lengthSq() < 1e-8) continue;
      hinge.normalize();upper.normalize();lower.normalize();
      this.elbowPoles[side] = this.root.worldToLocal(b.clone());
      this.referenceLengths[side] = { upper: upperLength, lower: lowerLength };
      // Preserve the source elbow's flexion axis as the bend plane moves.
      const sourceFrame = (along, rotation) => boneFrame(along, hinge).invert().multiply(rotation);
      this.chains[side] = {
        shoulder, elbow, hand,
        shoulderOffset: sourceFrame(upper, shoulderQ), elbowOffset: sourceFrame(lower, elbowQ),
        restWrist: rootToLocal.clone().multiply(handQ),
        elbowBias: new THREE.Vector3(...ELBOW_BIAS[side]),
      };
    }
    // The supplied idle animation has an open right hand. Pose the actual
    // phalanges around the pistol grip while retaining their anatomical splay.
    const flex={Index:[-.35,-1.15,-.8],Middle:[-.8,-1.6,-1.45],Ring:[-.8,-1.6,-1.45],Pinky:[-.8,-1.6,-1.5]};
    this.model.traverse(bone=>{if(!bone.isBone)return;const match=/^R_(Index|Middle|Ring|Pinky)([123])_\d+$/.exec(bone.name);if(match)bone.rotation.z=flex[match[1]][Number(match[2])-1];});
    this.update(0);
  }
  setWorldRotation(bone, rotation){
    bone.quaternion.copy(bone.parent.getWorldQuaternion(new THREE.Quaternion()).normalize().invert().multiply(rotation)).normalize();
    bone.updateWorldMatrix(false,false);
  }
  bindWeapon(anchors){this.weaponAnchors=anchors;this.twistAngles={L:null,R:null};this.update(0);}
  updateForearmSkin(side,hand){
    // These helper bones are siblings of Hand, not descendants. The source
    // has no animation tracks for them. Leaving them at identity while rotating
    // Hand makes the mixed wrist weights collapse like a twisted sweet wrapper.
    // Carry axial roll through the original forearm skin joints (at 54% and
    // 92% of its length). Only the distal wrist helper shares Hand's flexion:
    // applying that swing to Twst2 bends the middle of the forearm and stretches
    // the elbow skin. Twst2 must remain an axial roll joint.
    const delta=hand.quaternion.clone().multiply(this.restRotations.get(hand).clone().invert()).normalize(),axis=hand.position.clone().normalize();
    const projection=delta.x*axis.x+delta.y*axis.y+delta.z*axis.z;
    const twist=new THREE.Quaternion(axis.x*projection,axis.y*projection,axis.z*projection,delta.w).normalize();
    let angle=2*Math.atan2(twist.x*axis.x+twist.y*axis.y+twist.z*axis.z,twist.w);
    const previous=this.twistAngles[side];if(previous===null){while(angle>Math.PI)angle-=Math.PI*2;while(angle<-Math.PI)angle+=Math.PI*2;}else{while(angle-previous>Math.PI)angle-=Math.PI*2;while(angle-previous<-Math.PI)angle+=Math.PI*2;}this.twistAngles[side]=angle;
    const swing=delta.clone().multiply(twist.clone().invert()).normalize();
    for(const {bone,rest,fraction} of this.forearmTwists[side]){const flexion=/Twst3_/.test(bone.name)?fraction:0;bone.quaternion.copy(new THREE.Quaternion().slerp(swing,flexion).multiply(new THREE.Quaternion().setFromAxisAngle(axis,angle*fraction)).multiply(rest)).normalize();bone.updateMatrixWorld(true);}
  }
  solve(side){
    const chain = this.chains[side];
    if (!chain) return;
    const { shoulder, elbow, hand, elbowBias, restWrist, shoulderOffset, elbowOffset } = chain;
    const rootRotation = this.root.getWorldQuaternion(new THREE.Quaternion()).normalize();
    const shoulderPoint = shoulder.getWorldPosition(new THREE.Vector3());
    const anchor = this.weaponAnchors?.[side], socket = this.bones[side+'_WeaponPoint'];
    const gripping = anchor && socket?.parent === hand;
    let target = this.root.localToWorld(this.armTargets[side].clone());
    let wristRotation = rootRotation.clone().multiply(restWrist);
    if (gripping) {
      wristRotation = anchor.getWorldQuaternion(new THREE.Quaternion()).normalize();
      const offset = socket.position.clone().multiply(hand.getWorldScale(new THREE.Vector3())).applyQuaternion(wristRotation);
      target = anchor.getWorldPosition(new THREE.Vector3()).sub(offset);
    }

    const { upper, lower } = this.referenceLengths[side];
    const direction = target.clone().sub(shoulderPoint);
    const reach = direction.length();
    if (!Number.isFinite(reach) || reach < 1e-5) return;
    const distance = THREE.MathUtils.clamp(reach, Math.abs(upper - lower) + .001, upper + lower - .003);
    direction.divideScalar(reach);
    target = shoulderPoint.clone().addScaledVector(direction, distance);
    const pole = this.root.localToWorld(this.elbowPoles[side].clone()).sub(shoulderPoint);
    if (gripping) {
      // Express the elbow bend plane in the camera frame so it cannot drift
      // to the far side of the wrist when the gun rotates.
      pole.copy(elbowBias).applyQuaternion(rootRotation);
    }
    pole.projectOnPlane(direction);
    if (pole.lengthSq() < 1e-8) pole.copy(this.root.localToWorld(this.elbowPoles[side].clone())).sub(shoulderPoint).projectOnPlane(direction);
    if (pole.lengthSq() < 1e-8) pole.set(0,-1,0).applyQuaternion(rootRotation).projectOnPlane(direction);
    if (pole.lengthSq() < 1e-8) pole.set(1,0,0).applyQuaternion(rootRotation).projectOnPlane(direction);
    pole.normalize();
    const along = (upper*upper - lower*lower + distance*distance) / (2*distance);
    const rise = Math.sqrt(Math.max(0, upper*upper - along*along));
    const elbowPoint = shoulderPoint.clone().addScaledVector(direction, along).addScaledVector(pole, rise);
    const upperDirection = elbowPoint.clone().sub(shoulderPoint).normalize();
    const forearmDirection = target.clone().sub(elbowPoint).normalize();
    const hinge = new THREE.Vector3().crossVectors(upperDirection, forearmDirection).normalize();
    this.setWorldRotation(shoulder, boneFrame(upperDirection, hinge).multiply(shoulderOffset));
    this.setWorldRotation(elbow, boneFrame(forearmDirection, hinge).multiply(elbowOffset));
    this.setWorldRotation(hand, wristRotation);
    this.updateForearmSkin(side,hand);
  }
  update(dt,{alive=true}={}){
    this.root.visible=alive;for(const[bone,rotation]of this.restRotations)bone.quaternion.copy(rotation);
    // The torso stays camera-relative; the moving weapon anchors drive the
    // actual palms. Applying recoil to this root again would double its motion.
    this.root.updateWorldMatrix(true,true);this.solve('R');this.solve('L');this.root.updateMatrixWorld(true);
  }
  dispose(){this.root.removeFromParent();this.mixer.stopAllAction();this.model.traverse(o=>{if(o.isMesh){o.geometry.dispose();const m=Array.isArray(o.material)?o.material:[o.material];m.forEach(x=>x.dispose());}});}
}
