'use strict';

const fs = require('node:fs');
const path = require('node:path');
const worldPromises = new Map();
const releaseIds = Object.freeze(['ascent-full','abyss','bind','breeze','corrode','fracture','haven','icebox','lotus','pearl','split','summit','sunset']);

// Server adapter for the same exact triangle/capsule module that browsers use.
async function loadAscentWorld(id = 'ascent-b') {
  if (id!=='ascent-b'&&!releaseIds.includes(id)) throw Error('Unknown map world: ' + id);
  if (worldPromises.has(id)) return worldPromises.get(id);
  const promise = (async () => {
    const { buildAscentCollision, AscentWalker } = await import('../src/ascent-collision.mjs');
    const { Vector3, Box3 } = await import('three');
    const full = id !== 'ascent-b', dir = path.join(__dirname, '../assets/maps',id), assetBase='/assets/maps/'+id;
    const metadata = full&&id!=='ascent-full' ? JSON.parse(fs.readFileSync(path.join(dir,'map.json'),'utf8')) : null;
    const assets = full ? JSON.parse(fs.readFileSync(path.join(dir,'levels.json'),'utf8')) : null;
    if (full) {
      if (!assets.levels.length || (id==='ascent-full'&&assets.levels.length!==10)) throw Error('Incomplete map art manifest: '+id);
      for (const part of assets.levels) if (fs.statSync(path.join(dir,part.file+'.gz')).size !== part.bytes) throw Error('Incomplete Ascent art: '+part.file);
    }
    const world = full
      ? (await import('../src/ascent-full-collision.mjs')).buildAscentFullCollision(JSON.parse(fs.readFileSync(path.join(dir,'collision.json'),'utf8')))
      : buildAscentCollision(fs.readFileSync(path.join(__dirname, '../assets/maps/ascent-b.glb')));
    function safePoint(x, z, yaw, expectedY) {
      const floor = world.floorAt(x, z, expectedY === undefined ? 4 : expectedY+.4, expectedY === undefined ? 9 : .8);
      if (!floor) throw Error(`Ascent spawn has no source floor: ${x}, ${z}`);
      const walker = new AscentWalker(world, [x, floor.position.y, z]);
      for (let i = 0; i < 30; i++) walker.update({ x: 0, z: 0 }, 1 / 60);
      const p = walker.getFoot();
      if (walker.fellOut || !walker.grounded || Math.hypot(p.x - x, p.z - z) > 0.25) throw Error(`Ascent spawn is not stable: ${x}, ${z}`);
      return { x: p.x, y: p.y, z: p.z, yaw };
    }
    const cluster = (x,z,y,yaw) => [[0,0],[1.3,0],[-1.3,0],[.65,1.3],[-.65,1.3]].map(([dx,dz])=>safePoint(x+dx,z+dz,yaw,y));
    const spawns = metadata?.spawns ?? (full ? {
      attack: cluster(50.5,60.4,-1.85,-Math.PI/2),
      defend: cluster(-47.45,41.05,-.8,Math.PI/2),
    } : {
      attack: [[-23.6, -50], [-24.6, -50], [-25.6, -50], [-23.6, -51.2], [-24.6, -51.2]].map(([x, z]) => safePoint(x, z, -0.174533)),
      defend: [[-5.7, -95], [-6.9, -95], [-8.1, -95], [-9.3, -95], [-10.5, -95]].map(([x, z]) => safePoint(x, z, -2.4))
    });
    const bbox = world.geometry.boundingBox;
    const sites = metadata?.sites ?? (full ? [
      {id:'A',...safePoint(-16.26,-.54,0,1.2),radius:6,area:[-24.5,-10.5,-10.5,5.6],heightTolerance:.55},
      {id:'B',...safePoint(-26,87,0,-4.8),radius:6,area:[-36.5,-17.5,84.5,92.5],heightTolerance:.55},
    ] : [{id:'B',...safePoint(-32,-66,0),radius:8}]);
    const map = {
      id, name: metadata?.name ?? (full?'Ascent':'Ascent B'), title:metadata?.title ?? (full?'亚海悬城':'亚海悬城 · B 区旧版'), collision: full ? 'volumes' : 'triangle',
      ...(full ? {
        collisionUrl:assetBase+'/collision.json',
        levels:assets.levels.map(p=>({url:assetBase+'/'+p.file,triangles:p.triangles,bytes:p.bytes})),
        minimap:metadata?.minimap ?? {url:'/assets/ui/ascent-minimap.png',xOffset:.463895,zOffset:.146242,scale:.007},
        splash:metadata?.splash ?? '/assets/ui/ascent-splash.png',
        lighting:metadata?.lighting,
      } : {assetUrl:'/assets/maps/ascent-b.glb'}),
      description: full ? 'Release map geometry with rebuilt materials and shared gameplay collision.' : 'Original B geometry excerpt with exact capsule and ray collisions.',
      boxes: [], sites, spawns,
      bounds: { minX: bbox.min.x, maxX: bbox.max.x, minZ: bbox.min.z, maxZ: bbox.max.z },
      minY: bbox.min.y, maxY: bbox.max.y, triangleCount: full ? assets.levels.reduce((n,p)=>n+p.triangles,0) : world.stats.triangleCount
    };
    function barrierHit(walker, box) {
      const closestX = Math.max(box.x - box.w / 2, Math.min(box.x + box.w / 2, walker.capsule.start.x));
      const closestZ = Math.max(box.z - box.d / 2, Math.min(box.z + box.d / 2, walker.capsule.start.z));
      const foot = walker.getFoot();
      if (foot.y + walker.height <= box.y - box.h / 2 + 0.01 || foot.y >= box.y + box.h / 2 - 0.01) return false;
      const dx = walker.capsule.start.x - closestX, dz = walker.capsule.start.z - closestZ;
      return dx * dx + dz * dz < walker.radius * walker.radius;
    }
    function copyPlayer(p) {
      const foot = p.walker.getFoot(); p.x = foot.x; p.y = foot.y; p.z = foot.z; p.vy = p.walker.velocity.y; p.grounded = p.walker.grounded; p.crouch = p.walker.crouched;
    }
    const adapter = { map, world, stats: world.stats,
      floorAt(x, z, fromY = 4, maxDrop = 9) { const hit = world.floorAt(x, z, fromY, maxDrop); return hit ? { x: hit.position.x, y: hit.position.y, z: hit.position.z } : null; },
      raycast(origin, direction, distance = 150) { const hit = world.raycast(new Vector3(origin.x, origin.y, origin.z), new Vector3(direction.x, direction.y, direction.z), distance); return hit ? { distance: hit.distance, position: { x: hit.position.x, y: hit.position.y, z: hit.position.z } } : null; },
      attach(p, spawn) { p.spawn = spawn; p.walker = new AscentWalker(world, [spawn.x, spawn.y, spawn.z]); p.walker.velocity.y = 0; copyPlayer(p); },
      sync(p) { p.walker.reset([p.x, p.y - 0.01, p.z]); p.walker.velocity.y = p.vy || 0; copyPlayer(p); },
      step(p, direction, dt, settings = {}) {
        const walker = p.walker;
        // An explicit authoritative reset/fixture is mirrored into the capsule.
        const foot = walker.getFoot(); if (Math.hypot(foot.x - p.x, foot.y - p.y, foot.z - p.z) > 0.02) adapter.sync(p);
        const barriers = p.room?.barriers;
        // Only dynamic barriers need a rollback copy; triangle collision resolves itself.
        const before = barriers?.length ? walker.capsule.clone() : null, velocity = before ? walker.velocity.clone() : null;
        walker.update(direction, dt, settings);
        for (const box of barriers || []) if (barrierHit(walker, box)) {
          walker.capsule.copy(before); walker.velocity.copy(velocity); walker.velocity.x = 0; walker.velocity.z = 0; break;
        }
        if (walker.fellOut) {
          walker.reset([p.spawn.x, p.spawn.y, p.spawn.z]); p.fellReset = true;
        }
        copyPlayer(p); return p;
      },
      dash(p, dx, dz) {
        const distance = Math.hypot(dx, dz), steps = Math.max(1, Math.ceil(distance / 0.1)), delta = new Vector3(dx / steps, 0, dz / steps), walker = p.walker;
        for (let i = 0; i < steps; i++) {
          const before = walker.capsule.clone(); walker.capsule.translate(delta);
          for (let iteration = 0; iteration < 4; iteration++) {
            const hit = world.octree.capsuleIntersect(walker.capsule); if (!hit || hit.depth < 1e-7) break;
            walker.capsule.translate(hit.normal.clone().multiplyScalar(hit.depth + 1e-5));
          }
          if ((p.room?.barriers || []).some(box => barrierHit(walker, box))) { walker.capsule.copy(before); break; }
          const moved = walker.capsule.start.clone().sub(before.start);
          if (moved.x * delta.x + moved.z * delta.z < delta.lengthSq() * 0.05) break;
        }
        copyPlayer(p);
      },
      updraft(p, vy) { p.walker.velocity.y = vy; p.walker.grounded = false; p.vy = vy; p.grounded = false; },
      boxIntersectsSource(box) {
        const bounds = new Box3(new Vector3(box.x - box.w / 2 + 0.02, box.y - box.h / 2 + 0.05, box.z - box.d / 2 + 0.02), new Vector3(box.x + box.w / 2 - 0.02, box.y + box.h / 2 - 0.02, box.z + box.d / 2 - 0.02));
        if (world.boxIntersects) return world.boxIntersects(bounds);
        const probe = { intersectsBox: b => b.intersectsBox(bounds) };
        const triangles = world.octree.getCapsuleTriangles(probe, []);
        return triangles.some(t => bounds.intersectsTriangle(t));
      },
      dispose() { world.dispose(); }
    };
    return adapter;
  })().catch(error => { worldPromises.delete(id); throw error; });
  worldPromises.set(id,promise);
  return promise;
}

module.exports = { loadAscentWorld, releaseIds };
