const assert = require('node:assert/strict');
const path = require('node:path');
const runtime = process.env.VW_QA_MODULES || path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
const { chromium } = require(path.join(runtime, 'playwright'));
const sharp = require(path.join(runtime, 'sharp'));
const base = process.env.VW_QA_URL || 'http://localhost:3003';
const output = path.resolve(__dirname, '../artifacts');
const mode = process.argv[2] || 'all';

async function play(browser, entry, viewport, quality, { mobile = false, screenshot, walk = false, legacy = false } = {}) {
  const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const parts = new Set(), errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/403 \(Forbidden\)/.test(m.text())) errors.push(m.text()); });
  page.on('response', r => { if (r.ok() && /\/assets\/maps\/[^/]+\/[^/]+\.glb$/.test(r.url())) parts.add(new URL(r.url()).pathname); });
  const room = 'BROWSER-' + entry.id.slice(0, 6) + (mobile ? '-M' : '');
  try {
    const world = await (await fetch(base + '/world.json?map=' + entry.id)).json();
    await page.addInitScript(q => localStorage.setItem('vw-quality', q), quality);
    if (legacy) {
      const previous = 'http://localhost:' + (process.env.VW_QA_LEGACY_PORT || '3002');
      await page.goto(previous + '/?map=' + entry.id + '&room=' + room);
      await page.locator('#mapRecoveryLink').waitFor();
      await page.locator('#joinBtn').click();
      assert.ok(await page.locator('#mapRecoveryLink').isVisible());
      await page.locator('#mapRecoveryLink').click();
      await page.waitForURL(base + '/?map=' + entry.id + '&room=' + room);
    } else {
      await page.goto(base + '/?map=' + entry.id + '&room=' + room, { waitUntil: 'domcontentloaded' });
    }
    await page.waitForFunction(() => document.querySelectorAll('#mapSelect optgroup option').length === 13);
    assert.equal(await page.locator('#mapSelect option').count(), 13);
    assert.equal(await page.locator('a[href="/ascent-preview.html"]').count(), 0);
    assert.equal(await page.locator('#mapSelect').inputValue(), entry.id);
    await page.waitForFunction(url => document.querySelector('#mapCover').src === location.origin + url && document.querySelector('#mapCover').naturalWidth > 0, entry.splash);
    assert.ok((await page.locator('.lobby-scenery').evaluate(el => getComputedStyle(el).backgroundImage)).includes(entry.splash));
    await page.locator('#joinBtn').scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.locator('#joinBtn').click();
    await page.waitForFunction(() => {
      const { connected, graphics } = window.valorantDiagnostics || {};
      return connected && graphics?.triangles > 20000 && graphics.firstPerson && graphics.environment?.texturesReady;
    }, null, { timeout: 90000 });
    assert.deepEqual([...parts].sort(), world.levels.map(p => p.url).sort());
    const stats = await page.evaluate(() => window.valorantDiagnostics.graphics);
    assert.equal(stats.environment.triangles, world.triangleCount);
    assert.deepEqual(stats.environment.textureErrors, []);
    if (walk) {
      await page.locator('#resumeBtn').click();
      await page.waitForFunction(() => !JSON.parse(document.querySelector('#gameCanvas').dataset.controlState).paused);
      const pos = () => page.locator('#gameCanvas').getAttribute('data-world-position').then(s => s.split(',').map(Number));
      const before = await pos();
      await page.keyboard.down('KeyW');
      try {
        await page.waitForFunction(([x,, z]) => {
          const [a,, b] = document.querySelector('#gameCanvas').dataset.worldPosition.split(',').map(Number);
          return Math.hypot(a-x, b-z) > .8;
        }, before, { timeout: 18000 });
      } finally { await page.keyboard.up('KeyW'); }
    } else if (screenshot) await page.locator('#resumeBtn').click();
    if (screenshot) {
      const image = await page.screenshot({ path: path.join(output, screenshot), timeout: 30000 });
      const color = await sharp(image).extract({ left: Math.floor(viewport.width*.18), top: Math.floor(viewport.height*.26), width: Math.floor(viewport.width*.6), height: Math.floor(viewport.height*.40) }).stats();
      assert.ok(color.channels.slice(0, 3).every(c => c.stdev > 10), 'Expected shaded geometry in the viewport');
      const [canvas, radar, timer] = await page.locator('#gameCanvas, #minimap, .round-panel').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().toJSON()));
      assert.ok(canvas.left === 0 && canvas.top === 0 && canvas.width === viewport.width && canvas.height === viewport.height);
      assert.ok(radar.right <= timer.left && timer.right <= canvas.right, 'Radar and timer should fit without overlap');
    }
    assert.deepEqual(errors, [], entry.id);
    console.log(JSON.stringify({ map: entry.id, parts: parts.size, quality, mobile, walk, screenshot }));
  } catch (error) {
    if (errors.length) console.error(entry.id, errors);
    throw error;
  } finally { await context.close(); }
}

(async () => {
  const entries = await (await fetch(base + '/maps.json')).json();
  assert.equal(entries.length, 13);
  assert.ok(entries.every(m => m.release));
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  try {
    const find = id => entries.find(m => m.id === id);
    const lobby = await browser.newPage();
    try {
      for (const retired of ['ascent-study', 'ascent-b']) {
        await lobby.goto(base+'/?room=OLD-MAP&map='+retired);
        await lobby.waitForURL(base+'/?room=OLD-MAP&map=ascent-full');
        await lobby.waitForFunction(() => document.querySelectorAll('#mapSelect option').length === 13);
        assert.equal(await lobby.locator('#mapSelect').inputValue(), 'ascent-full');
        assert.equal(await lobby.locator('#roomCode').inputValue(), 'OLD-MAP');
      }
    } finally { await lobby.close(); }
    if (mode !== 'visual') for (const entry of entries) await play(browser, entry, { width: 540, height: 365 }, 'low');
    if (mode !== 'matrix') {
      await play(browser, find('haven'), { width: 1280, height: 800 }, 'high', { legacy: process.env.VW_QA_LEGACY === '1', screenshot: 'map-pack-haven-high.png' });
      await play(browser, find('ascent-full'), { width: 390, height: 844 }, 'low', { mobile: true, walk: true, screenshot: 'map-pack-ascent-narrow.png' });
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
