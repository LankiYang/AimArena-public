'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer, WebSocket } = require('ws');
const { MAP } = require('./shared/world.cjs');
const { loadAscentWorld, releaseIds } = require('./shared/ascent-world.cjs');
const { isInPlantZone } = require('./src/plant-zone.mjs');
const { botMode, loadNavigation, botDeployment, updateBot } = require('./shared/bots.cjs');

const WEAPONS = {
  classic: { name: 'CLASSIC', price: 0, magazine: 12, reserve: 36, damage: 26, head: 78, interval: 190, reloadMs: 1750, range: 65 },
  spectre: { name: 'SPECTRE', price: 1600, magazine: 30, reserve: 90, damage: 26, head: 78, interval: 81, reloadMs: 2250, range: 80 },
  vandal: { name: 'VANDAL', price: 2900, magazine: 25, reserve: 75, damage: 40, head: 160, interval: 100, reloadMs: 2500, range: 120 },
  phantom: { name: 'PHANTOM', price: 2900, magazine: 30, reserve: 90, damage: 39, head: 156, interval: 91, reloadMs: 2500, range: 100 },
  sheriff: { name: 'SHERIFF', price: 800, magazine: 6, reserve: 24, damage: 55, head: 159, interval: 400, reloadMs: 2250, range: 100 }
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const finite = (v, fallback = 0) => Number.isFinite(v) ? v : fallback;
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const clean = (s, max) => String(s || '').normalize('NFKC').replace(/[\x00-\x1f<>]/g, '').slice(0, max);

function rayBox(origin, dir, box, maxDistance = Infinity) {
  let near = 0, far = maxDistance;
  for (const [axis, size] of [['x', 'w'], ['y', 'h'], ['z', 'd']]) {
    const low = box[axis] - box[size] / 2, high = box[axis] + box[size] / 2;
    if (Math.abs(dir[axis]) < 1e-9) { if (origin[axis] < low || origin[axis] > high) return Infinity; continue; }
    let a = (low - origin[axis]) / dir[axis], b = (high - origin[axis]) / dir[axis];
    if (a > b) [a, b] = [b, a];
    near = Math.max(near, a); far = Math.min(far, b);
    if (far < near) return Infinity;
  }
  return near;
}

function overlapsWorld(x, z, y = 0, crouch = false, barriers = [], map = MAP) {
  const radius = 0.32, height = crouch ? 1.2 : 1.8;
  if (x < map.bounds.minX + radius || x > map.bounds.maxX - radius || z < map.bounds.minZ + radius || z > map.bounds.maxZ - radius) return true;
  return [...map.boxes, ...barriers].some(b => y < b.y + b.h / 2 - 0.02 && y + height > b.y - b.h / 2 + 0.02 &&
    Math.abs(x - b.x) < b.w / 2 + radius && Math.abs(z - b.z) < b.d / 2 + radius);
}

function movePlayer(p, dx, dz) {
  if (p.room?.ascent) return p.room.ascent.dash(p, dx, dz);
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.15));
  const barriers = p.room?.barriers || [];
  const map = p.room?.map || MAP;
  for (let i = 0; i < steps; i++) {
    if (!overlapsWorld(p.x + dx / steps, p.z, p.y, p.crouch, barriers, map)) p.x += dx / steps;
    if (!overlapsWorld(p.x, p.z + dz / steps, p.y, p.crouch, barriers, map)) p.z += dz / steps;
  }
}

