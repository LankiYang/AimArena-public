// sandbox.ts — 开发用「试走」：不连服务器，本地加载地图 + 本地移动模拟（验证渲染 / 碰撞 / 手感）
//   打开 /#sandbox/ascent
import type { MapId } from '../../shared/catalog.ts';
import { isMapId } from '../../shared/catalog.ts';
import { DT, eyeHeight, newMoveState, stepMove, speed2 } from '../../shared/sim/movement.ts';
import { profile } from '../profile.ts';
import { h } from '../ui/dom.ts';
import { loadingView } from '../ui/loading.ts';
import { loadMap } from '../world/load.ts';
import { Engine } from './engine.ts';
import { Input, PITCH_LIMIT, TOUCH_YAW_PER_PX, YAW_PER_COUNT_DEG } from './input.ts';
import { TouchUi } from './touch-ui.ts';
import { getPublicMapData } from '../../shared/public-map.ts';

export async function runSandbox(root: HTMLElement, mapArg: string) {
  const map: MapId = isMapId(mapArg) ? mapArg : 'ascent';
  const lv = loadingView({ mode: 'tdm', map, teamSize: 1, scoreLimit: 0, fillBots: false, botDifficulty: 'normal' }, []);
  root.append(lv.el);
  const wrap = h('div', { class: 'game-root' });
  root.append(wrap);
  const engine = new Engine(wrap);
  engine.setFov(profile.fov);
  const loaded = await loadMap(map, engine.renderer, (p, t) => lv.progress(p, t));
  engine.scene.add(loaded.render.root);
  const sp = getPublicMapData(map).tdm.BL[0];
  const s = newMoveState(sp.x, sp.y, sp.z);
  let yaw = sp.yaw ?? 0, pitch = 0;
  await engine.renderer.compileAsync(engine.scene, engine.camera);
  lv.progress(1, '完成');
  lv.el.remove();

  const input = new Input(engine.canvas);
  const hud = h('div', { class: 'dev-hud' });
  const hint = h('div', { class: 'click-hint' }, '点击画面开始（ESC 释放鼠标）');
  wrap.append(hud, hint);
  wrap.addEventListener('mousedown', (e) => {
    if (!input.touch && e.button === 0) input.lock();
  });
  input.onLockChange = (l) => (hint.style.display = l ? 'none' : '');
  if (input.touch) {
    wrap.classList.add('touch');
    hint.style.display = 'none';
    const touchUi = new TouchUi(wrap, input, { layout: profile.touchLayout });
    void touchUi;
  }

  let acc = 0, last = performance.now(), tick = 0;
  const loop = () => {
    const now = performance.now();
    acc += Math.min(0.25, (now - last) / 1000);
    last = now;
    const m = input.consumeMouse();
    const k = ((input.touch ? TOUCH_YAW_PER_PX : YAW_PER_COUNT_DEG) * profile.sensitivity * Math.PI) / 180;
    yaw -= m.dx * k;
    pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch - m.dy * k));
    const b = input.buttons;
    while (acc >= DT) {
      acc -= DT;
      stepMove(s, { forward: (b.forward ? 1 : 0) - (b.back ? 1 : 0), strafe: (b.right ? 1 : 0) - (b.left ? 1 : 0), jump: b.jump, crouch: b.crouch, walk: b.walk, yaw }, { now: tick * DT, gunM: 0.8, zoomRatio: 1 }, loaded.bvh);
      tick++;
    }
    engine.camera.position.set(s.x, s.y + eyeHeight(s), s.z);
    engine.camera.rotation.set(pitch, yaw, 0);
    loaded.render.update(engine.camera);
    engine.renderer.clear();
    engine.renderer.render(engine.scene, engine.camera);
    hud.textContent = `${map}  pos ${s.x.toFixed(2)} ${s.y.toFixed(2)} ${s.z.toFixed(2)}  yaw ${yaw.toFixed(2)}  speed ${speed2(s).toFixed(2)}  ${s.grounded ? '地面' : '空中'}  calls ${engine.renderer.info.render.calls}`;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  Object.assign(window, { __SANDBOX: { s, engine, loaded, setView: (y: number, p: number) => ((yaw = y), (pitch = p)) } });
}
