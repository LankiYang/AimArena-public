import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Preserve the artist's triangles, normals, colours and material response while
// batching meshes whose only material difference is a flat base colour.
// The output keeps the source's world-space axes and dimensions.
export function createPhantomModel(source, { includeNames, excludeNames } = {}) {
  source.updateWorldMatrix(true,true);
  const group=new THREE.Group(),buckets=new Map(),ownedGeometries=[],ownedMaterials=[];
  const include=includeNames&&new Set(includeNames),exclude=excludeNames&&new Set(excludeNames);
  let sourceMeshes=0,triangles=0;
  source.traverse(node=>{
    if(!node.isMesh||(include&&!include.has(node.name))||exclude?.has(node.name))return;
    if(Array.isArray(node.material))throw new Error('Phantom batching expects one material per source mesh');
    sourceMeshes++;
    const material=node.material;
    let geometry=node.geometry.clone().applyMatrix4(node.matrixWorld);
    if(geometry.index){const indexed=geometry;geometry=indexed.toNonIndexed();indexed.dispose();}
    triangles+=geometry.attributes.position.count/3;
    const canBake=!material.map&&!material.transparent&&!material.alphaMap;
    for(const key of Object.keys(geometry.attributes))if(!['position','normal','uv','color'].includes(key))geometry.deleteAttribute(key);
    if(!geometry.attributes.normal)geometry.computeVertexNormals();
    if(!geometry.attributes.uv)geometry.setAttribute('uv',new THREE.BufferAttribute(new Float32Array(geometry.attributes.position.count*2),2));
    const colors=new Float32Array(geometry.attributes.position.count*3),old=geometry.attributes.color;
    for(let i=0;i<geometry.attributes.position.count;i++){
      colors[i*3]=(old?old.getX(i):1)*(canBake?material.color.r:1);
      colors[i*3+1]=(old?old.getY(i):1)*(canBake?material.color.g:1);
      colors[i*3+2]=(old?old.getZ(i):1)*(canBake?material.color.b:1);
    }
    geometry.setAttribute('color',new THREE.BufferAttribute(colors,3));
    const key=canBake?JSON.stringify([material.type,material.roughness,material.metalness,material.side,material.emissive?.getHex(),material.emissiveIntensity,material.flatShading,material.normalMap?.uuid,material.roughnessMap?.uuid,material.metalnessMap?.uuid]):material.uuid;
    if(!buckets.has(key)){
      const clone=material.clone();if(canBake)clone.color.setRGB(1,1,1);clone.vertexColors=true;
      buckets.set(key,{material:clone,geometries:[]});ownedMaterials.push(clone);
    }
    buckets.get(key).geometries.push(geometry);
  });
  for(const bucket of buckets.values()){
    const geometry=mergeGeometries(bucket.geometries,false);
    bucket.geometries.forEach(g=>g.dispose());
    if(!geometry)throw new Error('Phantom geometry batching failed');
    const mesh=new THREE.Mesh(geometry,bucket.material);mesh.frustumCulled=false;group.add(mesh);ownedGeometries.push(geometry);
  }
  const bounds=new THREE.Box3().setFromObject(group),size=bounds.getSize(new THREE.Vector3());
  const stats={sourceMeshes,drawCalls:group.children.length,triangles};
  return{group,length:Math.max(size.x,size.y,size.z),stats,dispose(){group.removeFromParent();ownedGeometries.forEach(g=>g.dispose());ownedMaterials.forEach(m=>m.dispose());}};
}

// The real Phantom's muzzle is source -X. Keep grip anchors on the same
// normalized frame as its geometry, so bob, recoil and reload cannot separate
// the hands from the weapon. Anchor positions were measured on Object_94 and
// the underside of the original handguard, not from screen-space wrist guesses.
export function createFirstPersonPhantom(source, meshFilter) {
  const scene=source?.scene||source;
  const resource=createPhantomModel(scene,meshFilter),gun=resource.group;
  const sourceBounds=new THREE.Box3().setFromObject(scene),size=sourceBounds.getSize(new THREE.Vector3()),center=sourceBounds.getCenter(new THREE.Vector3());
  if(!resource.stats.sourceMeshes)throw new Error('Phantom mesh filter selected no source geometry');
  gun.rotation.y=-Math.PI/2;gun.updateMatrixWorld(true);
  const rotatedBounds=new THREE.Box3().setFromObject(gun),rotatedCenter=rotatedBounds.getCenter(new THREE.Vector3());
  const scale=.91/Math.max(size.x,size.y,size.z);
  gun.scale.setScalar(scale);gun.position.copy(rotatedCenter).multiplyScalar(-scale);gun.position.z-=.13;
  const frame=new THREE.Group();frame.name='FirstPersonPhantom';frame.add(gun);frame.updateMatrixWorld(true);
  const grip=new THREE.Object3D();grip.name='PhantomPistolGrip';
  // WeaponPoint sits in the back of the palm; seat it on the rear curve of
  // Object_94 so the proximal fingers wrap its front rather than overshooting.
  grip.position.copy(gun.localToWorld(new THREE.Vector3(3.65,sourceBounds.min.y+size.y*.32,-.8215)));
  // Right fingers extend along local -X; index-to-pinky runs along +Z.
  // The finger row follows the slanted grip and curls from its right to left.
  const slant=.24,up=Math.sqrt(1-slant*slant);
  grip.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0,slant,up),new THREE.Vector3(-1,0,0),new THREE.Vector3(0,-up,slant)));
  const support=new THREE.Object3D();support.name='PhantomHandguardSupport';
  support.position.copy(gun.localToWorld(new THREE.Vector3(-2.8,-.34,center.z)));
  support.rotation.x=Math.PI;
  frame.add(grip,support);
  return {...resource,group:frame,anchors:{R:grip,L:support},dispose(){frame.removeFromParent();resource.dispose();}};
}
