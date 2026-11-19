'use strict';

const fs = require('node:fs');
const path = require('node:path');
let sharedWorldPromise;

// Server adapter for the same exact triangle/capsule module that browsers use.
async function loadAscentWorld() {
  if (sharedWorldPromise) return sharedWorldPromise;
  sharedWorldPromise = (async () => {
    const { buildAscentCollision, AscentWalker } = await import('../src/ascent-collision.mjs');
    const { Vector3, Box3 } = await import('three');
    const world = buildAscentCollision(fs.readFileSync(path.join(__dirname, '../assets/maps/ascent-b.glb')));
    function safePoint(x, z, yaw) {
      const floor = world.floorAt(x, z, 4, 9);
      if (!floor) throw Error(`Ascent spawn has no source floor: ${x}, ${z}`);
      const walker = new AscentWalker(world, [x, floor.position.y, z]);
      for (let i = 0; i < 30; i++) walker.update({ x: 0, z: 0 }, 1 / 60);
      const p = walker.getFoot();
      if (walker.fellOut || !walker.grounded || Math.hypot(p.x - x, p.z - z) > 0.25) throw Error(`Ascent spawn is not stable: ${x}, ${z}`);
      return { x: p.x, y: p.y, z: p.z, yaw };
    }
    const spawns = {
      attack: [[-23.6, -50], [-24.6, -50], [-25.6, -50], [-23.6, -51.2], [-24.6, -51.2]].map(([x, z]) => safePoint(x, z, -0.174533)),
      defend: [[-5.7, -95], [-6.9, -95], [-8.1, -95], [-9.3, -95], [-10.5, -95]].map(([x, z]) => safePoint(x, z, -2.4))
    };
    const site = safePoint(-32, -66, 0), bbox = world.geometry.boundingBox;
    const map = {
      id: 'ascent-b', name: 'Ascent B · source geometry', collision: 'triangle', assetUrl: '/assets/maps/ascent-b.glb',
      description: 'Original B geometry excerpt with exact capsule and ray collisions. Missing source floor gaps are preserved; not the full Ascent map.',
      boxes: [], sites: [{ id: 'B', x: site.x, y: site.y, z: site.z, radius: 8 }], spawns,
      bounds: { minX: bbox.min.x, maxX: bbox.max.x, minZ: bbox.min.z, maxZ: bbox.max.z },
      minY: bbox.min.y, maxY: bbox.max.y, triangleCount: world.stats.triangleCount
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
        const probe = { intersectsBox: b => b.intersectsBox(bounds) };
        const triangles = world.octree.getCapsuleTriangles(probe, []);
        return triangles.some(t => bounds.intersectsTriangle(t));
      },
      dispose() { world.dispose(); }
    };
    return adapter;
  })().catch(error => { sharedWorldPromise = undefined; throw error; });
  return sharedWorldPromise;
}

module.exports = { loadAscentWorld };
