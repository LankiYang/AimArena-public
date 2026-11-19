const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const runtime = process.env.VW_QA_MODULES || path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
const { chromium } = require(path.join(runtime, 'playwright'));
const sharp = require(path.join(runtime, 'sharp'));
const base = process.env.VW_QA_URL || 'http://localhost:3005';
const output = path.resolve(__dirname, '../artifacts');
const label = process.argv[2] || 'after';
const width = 720, height = 400, fps = 24;

async function liveRoom(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  try {
    await page.addInitScript(() => localStorage.setItem('vw-quality', 'low'));
    await page.goto(`${base}/?map=ascent-full&bots=normal&room=MOTION-${Date.now().toString(36).toUpperCase()}`);
    await page.waitForFunction(() => document.querySelectorAll('#mapSelect optgroup option').length === 13);
    await page.evaluate(async () => {
      const { ArenaScene } = await import('/src/scene.js');
      const update = ArenaScene.prototype.updatePlayers;
      const report = window.motionQA = { agents: [], moving: [], rounds: 0, weapon: true, sageGrip: 0, sageRoll: 0 };
      const palmById = new Map();
      ArenaScene.prototype.updatePlayers = function (players, ...args) {
        update.call(this, players, ...args);
        if (window.valorantDiagnostics?.phase !== 'live') return;
        const moving = new Set(report.moving), agents = new Set(report.agents);
        for (const player of players.filter(p => p.bot && p.alive)) {
          const avatar = this.players.get(player.id);
          if (!avatar?.motion?.metadata.authoredAnimation) throw new Error('Live player has not loaded the authored gait');
          agents.add(player.agent);
          if (avatar.motion.gait.speed > 1 && avatar.motion.gait.phase > .2) moving.add(player.id);
          report.weapon &&= avatar.weapon?.root.parent === avatar.weapon?.gripBone;
          if (player.agent === 'sage' && avatar.motion.castWeight < .001) {
            const { weapon } = avatar, q = weapon.root.quaternion.clone();
            const rifle = weapon.root.getWorldQuaternion(q);
            const palm = weapon.leftHand.getWorldQuaternion(q.clone());
            const local = rifle.invert().multiply(palm);
            const reference = palmById.get(player.id);
            if (reference) report.sageRoll = Math.max(report.sageRoll, local.angleTo(reference) * 180 / Math.PI);
            else palmById.set(player.id, local);
            report.sageGrip++;
          }
        }
        report.agents = [...agents]; report.moving = [...moving]; report.rounds++;
      };
    });
    await page.locator('#joinBtn').press('Enter');
    await page.waitForFunction(() => window.valorantDiagnostics?.connected && window.valorantDiagnostics.players === 10, null, { timeout: 90000 });
    await page.waitForFunction(() => window.motionQA?.moving.length >= 8 && window.motionQA.agents.length === 2 && window.motionQA.rounds >= 10, null, { timeout: 50000 });
    assert.deepEqual(errors, []);
    const report = await page.evaluate(() => window.motionQA);
    assert.equal(report.weapon, true);
    assert.ok(report.sageGrip >= 10 && report.sageRoll < 1, `Sage's palm rotated relative to the rifle by ${report.sageRoll.toFixed(1)}°`);
    console.log(`PASS: Ascent live 5v5, ${report.moving.length} moving bots, ${report.agents.join(' / ')}, weapon attachment intact`);
  } finally { await page.close(); }
}

