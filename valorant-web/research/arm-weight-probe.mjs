import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
globalThis.ProgressEvent=class{constructor(type,data){Object.assign(this,{type,...data});}};
async function load(name){
  const bytes=fs.readFileSync(new URL(`../assets/agents/${name}.glb`,import.meta.url));
  const n=bytes.readUInt32LE(12),j=JSON.parse(bytes.toString('utf8',20,20+n));
  const bin=bytes.subarray(28+n,28+n+bytes.readUInt32LE(20+n));
  delete j.images;delete j.textures;j.materials?.forEach(m=>{delete m.pbrMetallicRoughness?.baseColorTexture;delete m.pbrMetallicRoughness?.metallicRoughnessTexture;delete m.normalTexture;delete m.emissiveTexture;delete m.occlusionTexture;});
  j.buffers[0].uri='data:application/octet-stream;base64,'+bin.toString('base64');return new GLTFLoader().parseAsync(JSON.stringify(j),'');
}
for(const name of ['jett','sage']){
  const g=await load(name),rows=[];
  g.scene.traverse(mesh=>{
    if(!mesh.isSkinnedMesh)return;
    const si=mesh.geometry.attributes.skinIndex,sw=mesh.geometry.attributes.skinWeight,position=mesh.geometry.attributes.position,index=mesh.geometry.index;
    for(let t=0;t<(index?index.count:position.count);t+=3){
      let min=1;for(let k=0;k<3;k++){const i=index?index.getX(t+k):t+k,weights=[];for(let c=0;c<4;c++)weights.push(sw.getComponent(i,c));let arm=0;for(let c=0;c<4;c++){const bone=mesh.skeleton.bones[si.getComponent(i,c)];if(/^[LR]_(Shoulder|Elbow|Hand|Thumb|Index|Middle|Pinky|Ring|Sleeve)/.test(bone?.name))arm+=weights[c];}min=Math.min(min,arm);}
      rows.push(min);
    }
  });
  rows.sort((a,b)=>a-b);console.log(name,JSON.stringify({triangles:rows.length,p10:rows[Math.floor(rows.length*.1)],p25:rows[Math.floor(rows.length*.25)],p50:rows[Math.floor(rows.length*.5)],p75:rows[Math.floor(rows.length*.75)],p90:rows[Math.floor(rows.length*.9)],counts:Object.fromEntries([.2,.3,.35,.4,.48,.55,.65,.8].map(x=>[x,rows.filter(v=>v>x).length]))}));
}
