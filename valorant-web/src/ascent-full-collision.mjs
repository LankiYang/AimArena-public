import { Box3, Ray, Vector3 } from 'three';

const CELL = 4;
const key = (x, z) => x + ':' + z;
const cell = n => Math.floor(n / CELL);
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));

// The release contains a separate solid-volume mesh already in the gameplay frame.
// Index it in XZ so client and server can query the same surfaces without art meshes.
export function buildAscentFullCollision(source) {
  if (!Array.isArray(source.boxes) || !source.boxes.length) throw Error('Missing Ascent collision volumes');
  const grid = new Map(), boundingBox = new Box3();
  const boxes = source.boxes.map((b, i) => {
    if (b.length !== 6 || !b.every(Number.isFinite) || b.some((v, j) => j < 3 && v >= b[j+3])) throw Error('Invalid Ascent volume ' + i);
    const box = new Box3(new Vector3(b[0],b[1],b[2]),new Vector3(b[3],b[4],b[5]));
    boundingBox.union(box);
    for (let x=cell(b[0]);x<=cell(b[3]);x++) for (let z=cell(b[2]);z<=cell(b[5]);z++) {
      const k=key(x,z);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(box);
    }
    return box;
  });
  function candidates(x0,z0,x1,z1) {
    const a=cell(x0),b=cell(x1),c=cell(z0),d=cell(z1);
    if (a===b && c===d) return grid.get(key(a,c)) || [];
    const unique=new Set();
    for (let x=a;x<=b;x++) for(let z=c;z<=d;z++) for(const box of grid.get(key(x,z)) || []) unique.add(box);
    return unique;
  }
  function capsuleIntersect(capsule) {
    const { start, end, radius:r }=capsule, x=start.x,z=start.z;
    let best=null;
    for (const {min,max} of candidates(x-r,z-r,x+r,z+r)) {
      const dx=x-clamp(x,min.x,max.x), dz=z-clamp(z,min.z,max.z);
      const dy=start.y>max.y ? start.y-max.y : end.y<min.y ? end.y-min.y : 0;
      const distance=Math.hypot(dx,dy,dz);
      if (distance>=r) continue;
      if (distance>1e-8) {
        const depth=r-distance;
        if (!best || depth>best.depth) best={depth,normal:new Vector3(dx/distance,dy/distance,dz/distance)};
      } else {
        const pushes=[x-min.x+r,max.x-x+r,end.y-min.y+r,max.y-start.y+r,z-min.z+r,max.z-z+r];
        const depth=Math.min(...pushes);
        if (!best || depth>best.depth) {
          const side=pushes.indexOf(depth),normal=new Vector3();
          normal.setComponent(side>>1,side%2 ? 1 : -1);
          best={depth,normal};
        }
      }
    }
    return best;
  }
  function floorAt(x,z,fromY=4,maxDrop=8,radius=0) {
    let y=-Infinity;
    for (const {min,max} of candidates(x-radius,z-radius,x+radius,z+radius)) {
      if (max.y>fromY+1e-6 || max.y<fromY-maxDrop || max.y<=y) continue;
      if (Math.hypot(x-clamp(x,min.x,max.x),z-clamp(z,min.z,max.z))<=radius) y=max.y;
    }
    return y===-Infinity ? null : {position:new Vector3(x,y,z),normal:new Vector3(0,1,0),distance:fromY-y};
  }
  function raycast(origin,direction,maxDistance=150) {
    if (!direction.lengthSq() || maxDistance<0) return null;
    const ray=new Ray(origin,direction.clone().normalize()), end=ray.at(maxDistance,new Vector3()), hit=new Vector3();
    let best=null;
    for (const box of candidates(Math.min(origin.x,end.x),Math.min(origin.z,end.z),Math.max(origin.x,end.x),Math.max(origin.z,end.z))) {
      if (box.containsPoint(origin)) return {position:origin.clone(),distance:0};
      if (!ray.intersectBox(box,hit)) continue;
      const distance=hit.distanceTo(origin);
      if (distance<=maxDistance && (!best || distance<best.distance)) best={position:hit.clone(),distance};
    }
    return best;
  }
  return {
    geometry:{boundingBox}, stats:{volumeCount:boxes.length, cellCount:grid.size},
    stepHeight:.7, floorAt, raycast, octree:{capsuleIntersect},
    boxIntersects(bounds) {return candidates(bounds.min.x,bounds.min.z,bounds.max.x,bounds.max.z).some(b=>b.intersectsBox(bounds));},
    dispose() {grid.clear();},
  };
}

export async function loadAscentFullCollision(url) {
  const response=await fetch(url);
  if (!response.ok) throw Error('Ascent collision HTTP '+response.status);
  return buildAscentFullCollision(await response.json());
}
