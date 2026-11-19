import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAscentFullCollision } from '../src/ascent-full-collision.mjs';
import { AscentWalker } from '../src/ascent-collision.mjs';

const cache=process.argv[2];
if(!cache) throw Error('Usage: node research/setup-release-maps.mjs <release cache directory>');
const root=fileURLToPath(new URL('../assets/maps/',import.meta.url));
const read=async(p)=>JSON.parse(await fs.readFile(p,'utf8'));
const [en,zh]=await Promise.all(['en','zh'].map(lang=>read(path.join(cache,'valorant-maps-'+lang+'.json'))));
const presentation = {
  abyss:['#7da3c2','#b6d5f6','#5a6680','#ffeadc',.010],
  bind:['#acc8e0','#f0debc','#aa8c70','#ffe3be',.007],
  breeze:['#89c5e3','#d0eaf3','#8ba99d','#fff0d4',.006],
  corrode:['#98aebf','#dbdbd4','#948570','#ffe3c6',.009],
  fracture:['#93b9d0','#d0dedd','#7c9084','#fef2dc',.007],
  haven:['#99b8ce','#e6e0cc','#a2977e','#ffebc8',.007],
  icebox:['#93aeca','#e2ecfa','#8e9db5','#e6f1ff',.010],
  lotus:['#92b5ca','#d2dcca','#829470','#fceacb',.009],
  pearl:['#3d7399','#6bb0b3','#58868d','#d9f7fd',.010],
  split:['#a0b7d2','#d6e3ed','#a3a2a4','#fff1dd',.008],
  summit:['#879dbd','#ccdbe7','#a39b94','#ffdec0',.008],
  sunset:['#9baecb','#ffc9a7','#b59a82','#ffce9d',.008],
};
const dirs=(await fs.readdir(path.join(cache,'maps'),{withFileTypes:true})).filter(d=>d.isDirectory()&&d.name!=='ascent');
async function image(url,destination){
  try{await fs.access(destination);return;}catch(e){if(e.code!=='ENOENT')throw e;}
  let response;
  for(let attempt=0;attempt<3;attempt++){
    response=await fetch(url,{signal:AbortSignal.timeout(12000)}).catch(()=>null);
    if(response?.ok)break;
  }
  if(!response)throw Error('Failed to download '+url);
  if(!response.ok)throw Error('Map image HTTP '+response.status);
  const buffer=Buffer.from(await response.arrayBuffer());
  if(buffer.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('Unexpected map image format');
  await fs.writeFile(destination,buffer);
}
const outcomes=await Promise.allSettled(dirs.map(async entry=>{
  const id=entry.name, source=path.join(cache,'maps',id), dest=path.join(root,id);
  const m=await read(path.join(source,'manifest.json'));
  const api=en.data.find(item=>item.displayName.toLowerCase()===id);
  const cn=zh.data.find(item=>item.uuid===api?.uuid);
  if(!api?.callouts||!cn?.displayName||!presentation[id])throw Error('Missing callouts: '+id);
  const {origin_x:ox,origin_y:oy,origin_z:oz}=m;
  const frame=({x,y,z})=>[y/100+ox,z/100+oy,oz-x/100];
  const box=await read(path.join(source,'collision.json')), world=buildAscentFullCollision(box);
  const points=api.callouts.filter(p=>/^site$/i.test(p.regionName) && /^[ABC]$/.test(p.superRegionName)).sort((a,b)=>a.superRegionName.localeCompare(b.superRegionName));
  const teams=['Attacker Side','Defender Side'].map(team=>api.callouts.find(p=>p.superRegionName===team&&/^spawn$/i.test(p.regionName)));
  if(points.length<2||teams.some(p=>!p))throw Error('Missing base callouts: '+id);
  const exclude=(await read(path.join(source,'spawn_exclude.json'))).points;
  function stable(x,y,z){
    const floor=world.floorAt(x,z,y+.35,1.1);
    if(!floor)return null;
    const h=floor.position.y;
    if(exclude.some(([ex,ey,ez])=>Math.abs(ey-h)<.4&&Math.hypot(x-ex,z-ez)<.4))return null;
    const walker=new AscentWalker(world,[x,h,z]);
    for(let i=0;i<8;i++)walker.update({x:0,z:0},1/60);
    const p=walker.getFoot();
    if(!walker.grounded||Math.abs(p.y-h)>.06||Math.hypot(p.x-x,p.z-z)>.08)return null;
    if([[.28,0],[-.28,0],[0,.28],[0,-.28]].some(([dx,dz])=>{
      const floor=world.floorAt(x+dx,z+dz,h+.16,.36);
      return !floor;
    }))return null;
    return {x,y:p.y,z};
  }
  function near(anchor,count,heightBand=Infinity){
    const [x,y,z]=anchor,candidates=[];
    for(let sy=0;sy<=16;sy++){
      const dy=sy===0?0:Math.ceil(sy/2)*(sy%2?-1:1)*.75;
      for(let ix=-20;ix<=20;ix++)for(let iz=-20;iz<=20;iz++){
        const score=ix*ix+iz*iz+4*dy*dy;
        if(score>385)continue;
        candidates.push({x:x+ix*.5,y:y+dy,z:z+iz*.5,score});
      }
    }
    const found=[];
    for(const p of candidates.sort((a,b)=>a.score-b.score)){
      if(found.some(f=>Math.hypot(p.x-f.x,p.z-f.z)<1.15))continue;
      const match=stable(p.x,p.y,p.z);
      if(match&&Math.abs(match.y-y)<heightBand)found.push(match);
      if(found.length===count)return found;
    }
    throw Error(id+' no stable candidates near '+anchor.join(','));
  }
  const sites=points.map(point=>{
    const anchor=frame(point.location);
    // The Haven B callout sits above a prop instead of on the site floor.
    if(id==='haven'&&point.superRegionName==='B')anchor[1]=1;
    return {id:point.superRegionName,...near(anchor,1)[0],radius:5.1,heightTolerance:.85};
  });
  const [attack,defend]=teams.map((point,index)=>{
    const anchor=index===0&&id==='summit'?frame({x:4025,y:6525,z:425}):frame(point.location);
    const sunsetAttack=index===0&&id==='sunset';
    if(sunsetAttack)anchor[1]=1;
    // The original Pearl spawn is in a separate region of the release collision.
    const pearlAttack=index===0&&id==='pearl';
    const pearlDefend=index===1&&id==='pearl';
    if(pearlDefend)anchor.splice(0,3,-50.4070117,2.5,-45.28658);
    return near(pearlAttack?[-63,5.2,32]:anchor,5,pearlAttack||sunsetAttack?.25:pearlDefend?.4:Infinity).map(p=>{
      const closest=[...sites].sort((a,b)=>Math.hypot(a.x-p.x,a.z-p.z)-Math.hypot(b.x-p.x,b.z-p.z))[0];
      return {...p,yaw:Math.atan2(closest.x-p.x,p.z-closest.z)};
    });
  });
  const [sky,horizon,ground,sun,fog]=presentation[id];
  const meta={
    id,name:api.displayName,title:cn.displayName,sites,spawns:{attack,defend},
    splash:'/assets/maps/'+id+'/splash.png',
    minimap:{url:'/assets/maps/'+id+'/minimap.png',xOffset:api.xScalarToAdd-api.xMultiplier*100*ox,zOffset:api.yScalarToAdd+api.yMultiplier*100*oz,scale:api.xMultiplier*100,zScale:-api.yMultiplier*100},
    lighting:{sky,horizon,ground,sun,fog},
    calloutSource:'https://valorant-api.com/v1/maps/'+api.uuid,
  };
  await fs.mkdir(dest,{recursive:true});
  await fs.writeFile(path.join(dest,'map.json'),JSON.stringify(meta,null,2)+'\n','utf8');
  await Promise.all([image(api.splash,path.join(dest,'splash.png')),image(api.displayIcon,path.join(dest,'minimap.png'))]);
  console.log(id, 'spawns', attack[0],defend[0], 'sites',sites.map(p=>[p.id,p.x,p.y,p.z]));
}));
for(const [i,result] of outcomes.entries())if(result.status==='rejected'){console.error(dirs[i].name,result.reason.message);process.exitCode=1;}