async function capture(browser, gripOnly = false, sageWrist = false) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/bot-motion-qa', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><style>body{margin:0}</style><canvas></canvas><script type="importmap">{"imports":{"three":"/node_modules/three/build/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>` }));
  try {
    await page.goto(base + '/bot-motion-qa');
    const result = await page.evaluate(async ({ fps, gripOnly, sageWrist }) => {
      const THREE = await import('three');
      const { ArenaScene } = await import('/src/scene.js');
      const arena = Object.assign(Object.create(ArenaScene.prototype), { scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(38, innerWidth / innerHeight, .05, 100), players: new Map(), assets: {} });
      arena.dynamic = new THREE.Group(); arena.scene.add(arena.dynamic);
      const canvas = document.querySelector('canvas');
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      renderer.setSize(innerWidth, innerHeight);
      renderer.shadowMap.enabled = true;
      arena.scene.background = new THREE.Color('#253c48');
      arena.scene.fog = new THREE.Fog('#253c48', 12, 48);
      arena.scene.add(new THREE.HemisphereLight('#eef7ff', '#8e7f73', 2.2));
      const sun = new THREE.DirectionalLight('#fff4dc', 3);
      sun.position.set(-3, 8, 5); sun.castShadow = true;
      Object.assign(sun.shadow.camera, { left: -18, right: 18, top: 12, bottom: -12, far: 50 });
      sun.shadow.mapSize.set(2048, 2048); sun.shadow.normalBias = .02; arena.scene.add(sun);
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshStandardMaterial({ color: '#455b67' }));
      floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; arena.scene.add(floor);
      const grid = new THREE.GridHelper(100, 100, '#708694', '#5a6d79'); grid.position.y = .004; arena.scene.add(grid);
      await arena.loadAssets();
      const players = ['jett', 'sage'].map((agent, i) => ({ id: agent, name: i ? 'SAGE' : 'JETT', agent, team: 'attack', bot: true, hp: 100, x: 0, y: 0, z: i ? -.7 : .9, yaw: Math.PI / 2, pitch: 0, alive: true, grounded: true }));
      if (sageWrist) {
        const p = players[1];
        const step = i => arena.updatePlayers([p], '', 'attack', 1 / 60, (i - i % 3) / 60 * 1000, i / 60 * 1000);
        step(0);
        const avatar = arena.players.get(p.id), { weapon, root } = avatar;
        const arms = [weapon.leftHand.parent, weapon.leftHand, weapon.rightHand.parent, weapon.rightHand];
        const supportSocket = weapon.leftHand.children.find(n => /^L_WeaponPoint_\d+$/.test(n.name));
        const samples = [], frames = [];
        const position = node => node.getWorldPosition(new THREE.Vector3());
        for (let i = 1; i <= 360; i++) {
          const t = i / 60;
          if (i % 3 === 0) {
            if (t > 1 && t < 2.6) { p.x += .26; p.yaw = Math.PI / 2; }
            else if (t >= 2.6) p.yaw = Math.PI / 2 + Math.sin((t - 2.6) * 3) * .75;
            p.pitch = t < 2.6 ? 0 : Math.sin((t - 2.6) * 3.5) * .65;
          }
          if (i === 211) arena.playerAction(p.id, 'shot');
          if (i === 212) avatar.shotUntil = 0;
          if (i === 278) avatar.castUntil = Infinity;
          if (i === 311) avatar.castUntil = 0;
          step(i);
          const palm = weapon.leftHand.getWorldQuaternion(new THREE.Quaternion());
          const rifle = weapon.root.getWorldQuaternion(new THREE.Quaternion());
          samples.push({ t, angles: arms.map(b => b.quaternion.toArray()),
            palm: rifle.invert().multiply(palm).toArray(), gap: position(supportSocket).distanceTo(position(weapon.anchors.support)) });
          if (i % 5 === 0) {
            const center = root.localToWorld(new THREE.Vector3(0, 1.32, .34));
            arena.camera.position.copy(root.localToWorld(new THREE.Vector3(1.85, 1.65, 1.45)));
            arena.camera.lookAt(center);
            renderer.render(arena.scene, arena.camera);
            frames.push(canvas.toDataURL('image/jpeg', .9).split(',')[1]);
          }
        }
        return { samples, frames };
      }
      if (gripOnly) {
        arena.updatePlayers(players, '', 'attack', 1 / 60, 0, 0);
        const rigs = players.map(p => {
          const avatar = arena.players.get(p.id);
          const { motion, model, weapon } = avatar;
          const chest = motion.bones.Spine4;
          let socket;
          model.traverse(node => { if (node.isBone && /^L_WeaponPoint_\d+$/.test(node.name)) socket = node; });
          const position = node => node.getWorldPosition(new THREE.Vector3());
          const q = node => node.getWorldQuaternion(new THREE.Quaternion());
          const sample = () => {
            const scale = chest.getWorldScale(new THREE.Vector3()), left = position(socket);
            return {
              right: chest.worldToLocal(position(weapon.gripBone)).multiply(scale).toArray(),
              left: chest.worldToLocal(left.clone()).multiply(scale).toArray(),
              gap: left.distanceTo(position(weapon.anchors.support)),
              wrist: q(chest).invert().multiply(q(weapon.leftHand)).toArray()
            };
          };
          return { p, avatar, sample, idle: [], running: [], casting: [] };
        });
        for (let i = 1; i <= 390; i++) {
          const t = i * 1000 / 60;
          for (const r of rigs) {
            if (i > 180 && i <= 300) r.p.x += 5.2 / 60;
            if (i === 301) arena.playerAction(r.p.id, 'shot');
            if (i === 302) r.avatar.shotUntil = 0;
            if (i === 331) r.avatar.castUntil = Infinity;
            if (i === 355) r.avatar.castUntil = 0;
          }
          arena.updatePlayers(players, '', 'attack', 1 / 60, t, t);
          for (const r of rigs) {
            if (i <= 180) r.idle.push(r.sample());
            if (i > 210 && i <= 300) r.running.push(r.sample());
            if (i === 301) r.shot = r.sample();
            if (i >= 331 && i <= 354) r.casting.push(r.sample());
            if (i === 390) r.settled = r.sample();
          }
        }
        return rigs.map(({ p, idle, running, shot, casting, settled }) => ({ agent: p.agent, idle, running, shot, casting, settled }));
      }
      let x = 0, z = 0;
      const frames = [], observations = [];
      // Deterministic 20 Hz game snapshots, rendered at 60 Hz and captured at 24 Hz.
      for (let i = 0, next = 0; i < 360; i++) {
        const t = i / 60;
        if (i % 3 === 0) {
          const v = t < .55 || t >= 5.05 ? 0 : t < 2.15 ? 2.55 : 5.2;
          const corner = t >= 3.55;
          x += (corner ? 0 : v) * .05; z += (corner ? -v : 0) * .05;
          for (let j = 0; j < players.length; j++) Object.assign(players[j], { x: x - j * 1.2, z: z + (j ? -.7 : .9), yaw: corner ? 0 : Math.PI / 2 });
        }
        arena.updatePlayers(players, '', 'attack', 1 / 60, (i - i % 3) / 60 * 1000, t * 1000);
        const player = arena.players.get('jett');
        assertFinite(player.root.position.toArray());
        if (i < next - .0001) continue;
        next += 60 / fps;
        const offset = t < 3.75 ? [-1.4, 1.55, 4.6] : [4, 1.55, 3.5];
        arena.camera.position.set(player.root.position.x + offset[0], offset[1], player.root.position.z + offset[2]);
        arena.camera.lookAt(player.root.position.x - .55, .98, player.root.position.z - .6);
        renderer.render(arena.scene, arena.camera);
        frames.push(canvas.toDataURL('image/jpeg', .88).split(',')[1]);
        observations.push({ root: player.root.position.toArray(), yaw: player.root.rotation.y, source: player.motion.metadata.kind, phase: player.motion.gait.phase, feet: player.motion.legs.map((leg, i) => ({ ankle: leg.foot.getWorldPosition(new THREE.Vector3()).toArray(), toe: leg.toe.getWorldPosition(new THREE.Vector3()).toArray(), plant: player.motion.locomotion?.feet[i].weight })) });
      }
      function assertFinite(values) { if (!values.every(Number.isFinite)) throw new Error('non-finite character transform'); }
      return { frames, observations };
    }, { fps, gripOnly, sageWrist });
    assert.deepEqual(errors, []);
    if (sageWrist) {
      const deg = (a, b) => Math.acos(Math.min(1, Math.abs(a.reduce((sum, x, j) => sum + x * b[j], 0)))) * 360 / Math.PI;
      const segments = [[0, 2.6], [2.6, 4.5], [4.5, 5.4], [5.4, 6.1]];
      for (const [a, b] of segments) {
        const subset = result.samples.filter(s => s.t >= a && s.t < b);
        const maxStep = Array.from({ length: 5 }, (_, j) => Math.max(...subset.slice(1).map((s, i) => deg(j === 4 ? s.palm : s.angles[j], j === 4 ? subset[i].palm : subset[i].angles[j]))));
        const spread = Math.max(...subset.map(s => deg(s.palm, subset[0].palm)));
        console.log(`${a}-${b}s elbow/wrist jump ${maxStep.map(n => n.toFixed(1)).join(' / ')} deg; palm vs rifle rotation ${spread.toFixed(1)} deg; grip gap ${Math.max(...subset.map(s => s.gap)).toFixed(3)} m`);
        if (label.endsWith('before')) continue;
        assert.ok(Math.max(...maxStep) < 18, 'Sage wrist or elbow snapped between frames');
        if (a !== 4.5) {
          assert.ok(spread < 1, 'Sage palm rotated relative to the rifle');
          assert.ok(subset.every(s => s.gap < .012), 'Sage support hand came away from the rifle');
        } else assert.ok(subset.some(s => s.gap > .12), 'Sage did not release the grip during casting');
      }
      const raws = await Promise.all(result.frames.map(frame => sharp(Buffer.from(frame, 'base64')).removeAlpha().raw().toBuffer()));
      await sharp(Buffer.concat(raws), { raw: { width, height: height * raws.length, pageHeight: height, channels: 3 } })
        .gif({ delay: 83, loop: 0, effort: 3 }).toFile(path.join(output, `bot-motion-${label}.gif`));
      const last = path.join(output, `bot-motion-${label}.jpg`);
      fs.writeFileSync(last, Buffer.from(result.frames[49], 'base64'));
      return;
    }
    if (gripOnly) {
      const distance = (a, b) => Math.hypot(...a.map((x, i) => x - b[i]));
      for (const { agent, idle, running, shot, casting, settled } of result) {
        const rest = idle[0];
        const ranges = ['right', 'left'].map(hand => Math.max(...idle.map(p => distance(p[hand], rest[hand]))));
        const idleGap = Math.max(...idle.map(p => p.gap)), runGap = Math.max(...running.map(p => p.gap));
        const wristDegrees = Math.max(...idle.map(({ wrist }) => {
          const dot = wrist.reduce((sum, value, j) => sum + value * rest.wrist[j], 0);
          return Math.acos(Math.min(1, Math.abs(dot))) * 360 / Math.PI;
        }));
        console.log(`${agent}: idle hand travel ${ranges.map(x => x.toFixed(4)).join(' / ')} m; max support gap idle/run ${idleGap.toFixed(4)} / ${runGap.toFixed(4)} m`);
        assert.ok(ranges.every(value => value < .005) && wristDegrees < 1, `${agent}: hands sway while standing still`);
        assert.ok(idleGap < .009 && runGap < .023, `${agent}: support hand leaves the rifle`);
        assert.ok(distance(shot.right, rest.right) > .005, `${agent}: recoil no longer moves the right hand`);
        assert.ok(casting.some(p => p.gap > .05), `${agent}: ability did not release the support hand`);
        assert.ok(settled.gap < .009 && distance(settled.left, rest.left) < .009, `${agent}: support hand did not settle after the ability`);
      }
      return;
    }
    assert.equal(result.frames.length, fps * 6);
    assert.ok(result.observations.every(p => p.source === 'retargeted-tps-locomotion'));
    let planted = 0;
    for (let i = 15; i < 118; i++) {
      const a = result.observations[i - 1], b = result.observations[i];
      assert.ok(Math.abs(a.yaw - b.yaw) < .55, 'one captured frame turned too far');
      for (let j = 0; j < 2; j++) {
        const old = a.feet[j], foot = b.feet[j];
        assert.ok(foot.toe[1] > -.025, 'foot penetrated level floor');
        if (old.plant > .92 && foot.plant > .92) {
          const slide = Math.hypot(foot.toe[0] - old.toe[0], foot.toe[2] - old.toe[2]);
          if (slide < .03) planted++;
        }
      }
    }
    assert.ok(planted >= 14, 'no clearly planted steps during travel');
    const raws = await Promise.all(result.frames.map(frame => sharp(Buffer.from(frame, 'base64')).removeAlpha().raw().toBuffer()));
    await sharp(Buffer.concat(raws), { raw: { width, height: height * raws.length, pageHeight: height, channels: 3 } })
      .gif({ delay: Math.round(1000 / fps), loop: 0, effort: 3 }).toFile(path.join(output, `bot-motion-${label}.gif`));
    for (const [name, index] of [['walk', 30], ['run', 66], ['turn', 98], ['idle', 139]]) {
      fs.writeFileSync(path.join(output, `bot-motion-${label}-${name}.jpg`), Buffer.from(result.frames[index], 'base64'));
    }
    fs.writeFileSync(path.join(output, `bot-motion-${label}.json`), JSON.stringify(result.observations));
  } finally { await page.close(); }
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  try {
    if (label === 'live') await liveRoom(browser);
    else if (label === 'grip') await capture(browser, true);
    else if (label.startsWith('sage-wrist')) await capture(browser, false, true);
    else { await capture(browser); console.log('PASS: recorded 6 seconds of Jett/Sage walk, run, turn and stop'); }
  }
  finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