function createGameServer(options = {}) {
  const root = path.resolve(options.root || __dirname);
  const duration = { buy: 20000, live: 100000, end: 5000, plant: 3200, defuse: 7000, bomb: 40000, ...(options.durations || {}) };
  const now = options.now || Date.now;
  const rooms = new Map();
  const clients = new Set();
  const adapters = new Map([options.ascentWorld,options.ascentFullWorld,...(options.releaseWorlds||[])].filter(Boolean).map(a=>[a.map.id,a]));
  const worlds = new Map([...(options.boxWorlds||[]).map(map=>[map.id,map]), ...[...adapters].map(([id,a])=>[id,a.map])]);
  const defaultMapId = worlds.has('ascent-full') ? 'ascent-full' : worlds.keys().next().value;
  const catalog=[...worlds.values()].map(({id,name,title,splash,sites,collision})=>({id,name,title,splash,sites:sites.map(s=>s.id),release:collision==='volumes'}));
  const compressedLevels=new Set([...worlds.values()].flatMap(map=>map.levels?.map(level=>level.url)??[]));
  let nextId = 0, tick = 0;
  const server = http.createServer((req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { allow: 'GET, HEAD' }); res.end('Method not allowed'); return; }
    const parsedUrl = new URL(req.url, 'http://localhost'), pathname = parsedUrl.pathname;
    if(pathname==='/maps.json'){
      res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
      res.end(JSON.stringify(catalog));return;
    }
    if (pathname === '/world.json') {
      const map = worlds.get(parsedUrl.searchParams.get('map') || defaultMapId);
      res.writeHead(map ? 200 : 404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(map || { error: 'MAP_UNAVAILABLE' })); return;
    }
    if (pathname === '/ascent-preview.html') {
      res.writeHead(302, { location: '/?map=ascent-full', 'cache-control': 'no-store' }); res.end(); return;
    }
    if (pathname === '/health') {
      const players=[...rooms.values()].flatMap(r=>[...r.players.values()]);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok:true, rooms:rooms.size, players:players.filter(p=>!p.bot).length, bots:players.filter(p=>p.bot).length, botSupport:1, tick })); return;
    }
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { res.writeHead(400); res.end(); return; }
    const publicPath = decoded === '/' ? '/index.html' : decoded;
    const allowed = ['/index.html', '/showcase.html', '/style.css'].includes(publicPath) ||
      ['/src/', '/assets/', '/node_modules/three/build/', '/node_modules/three/examples/jsm/'].some(prefix => publicPath.startsWith(prefix));
    const compressed = compressedLevels.has(publicPath);
    const file = path.resolve(root, '.' + publicPath + (compressed ? '.gz' : ''));
    if (!allowed || !file.startsWith(root + path.sep) || /[\\]/.test(decoded) || /(?:^|\/)\.[^/]*(?:\/|$)/.test(decoded)) { res.writeHead(403); res.end('Forbidden'); return; }
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'content-type': mime[path.extname(publicPath).toLowerCase()] || 'application/octet-stream', 'content-length':stat.size, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', ...(compressed ? {'content-encoding':'gzip'} : {}) });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file).pipe(res);
    });
  });
  const wss = new WebSocketServer({ server, maxPayload: 16384, perMessageDeflate: false });
  function send(ws, data) { if (ws?.readyState === WebSocket.OPEN && ws.bufferedAmount < 2e6) ws.send(JSON.stringify(data)); }
  function error(ws, code, message) { send(ws, { type: 'error', code, message }); }
  function broadcast(r, data) { for (const p of r.players.values()) send(p.ws, data); }
  function event(r, name, data = {}) { broadcast(r, { type: 'event', event: name, serverTime: now(), ...data }); }
  function newRoom(id, mapId, mode, botNav) {
    const r = { id, mapId, map: worlds.get(mapId), ascent: adapters.get(mapId) || null, botMode:mode, botNav, players: new Map(), phase: 'waiting', phaseEndsAt: 0, round: 0, score: { attack: 0, defend: 0 }, smokes: [], barriers: [], slows: [], bomb: null, lastResult: null };
    rooms.set(id, r); return r;
  }
  function presentTeams(r) { return new Set([...r.players.values()].map(p => p.team)).size === 2; }
  function equip(p, weapon) { const w = WEAPONS[weapon]; p.weapon = weapon; p.ammo = w.magazine; p.reserve = w.reserve; p.reloading = 0; }
  function resetPlayer(p, index) {
    const map = p.room.map, spawn = map.spawns[p.team][index % map.spawns[p.team].length];
    Object.assign(p, spawn, { hp: 100, alive: true, pitch: 0, crouch: false, vy: 0, grounded: true, speed: 5.2, armor: 0, hasBomb: false, input: null, history: [], interacting: null, lastFire: 0, abilityCooldowns: { smoke: 0, updraft: 0, dash: 0, wall: 0, slow: 0, heal: 0 } });
    equip(p, p.weapon || 'phantom');
    if (p.room.ascent) p.room.ascent.attach(p, spawn);
    if(p.bot)botDeployment(p);
  }
  function fillBotSeats(r) {
    if(!r.botMode)return;
    for(const team of ['attack','defend']){
      const seated=[...r.players.values()].filter(p=>p.team===team);
      const used=new Set(seated.filter(p=>p.bot).map(p=>p.botSlot));
      for(let i=seated.length;i<5;i++){
        const id='b'+(++nextId).toString(36), botSlot=[0,1,2,3,4].find(slot=>!used.has(slot));
        used.add(botSlot);
        const p={id,name:'BOT '+(team==='attack'?'A':'D')+(botSlot+1),team,agent:botSlot%2?'sage':'jett',room:r,bot:true,botSlot,weapon:'phantom',credits:8000,kills:0,deaths:0,ackSeq:0};
        resetPlayer(p,i);
        r.players.set(id,p);
      }
    }
  }
  function beginBuy(r) {
    fillBotSeats(r);
    if (!presentTeams(r)) return;
    r.round++; r.phase = 'buy'; r.phaseEndsAt = now() + (r.botMode?Math.min(duration.buy,6500):duration.buy); r.smokes = []; r.barriers = []; r.slows = []; r.lastResult = null;
    const counts = { attack: 0, defend: 0 };
    for (const p of r.players.values()) resetPlayer(p, counts[p.team]++);
    const carrier = [...r.players.values()].filter(p=>p.team==='attack').sort((a,b)=>r.botMode?Number(!!b.bot)-Number(!!a.bot):0)[0];
    carrier.hasBomb = true;
    r.bomb = { state: 'carried', carrierId: carrier.id, x: carrier.x, y: carrier.y, z: carrier.z, site: null, progress: 0, endsAt: 0, interactorId: null };
    event(r, 'roundStart', { round: r.round, phase: 'buy' });
  }
  function endRound(r, winner, reason) {
    if (r.phase !== 'live') return;
    r.score[winner]++; r.phase = 'end'; r.phaseEndsAt = now() + duration.end;
    r.lastResult = { winner, reason, round: r.round };
    for (const p of r.players.values()) { p.credits = Math.min(9000, p.credits + (p.team === winner ? 3000 : 1900)); p.interacting = null; }
    event(r, 'roundEnd', r.lastResult);
  }
  function checkElimination(r) {
    if (r.phase !== 'live') return;
    const alive = { attack: 0, defend: 0 };
    for (const p of r.players.values()) if (p.alive) alive[p.team]++;
    if (!alive.defend) endRound(r, 'attack', 'elimination');
    else if (!alive.attack && !['planted', 'defusing'].includes(r.bomb?.state)) endRound(r, 'defend', 'elimination');
  }
  function dropBomb(r, p) {
    if (p.hasBomb && r.bomb) { p.hasBomb = false; Object.assign(r.bomb, { state: 'dropped', carrierId: null, x: p.x, y: p.y, z: p.z, progress: 0, interactorId: null }); }
  }
  function cancelInteract(r, p) {
    p.interacting = null;
    if (r.bomb?.interactorId === p.id) { r.bomb.interactorId = null; r.bomb.progress = 0; if (r.bomb.state === 'planting') r.bomb.state = 'carried'; if (r.bomb.state === 'defusing') r.bomb.state = 'planted'; }
  }
  function publicPlayer(p) {
    return { id: p.id, name: p.name, bot:!!p.bot, team: p.team, agent: p.agent, x: p.x, y: p.y, z: p.z, vy: p.vy || 0, grounded: !!p.grounded, speed: p.speed || 5.2, yaw: p.yaw, pitch: p.pitch, crouch: p.crouch, hp: p.hp, armor: p.armor, alive: p.alive, weapon: p.weapon, ammo: p.ammo, reserve: p.reserve, credits: p.credits, reloading: p.reloading, abilityCooldowns: p.abilityCooldowns, hasBomb: p.hasBomb, ackSeq: p.ackSeq };
  }
  function snapshot(r) {
    const base = { type: 'snapshot', serverTime: now(), tick, room: r.id, mapId: r.mapId, botMode:r.botMode, phase: r.phase, phaseEndsAt: r.phaseEndsAt, round: r.round, score: r.score, players: [...r.players.values()].map(publicPlayer), bomb: r.bomb, smokes: r.smokes, barriers: r.barriers, slows: r.slows, lastResult: r.lastResult };
    for (const p of r.players.values()) send(p.ws, { ...base, selfId: p.id, ackSeq: p.ackSeq });
  }
  function join(ws, m) {
    if (ws.player) return error(ws, 'ALREADY_JOINED', 'Already in a room');
    const roomId = clean(m.room || 'public', 24).replace(/[^\p{L}\p{N}_-]/gu, '') || 'public';
    let r = rooms.get(roomId);
    const requestedMap = m.map || m.mapId || r?.mapId || defaultMapId;
    if (!worlds.has(requestedMap)) return error(ws, 'MAP_UNAVAILABLE', 'This map is not available on the server');
    if (r && r.mapId !== requestedMap) return error(ws, 'MAP_MISMATCH', 'This room is locked to map ' + r.mapId);
    const mode=m.botMode===undefined&&r?r.botMode:botMode(m.botMode);
    if (r && r.botMode!==mode) return error(ws, 'MODE_MISMATCH', 'This room uses a different match mode');
    if (r && [...r.players.values()].filter(p=>!p.bot).length>=10) return error(ws, 'ROOM_FULL', 'Room is full (10 players)');
    if (!r && rooms.size >= 32) return error(ws, 'SERVER_BUSY', 'Room limit reached; please try again later');
    const nav=r?.botNav??(mode?loadNavigation(adapters.get(requestedMap)):null);
    if(mode&&!nav)return error(ws,'BOT_UNAVAILABLE','This map has no bot navigation');
    r ||= newRoom(roomId, requestedMap, mode, nav);
    const teams = { attack: 0, defend: 0 }; for (const p of r.players.values()) if(!p.bot)teams[p.team]++;
    let team = ['attack', 'defend'].includes(m.team) ? m.team : teams.attack <= teams.defend ? 'attack' : 'defend';
    if (teams[team] >= 5) team = team === 'attack' ? 'defend' : 'attack';
    const p = { id: 'p' + (++nextId).toString(36), ws, room: r, name: clean(m.name || 'AGENT', 16), team, agent: String(m.agent || '').toLowerCase() === 'sage' ? 'sage' : 'jett', weapon: 'phantom', credits: 8000, ackSeq: -1, inputSeq: -1, lastInputAt: 0, kills: 0, deaths: 0 };
    const teammates=[...r.players.values()].filter(other=>other.team===team);
    const replaced=teammates.length>=5?(teammates.findLast(other=>other.bot&&!other.alive)
      ??teammates.findLast(other=>other.bot&&!other.hasBomb&&!other.interacting)
      ??teammates.findLast(other=>other.bot)):null;
    if(replaced){cancelInteract(r,replaced);dropBomb(r,replaced);r.players.delete(replaced.id);event(r,'left',{playerId:replaced.id,name:replaced.name});}
    const spawnIndex=replaced?r.map.spawns[team].indexOf(replaced.spawn):teammates.length;
    resetPlayer(p,Math.max(0,spawnIndex));
    if (r.phase === 'live' || r.phase === 'end') p.alive = false;
    ws.player = p; r.players.set(p.id, p);
    send(ws, { type: 'welcome', selfId: p.id, room: r.id, map: r.mapId, mapId: r.mapId, botMode:r.botMode, world: r.map, serverTime: now(), weapons: { phantom: WEAPONS.phantom } });
    event(r, 'joined', { playerId: p.id, name: p.name, team: p.team });
    if (r.phase === 'waiting' && (r.botMode||presentTeams(r))) beginBuy(r);
    snapshot(r);
  }
  function fire(p, m) {
    const r = p.room, time = now(), w = WEAPONS[p.weapon];
    if (!p.alive || !['live', 'waiting'].includes(r.phase)) return;
    if (p.reloading || p.ammo < 1 || time - p.lastFire < w.interval - 4) return;
    if (!Number.isFinite(m.yaw) || !Number.isFinite(m.pitch)) return error(p.ws, 'BAD_AIM', 'Aim must be finite');
    p.lastFire = time; p.ammo--; cancelInteract(r, p);
    const yaw = m.yaw, pitch = clamp(m.pitch, -1.5, 1.5), cos = Math.cos(pitch);
    const origin = { x: p.x, y: p.y + (p.crouch ? 1.05 : 1.62), z: p.z };
    const dir = { x: Math.sin(yaw) * cos, y: Math.sin(pitch), z: -Math.cos(yaw) * cos };
    let distance = w.range, target = null, headshot = false, barrier = null;
    if (r.ascent) distance = Math.min(distance, r.ascent.raycast(origin, dir, distance)?.distance ?? distance);
    else for (const box of r.map.boxes) distance = Math.min(distance, rayBox(origin, dir, box, distance));
    for (const box of r.barriers) { const hit = rayBox(origin, dir, box, distance); if (hit < distance) { distance = hit; barrier = box; } }
    const shotTime = clamp(finite(m.clientTime, time), time - 200, time);
    for (const other of r.players.values()) {
      if (other.id === p.id || other.team === p.team || !other.alive) continue;
      let h = other;
      for (let i = other.history.length - 1; i >= 0; i--) if (other.history[i].time <= shotTime) { h = other.history[i]; break; }
      const height = h.crouch ? 1.2 : 1.8;
      const body = rayBox(origin, dir, { x: h.x, y: h.y + height * 0.41, z: h.z, w: 0.56, h: height * 0.78, d: 0.56 }, distance);
      const head = rayBox(origin, dir, { x: h.x, y: h.y + height - 0.18, z: h.z, w: 0.39, h: 0.36, d: 0.39 }, distance);
      const hit = Math.min(body, head);
      if (hit < distance) { distance = hit; target = other; barrier = null; headshot = head <= body; }
    }
    const end = { x: origin.x + dir.x * distance, y: origin.y + dir.y * distance, z: origin.z + dir.z * distance };
    event(r, 'shot', { playerId: p.id, weapon: p.weapon, origin, end, shotId: m.shotId });
    if (barrier) {
      barrier.hp = Math.max(0, barrier.hp - w.damage);
      event(r, barrier.hp ? 'wallHit' : 'wallBreak', { playerId: p.id, barrierId: barrier.id, hp: barrier.hp });
      if (!barrier.hp) r.barriers = r.barriers.filter(b => b.id !== barrier.id);
      return;
    }
    if (!target) return;
    let damage = headshot ? w.head : w.damage;
    if (p.weapon === 'spectre' && distance > 20) damage = Math.round(damage * 0.8);
    const absorbed = Math.min(target.armor, damage * 0.66); target.armor = Math.max(0, target.armor - absorbed);
    target.hp = Math.max(r.phase === 'waiting' ? 1 : 0, target.hp - (damage - absorbed)); cancelInteract(r, target);
    event(r, 'hit', { playerId: p.id, targetId: target.id, damage, headshot, hp: target.hp });
    if (target.hp <= 0) {
      target.alive = false; target.deaths++; p.kills++; p.credits = Math.min(9000, p.credits + 200); dropBomb(r, target);
      event(r, 'kill', { playerId: p.id, killerName: p.name, targetId: target.id, targetName: target.name, weapon: p.weapon, headshot });
      checkElimination(r);
    }
  }
  function ability(p, m) {
    const r = p.room, map = r.map, time = now(); if (!p.alive || !['live', 'waiting'].includes(r.phase)) return;
    const skills = p.agent === 'sage' ? ['wall', 'slow', 'heal'] : ['smoke', 'updraft', 'dash'];
    const skill = m.skill || ({ 1: skills[0], 2: skills[1], 3: skills[2], c: skills[0], q: skills[1], e: skills[2] })[m.slot];
    if (!skills.includes(skill)) return error(p.ws, 'ABILITY', 'This agent does not have this ability');
    if (p.abilityCooldowns[skill] > time) return;
    if (skill === 'smoke' || skill === 'slow') {
      let x = finite(m.x, p.x + Math.sin(p.yaw) * 10), z = finite(m.z, p.z - Math.cos(p.yaw) * 10);
      const distance = Math.hypot(x - p.x, z - p.z); if (distance > 18) { x = p.x + (x - p.x) * 18 / distance; z = p.z + (z - p.z) * 18 / distance; }
      x = clamp(x, map.bounds.minX, map.bounds.maxX); z = clamp(z, map.bounds.minZ, map.bounds.maxZ);
      const floor = r.ascent?.floorAt(x, z, p.y + 4, 12);
      if (r.ascent && !floor) return error(p.ws, 'NO_SURFACE', 'This point has no floor in the source geometry');
      const zone = { id: `${p.id}-${time}`, x, y: (floor?.y || 0) + (skill === 'smoke' ? 1.8 : 0.03), z, radius: skill === 'smoke' ? 3.5 : 4.5, endsAt: time + (skill === 'smoke' ? 9000 : 7000), team: p.team };
      (skill === 'smoke' ? r.smokes : r.slows).push(zone); p.abilityCooldowns[skill] = time + (skill === 'smoke' ? 10000 : 12000); event(r, 'ability', { playerId: p.id, skill, ...zone });
    } else if (skill === 'updraft') {
      p.vy = 7.5; p.grounded = false; r.ascent?.updraft(p, 7.5); p.abilityCooldowns.updraft = time + 15000; event(r, 'ability', { playerId: p.id, skill, vy: p.vy });
    } else if (skill === 'wall') {
      const fx = Math.sin(p.yaw), fz = -Math.cos(p.yaw), rx = Math.cos(p.yaw), rz = Math.sin(p.yaw);
      const blocks = Array.from({ length: 4 }, (_, i) => ({
        id: `${p.id}-wall-${time}-${i}`, x: p.x + fx * 5 + rx * (i - 1.5) * 1.65, y: p.y + 1.5, z: p.z + fz * 5 + rz * (i - 1.5) * 1.65,
        w: Math.abs(rx) * 1.65 + Math.abs(fx) * 0.65, h: 3, d: Math.abs(rz) * 1.65 + Math.abs(fz) * 0.65,
        hp: 400, endsAt: time + 25000, team: p.team
      }));
      if (r.ascent) {
        for (const block of blocks) {
          const floor = r.ascent.floorAt(block.x, block.z, p.y + 3, 5);
          if (!floor || Math.abs(floor.y - p.y) > 1.5) return error(p.ws, 'WALL_BLOCKED', 'Wall needs a continuous source floor');
          block.y = floor.y + block.h / 2;
        }
      }
      const collidesBox = (a, b) => Math.abs(a.x - b.x) < (a.w + b.w) / 2 + 0.03 && Math.abs(a.z - b.z) < (a.d + b.d) / 2 + 0.03 && Math.abs(a.y - b.y) < (a.h + b.h) / 2 - 0.03;
      const occupied = blocks.some(a => a.x - a.w / 2 < map.bounds.minX || a.x + a.w / 2 > map.bounds.maxX || a.z - a.d / 2 < map.bounds.minZ || a.z + a.d / 2 > map.bounds.maxZ ||
        (r.ascent && r.ascent.boxIntersectsSource(a)) || [...map.boxes, ...r.barriers].some(b => collidesBox(a, b)) || [...r.players.values()].some(other => other.alive && collidesBox(a, { x: other.x, y: other.y + 0.9, z: other.z, w: 0.7, h: 1.8, d: 0.7 })));
      if (occupied) return error(p.ws, 'WALL_BLOCKED', 'Wall placement overlaps a building, player, or map boundary');
      r.barriers.push(...blocks); p.abilityCooldowns.wall = time + 35000; event(r, 'ability', { playerId: p.id, skill, barriers: blocks });
    } else if (skill === 'dash') {
      const inp = p.input, len = Math.hypot(inp?.moveX || 0, inp?.moveZ || 0);
      const dx = len > 0.1 ? inp.moveX / len : Math.sin(p.yaw), dz = len > 0.1 ? inp.moveZ / len : -Math.cos(p.yaw);
      movePlayer(p, dx * 7, dz * 7); p.abilityCooldowns.dash = time + 18000; event(r, 'ability', { playerId: p.id, skill, x: p.x, y: p.y, z: p.z });
    } else {
      p.hp = Math.min(100, p.hp + 65); p.abilityCooldowns.heal = time + 25000; event(r, 'ability', { playerId: p.id, skill, hp: p.hp });
    }
    cancelInteract(r, p);
  }
  function interact(p, m) {
    const r = p.room; if (m.action === 'stop') { cancelInteract(r, p); return; }
    if (!p.alive || r.phase !== 'live' || !r.bomb) return;
    const bomb = r.bomb;
    if (p.team === 'attack' && bomb.state === 'dropped' && dist2(p, bomb) < 2 && Math.abs(p.y - bomb.y) < 2) { bomb.state = 'carried'; bomb.carrierId = p.id; p.hasBomb = true; event(r, 'pickup', { playerId: p.id }); return; }
    if (p.team === 'attack' && p.hasBomb && bomb.state === 'carried') {
      const site = r.map.sites.find(s => isInPlantZone(p, s));
      if (!site) return error(p.ws, 'PLANT_SITE', 'Carry the spike into site A or B');
      if (r.ascent && (!p.grounded || !r.ascent.floorAt(p.x, p.z, p.y + 0.5, 1))) return error(p.ws, 'NO_SURFACE', 'Plant only on a real source floor');
      bomb.state = 'planting'; bomb.interactorId = p.id; bomb.site = site.id;
      p.interacting = { action: 'plant', start: now(), x: p.x, y: p.y, z: p.z }; event(r, 'plantStart', { playerId: p.id, site: site.id });
    } else if (p.team === 'defend' && bomb.state === 'planted' && dist2(p, bomb) < 2.6 && Math.abs(p.y - bomb.y) < 2) {
      bomb.state = 'defusing'; bomb.interactorId = p.id;
      p.interacting = { action: 'defuse', start: now(), x: p.x, y: p.y, z: p.z }; event(r, 'defuseStart', { playerId: p.id });
    }
  }
  function reload(p) {
    const w=WEAPONS[p.weapon];
    if(p.alive&&!p.reloading&&p.reserve>0&&p.ammo<w.magazine){
      p.reloading=now()+w.reloadMs;event(p.room,'reload',{playerId:p.id,endsAt:p.reloading});
    }
  }
  const botActions={fire,interact,reload,rayBox,random:options.random||Math.random};
  function handle(ws, m) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'ping') { send(ws, { type: 'pong', clientTime: m.clientTime, serverTime: now() }); return; }
    if (m.type === 'join') return join(ws, m);
    const p = ws.player; if (!p) return error(ws, 'JOIN_FIRST', 'Join a room first');
    const r = p.room;
    if (m.type === 'input') {
      if (!Number.isSafeInteger(m.seq) || m.seq <= p.inputSeq || ![m.moveX, m.moveZ, m.yaw, m.pitch].every(Number.isFinite)) return;
      p.inputSeq = m.seq; p.lastInputAt = now();
      p.input = { seq: m.seq, moveX: clamp(m.moveX, -1, 1), moveZ: clamp(m.moveZ, -1, 1), yaw: m.yaw % (Math.PI * 2), pitch: clamp(m.pitch, -1.5, 1.5), jump: !!m.jump, walk: !!m.walk, crouch: !!m.crouch };
    } else if (m.type === 'fire') fire(p, m);
    else if (m.type === 'reload') reload(p);
    else if (m.type === 'buy') {
      if (!['buy', 'waiting'].includes(r.phase) || !p.alive) return error(ws, 'BUY_PHASE', 'Purchases are available during the buy phase');
      if (m.weapon === 'armor') { if (p.armor >= 50) return; if (p.credits < 1000) return error(ws, 'CREDITS', 'Not enough credits'); p.credits -= 1000; p.armor = 50; }
      else { const w = m.weapon === 'phantom' && Object.hasOwn(WEAPONS, m.weapon) ? WEAPONS[m.weapon] : null; if (!w) return error(ws, 'WEAPON', 'Only Phantom and armor are available in this slice'); if (p.credits < w.price) return error(ws, 'CREDITS', 'Not enough credits'); p.credits -= w.price; equip(p, m.weapon); }
      event(r, 'purchase', { playerId: p.id, weapon: m.weapon });
    } else if (m.type === 'ability') ability(p, m);
    else if (m.type === 'interact') interact(p, m);
    else if (m.type === 'ready' && r.phase === 'buy') r.phaseEndsAt = Math.min(r.phaseEndsAt, now() + (options.readyMs ?? 3000));
  }
  wss.on('connection', ws => {
    if (clients.size >= 128) { ws.close(1013, 'Server busy'); return; }
    clients.add(ws); ws.alive = true; ws.windowAt = now(); ws.messageCount = 0;
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', (raw, binary) => {
      if (binary) return;
      if (now() - ws.windowAt > 1000) { ws.windowAt = now(); ws.messageCount = 0; }
      if (++ws.messageCount > 220) return;
      try { handle(ws, JSON.parse(raw.toString('utf8'))); } catch { error(ws, 'MESSAGE', 'Invalid message'); }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      clients.delete(ws); const p = ws.player; if (!p) return;
      const r = p.room; cancelInteract(r, p); dropBomb(r, p); r.players.delete(p.id); event(r, 'left', { playerId: p.id, name: p.name });
      if (![...r.players.values()].some(other=>!other.bot)) rooms.delete(r.id);
      else if (!presentTeams(r)) { r.phase = 'waiting'; r.phaseEndsAt = 0; r.bomb = null; for (const other of r.players.values()) { other.alive = true; other.hp = 100; other.hasBomb = false; } }
      else checkElimination(r);
    });
  });
  function update(dt) {
    const time = now(); tick++;
    for (const r of rooms.values()) {
      if (r.phase === 'buy' && time >= r.phaseEndsAt) { r.phase = 'live'; r.liveAt=time; r.phaseEndsAt = time + duration.live; event(r, 'live', { round: r.round }); }
      if (r.phase === 'end' && time >= r.phaseEndsAt) { if (r.botMode||presentTeams(r)) beginBuy(r); else r.phase = 'waiting'; }
      r.smokes = r.smokes.filter(s => s.endsAt > time);
      r.barriers = r.barriers.filter(b => b.hp > 0 && b.endsAt > time);
      r.slows = r.slows.filter(s => s.endsAt > time);
      for (const p of r.players.values()) {
        if (p.reloading && time >= p.reloading) { const amount = Math.min(WEAPONS[p.weapon].magazine - p.ammo, p.reserve); p.ammo += amount; p.reserve -= amount; p.reloading = 0; }
        if (!p.alive) continue;
        if (p.bot) updateBot(p,time,dt,botActions);
        const input = p.input && time - p.lastInputAt < 250 ? p.input : null;
        if (r.ascent) {
          if (input) { p.yaw = input.yaw; p.pitch = input.pitch; p.ackSeq = input.seq; }
          const slowed = r.slows.some(s => s.team !== p.team && Math.abs(p.y - s.y) < 0.85 && dist2(p, s) < s.radius);
          const speed = (input?.crouch ? 2.1 : input?.walk ? 2.8 : 5.2) * (slowed ? 0.45 : 1);
          p.speed = speed;
          const direction = r.phase === 'end' || !input ? { x: 0, z: 0 } : { x: input.moveX, z: input.moveZ };
          const before = r.phase === 'buy' ? p.walker.capsule.clone() : null;
          r.ascent.step(p, direction, dt, { jump: !!input?.jump && r.phase !== 'end', crouch: !!input?.crouch, speed });
          if (input?.jump) input.jump = false;
          if (r.phase === 'buy' && Math.hypot(p.x - p.spawn.x, p.z - p.spawn.z) > 4) { p.walker.capsule.copy(before); const foot = p.walker.getFoot(); p.x = foot.x; p.y = foot.y; p.z = foot.z; }
          if (p.fellReset) { p.fellReset = false; cancelInteract(r, p); if(p.bot)botDeployment(p); event(r, 'sourceGapReset', { playerId: p.id, x: p.x, y: p.y, z: p.z }); }
        } else {
        if (input && time - p.lastInputAt < 250) {
          p.yaw = input.yaw; p.pitch = input.pitch; if (input.crouch || !overlapsWorld(p.x, p.z, p.y, false, r.barriers, r.map)) p.crouch = input.crouch; p.ackSeq = input.seq;
          if (r.phase !== 'end') {
            const norm = Math.max(1, Math.hypot(input.moveX, input.moveZ)); const slowed = r.slows.some(s => s.team !== p.team && p.y < 0.8 && dist2(p, s) < s.radius); const speed = (p.crouch ? 2.1 : input.walk ? 2.8 : 5.2) * (slowed ? 0.45 : 1);
            p.speed = speed;
            movePlayer(p, input.moveX / norm * speed * dt, input.moveZ / norm * speed * dt);
            if (r.phase === 'buy') p.z = p.team === 'attack' ? Math.max(20, p.z) : Math.min(-20, p.z);
            if (input.jump && p.grounded) { p.vy = 5.8; p.grounded = false; input.jump = false; }
          }
        }
        if (p.y > 0 || p.vy > 0) {
          const oldY = p.y; p.vy -= 18 * dt; p.y = Math.max(0, p.y + p.vy * dt); p.grounded = p.y === 0;
          if (p.vy <= 0) for (const b of [...r.map.boxes, ...r.barriers]) {
            const top = b.y + b.h / 2;
            if (oldY >= top - 0.03 && p.y <= top && Math.abs(p.x - b.x) < b.w / 2 + 0.28 && Math.abs(p.z - b.z) < b.d / 2 + 0.28) { p.y = top; p.vy = 0; p.grounded = true; }
          }
          if (overlapsWorld(p.x, p.z, p.y, p.crouch, r.barriers, r.map) && p.y > oldY) { p.y = oldY; p.vy = 0; }
          if (!p.y) p.vy = 0;
        }
        }
        if (p.interacting) {
          if (!p.alive || dist2(p, p.interacting) > 0.65 || (r.ascent && (!p.grounded || Math.abs(p.y - p.interacting.y) > 0.5)) || r.phase !== 'live') { cancelInteract(r, p); continue; }
          const action = p.interacting.action, elapsed = time - p.interacting.start, required = action === 'plant' ? duration.plant : duration.defuse;
          r.bomb.progress = clamp(elapsed / required, 0, 1);
          if (elapsed >= required) {
            if (action === 'plant') { Object.assign(r.bomb, { state: 'planted', carrierId: null, x: p.x, y: p.y, z: p.z, progress: 0, endsAt: time + duration.bomb, interactorId: null }); p.hasBomb = false; event(r, 'plant', { playerId: p.id, site: r.bomb.site, endsAt: r.bomb.endsAt }); }
            else { Object.assign(r.bomb, { state: 'defused', progress: 1, interactorId: null }); event(r, 'defuse', { playerId: p.id }); endRound(r, 'defend', 'defused'); }
            p.interacting = null;
          }
        }
        if (r.bomb?.carrierId === p.id) { r.bomb.x = p.x; r.bomb.y = p.y; r.bomb.z = p.z; }
        if (r.bomb?.state === 'dropped' && p.team === 'attack' && dist2(p, r.bomb) < 1.2 && Math.abs(p.y - r.bomb.y) < 2) { r.bomb.state = 'carried'; r.bomb.carrierId = p.id; p.hasBomb = true; }
        p.history.push({ time, x: p.x, y: p.y, z: p.z, crouch: p.crouch });
        if (p.history.length > 24) p.history.shift();
      }
      if (r.phase === 'live') {
        if (['planted', 'defusing'].includes(r.bomb?.state) && time >= r.bomb.endsAt) { r.bomb.state = 'exploded'; endRound(r, 'attack', 'exploded'); }
        else if (time >= r.phaseEndsAt && !['planted', 'defusing'].includes(r.bomb?.state)) endRound(r, 'defend', 'time');
      }
      if (tick % 3 === 0) snapshot(r);
    }
  }
  let previous = now();
  const timer = setInterval(() => { const time = now(); update(clamp((time - previous) / 1000, 0, 0.05)); previous = time; }, 1000 / 60);
  const heartbeat = setInterval(() => { for (const ws of clients) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } } }, 15000);
  async function close() { clearInterval(timer); clearInterval(heartbeat); for (const ws of clients) ws.terminate(); await new Promise(resolve => wss.close(resolve)); if (server.listening) await new Promise(resolve => server.close(resolve)); }
  function listen(port=3000,host='0.0.0.0') {
    return new Promise((resolve,reject)=>{
      const onError=err=>{server.off('listening',onListen);reject(err);};
      const onListen=()=>{server.off('error',onError);resolve(server.address());};
      server.once('error',onError);server.once('listening',onListen);server.listen(port,host);
    });
  }
  return { server, wss, rooms, close, update, listen };
}

