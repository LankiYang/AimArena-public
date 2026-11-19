import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const textureStyles = {
  brick:['bricks',.67,.39,.20], stone:['bricks',.41,.28,.14], plaster:['plaster',.48,.29,.13],
  wood:['plaster',.54,.16,.055], fabric:['plaster',1.42,.21,.08], accent:['plaster',.65,.16,.07],
};

function addSurfaceDetail(material, maps, style, quality) {
  const [kind, repeat, strength, relief] = style;
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, {
      ascentDetail:{value:maps[kind+'-color']},
      ascentNormal:{value:maps[kind+'-normal']},
      ascentRoughness:{value:maps[kind+'-roughness']},
      ascentTiling:{value:repeat},
      ascentStrength:{value:strength},
      ascentRelief:{value:relief},
      ascentQuality:quality,
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vAscentPosition; varying vec3 vAscentNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAscentPosition = position; vAscentNormal = normal;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vAscentPosition; varying vec3 vAscentNormal;
      uniform sampler2D ascentDetail, ascentNormal, ascentRoughness;
      uniform float ascentTiling, ascentStrength, ascentRelief, ascentQuality;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
      vec3 p = vAscentPosition * ascentTiling;
      vec3 axis = pow(abs(normalize(vAscentNormal)), vec3(6.0));
      axis /= max(dot(axis, vec3(1.0)), 0.001);
      if (ascentQuality > .5) {
      vec3 detail = texture2D(ascentDetail,p.zy).rgb*axis.x
                  + texture2D(ascentDetail,p.xz).rgb*axis.y
                  + texture2D(ascentDetail,p.xy).rgb*axis.z;
      diffuseColor.rgb *= mix(vec3(1.0),detail*1.7,ascentStrength);
      }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        if (ascentQuality > 1.5) {
          float grit = texture2D(ascentRoughness,p.zy).r*axis.x + texture2D(ascentRoughness,p.xz).r*axis.y + texture2D(ascentRoughness,p.xy).r*axis.z;
          roughnessFactor = clamp(roughnessFactor*(0.72+0.35*grit),0.22,1.0);
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        if (ascentQuality > 1.5) {
          vec2 nx = texture2D(ascentNormal,p.zy).rg*2.0-1.0;
          vec2 ny = texture2D(ascentNormal,p.xz).rg*2.0-1.0;
          vec2 nz = texture2D(ascentNormal,p.xy).rg*2.0-1.0;
          vec3 local = vec3(0,nx.y,nx.x)*axis.x + vec3(ny.x,0,ny.y)*axis.y + vec3(nz.x,nz.y,0)*axis.z;
          normal = normalize(normal + mat3(viewMatrix)*local*ascentRelief);
        }`);
  };
  material.customProgramCacheKey = ()=>'release-triplanar-v2';
}

export async function loadAscentFullEnvironment(scene,map,onProgress) {
  const root=new THREE.Group(); root.name=map.title; scene.add(root);
  const palette=map.lighting||{sky:'#9dbdd4',horizon:'#c5d8e0',ground:'#aaa193',sun:'#fff0dc',fog:.008};
  scene.background=new THREE.Color(palette.sky); scene.fog=new THREE.FogExp2(palette.horizon,palette.fog);
  const sun=new THREE.DirectionalLight(palette.sun,2.6), offset=new THREE.Vector3(29,66,-28);
  sun.castShadow=true;
  sun.shadow.normalBias=.032; sun.shadow.bias=-.00011;
  root.add(new THREE.HemisphereLight(palette.horizon,palette.ground,2.45),sun,sun.target);
  const textures=new THREE.TextureLoader(), loader=new GLTFLoader();
  const quality={value:1}, center=new THREE.Vector3(Infinity,Infinity,Infinity);
  let done=0, bytes=0, next=0;
  const total=map.levels.length, totalBytes=map.levels.reduce((n,p)=>n+(p.bytes||1),0);
  const images=Promise.all(['bricks','plaster'].flatMap(kind=>['color','normal','roughness'].map(async role=>{
    const key=kind+'-'+role,t=await textures.loadAsync('/assets/textures/'+key+'.jpg');
    if(role==='color')t.colorSpace=THREE.SRGBColorSpace;
    t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=4;
    return [key,t];
  }))).then(Object.fromEntries);
  async function importPart(part,maps){
    const gltf=await loader.loadAsync(part.url);
    const materials=new Set();
    gltf.scene.traverse(o=>{
      if(!o.isMesh)return;
      o.castShadow=o.receiveShadow=true;
      if(materials.has(o.material))return;
      materials.add(o.material);
      const style=textureStyles[o.material.name];
      if(style)addSurfaceDetail(o.material,maps,style,quality);
      if(o.material.name==='metal')o.material.roughness=.57;
      if(o.material.name==='glass')o.material.roughness=.22;
    });
    root.add(gltf.scene);
    bytes+=part.bytes||1;
    onProgress?.(bytes/totalBytes,`${map.title} · 地图分区 ${++done}/${total}`);
  }
  const maps=await images;
  const results=await Promise.allSettled(Array.from({length:4},async()=>{
    while(next<total)await importPart(map.levels[next++],maps);
  }));
  const failed=results.find(r=>r.status==='rejected');
  if(failed){for(const texture of Object.values(maps))texture.dispose();throw failed.reason;}
  return {
    sun, statistics:{triangles:map.triangleCount,texturesReady:true,textureErrors:[],parts:done},
    setQuality(level){
      quality.value=level==='high'?2:level==='low'?0:1;
      sun.castShadow=quality.value>0;
      const size=quality.value===2?4096:2048, extent=quality.value===2?31:36;
      if(sun.shadow.mapSize.x!==size){sun.shadow.map?.dispose();sun.shadow.map=null;sun.shadow.mapSize.set(size,size);}
      Object.assign(sun.shadow.camera,{left:-extent,right:extent,top:extent,bottom:-extent,near:1,far:153});
      sun.shadow.camera.updateProjectionMatrix();sun.shadow.needsUpdate=true;
    },
    updateLight(eye){
      if(!sun.castShadow)return false;
      const x=Math.round(eye.x/20)*20,z=Math.round(eye.z/20)*20,y=Math.round(eye.y/14)*14;
      if(center.x===x&&center.y===y&&center.z===z)return false;
      center.set(x,y,z);sun.target.position.copy(center);sun.position.copy(center).add(offset);sun.shadow.needsUpdate=true;
      return true;
    },
    dispose(){sun.shadow.dispose(); for(const texture of Object.values(maps))texture.dispose();},
  };
}