if (require.main === module) {
  (async () => {
    const open = process.platform==='win32' && process.argv.includes('--open');
    const port = Number(process.env.PORT || 3000);
    if (!Number.isInteger(port) || port<1 || port>65535) throw Error('Invalid PORT');
    const openBrowser = p => {
      const child=require('node:child_process').spawn('cmd.exe',['/c','start','','http://localhost:'+p],{windowsHide:true,stdio:'ignore'});
      child.on('error',error=>console.error(error.message));child.unref();
    };
    async function existing(p) {
      try {
        const response=await fetch('http://localhost:'+p+'/maps.json',{signal:AbortSignal.timeout(1500)});
        if(!response.ok)return false;
        const maps=await response.json();
        if(maps.length!==releaseIds.length||!maps.every((map,i)=>map.release&&map.id===releaseIds[i]))return false;
        const health=await fetch('http://localhost:'+p+'/health',{signal:AbortSignal.timeout(1500)});
        return health.ok&&(await health.json()).botSupport===1;
      } catch {return false;}
    }
    const candidates=open&&!process.env.PORT?[port,3001,3002,3003,3004,3005]:[port];
    if(open)for(const candidate of candidates)if(await existing(candidate)){openBrowser(candidate);return;}
    console.log('Loading release maps…');
    const releaseWorlds=await Promise.all(releaseIds.map(loadAscentWorld));
    const game=createGameServer({releaseWorlds});
    let address;
    for(const candidate of candidates){
      try{address=await game.listen(candidate);break;}
      catch(error){
        if(error.code!=='EADDRINUSE'||candidate===candidates.at(-1)){await game.close();throw error;}
      }
    }
    console.log(`Tactical PVP: http://localhost:${address.port} - ${releaseWorlds.length} release maps.`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => game.close().then(() => process.exit(0)));
    if (open) openBrowser(address.port);
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { createGameServer, loadAscentWorld, WEAPONS, rayBox, overlapsWorld, movePlayer, MAP };
