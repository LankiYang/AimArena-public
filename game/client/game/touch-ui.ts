// touch-ui.ts — 手机/平板触摸操作层：左下摇杆移动、右半屏拖动转向、右下 3×3 动作区（开火/开镜/换弹/跳跃/蹲/静步）与左上 1主/2副/3刀
//
//   规矩：
//     · 只写 Input 的公开状态（buttons / touchLook / pressKey），不碰网络与战斗规则；
//       服务器仍然只收到和桌面一样的按键、角度、所见 tick、选枪。
//     · 触摸层用 Pointer Events（真机触摸、笔、鼠标在 ?touch=1 下都能用），
//       摇杆与「按住」按钮各捕获自己的 pointerId，多指同时按不会互相打断。
//     · 枪械开镜与桌面一样点按逐档切换；近战的开镜位改成「重击」，按住出重击。
//     · 一次性动作（换弹）按住两帧再松开：服务器靠自己看到的按键边沿受理，必须保证至少一帧采样到。
//     · 死亡 / 打开菜单 / 断线都会走 Input.releaseAll()，通过 onReleaseAll 把摇杆与高亮归位。
//     · 观战（阶段11）：阵亡后显示「◀ 正在观战：X ▶」，左右按钮只调 Input.pressSpectate（与桌面 `[` / `]` 同路径）。
import type { WeaponId } from '../../shared/combat.ts';
import { weaponSlot } from '../../shared/sim/weapons.ts';
import type { Input } from './input.ts';
import type { Buttons } from './input.ts';
import { cloneTouchLayout, defaultTouchLayout, isDefaultTouchLayout, type TouchControlId, type TouchLayout } from '../touch-layout.ts';
import { h } from '../ui/dom.ts';
import { subscribeTouchLayout } from '../touch-layout-cloud.ts';
import '../styles/touch.css';

/** 死区：摇杆偏移小于这个比例不产生移动键 */
const STICK_DEAD = 0.2;
/** 偏移小于这个比例时同时按「静步」，得到更慢的移动 */
const STICK_WALK_BELOW = 0.6;

type HeldButton = keyof Buttons;

export class TouchUi {
  readonly el: HTMLElement;
  private readonly input: Input;
  private readonly lookLayer: HTMLElement;
  private readonly stick: HTMLElement;
  private readonly knob: HTMLElement;
  /** 当前控制摇杆的 pointerId（null = 没在拖） */
  private stickId: number | null = null;
  /** 摇杆中心（按下时锁定，避免拖出底座后中心漂移） */
  private stickCx = 0;
  private stickCy = 0;
  private stickR = 52;
  /** 当前控制视角的 pointerId 与上一个坐标 */
  private lookId: number | null = null;
  private lookX = 0;
  private lookY = 0;
  private readonly pressables: HTMLElement[] = [];
  private readonly weaponButtons: HTMLElement[] = [];
  /** 观战（阶段11）：阵亡后才显示的左右切换条 */
  private readonly spectateBox: HTMLElement;
  private readonly spectateName: HTMLElement;
  private readonly aimButton: HTMLElement;
  private readonly walkButton: HTMLElement;
  private currentWeapon: WeaponId | null = null;
  private disposed = false;
  private manualWalk = false;
  private stickWalk = false;
  private layout: TouchLayout;
  private readonly layoutNodes: Partial<Record<TouchControlId, HTMLElement>> = {};
  private unsubscribeLayout: (() => void) | null = null;
  private readonly releaseButtons: (() => void)[] = [];
  private readonly releaseWeaponButtons: (() => void)[] = [];
  private readonly pulses = new Map<HeldButton, number>();
  private readonly tapFeedback = new Map<HTMLElement, number>();
  private fullscreenButton: HTMLElement | null = null;
  private readonly onViewportChange = () => this.input.releaseAll();
  private readonly onFullscreenChange = () => {
    if (!this.fullscreenButton) return;
    const full = !!document.fullscreenElement;
    this.fullscreenButton.textContent = full ? '还原' : '全屏';
    this.fullscreenButton.setAttribute('aria-pressed', String(full));
  };

  constructor(root: HTMLElement, input: Input, opts: { use?: boolean; layout?: TouchLayout } = {}) {
    this.layout = cloneTouchLayout(opts.layout ?? defaultTouchLayout());
    this.input = input;
    this.lookLayer = h('div', { class: 'touch-look', 'data-testid': 'touch-look' });
    this.knob = h('i', { class: 'touch-knob', 'data-testid': 'touch-stick-knob' });
    this.stick = h('div', { class: 'touch-stick', 'data-testid': 'touch-stick' }, this.knob);

    const weapons = h(
      'div',
      { class: 'touch-weapons' },
      ...([1, 2, 3] as const).map((n) => {
        const el = this.tapButton(`touch-weapon-${n}`, String(n), () => this.input.pressKey(`Digit${n}`), `切换到第 ${n} 槽`);
        this.weaponButtons.push(el);
        return el;
      }),
    );
    this.aimButton = this.holdButton('touch-aim', '开镜', 'aim', '开镜');
    this.walkButton = this.toggleButton('touch-walk', '静步', 'walk');
    const actions = h(
      'div',
      { class: 'touch-actions' },
      this.holdButton('touch-fire', '开火', 'fire', '开火'),
      this.aimButton,
      this.tapButton('touch-reload', '换弹', () => this.pulse('reload'), '换弹'),
      this.holdButton('touch-jump', '跳跃', 'jump', '跳跃'),
      this.toggleButton('touch-crouch', '蹲', 'crouch'),
      this.walkButton,
    );
    // 爆破模式的「使用」= 安放 / 拆除（按住读条）。单独一颗放在摇杆右侧：读条时身体被定住，左拇指就近按住即可。
    const useButton = opts.use ? this.holdButton('touch-use', '使用', 'use', '安放 / 拆除（按住）') : false;
    // 观战切换（阶段11）：只有阵亡时显示（setSpectate），左右两颗按钮调 Input.pressSpectate
    this.spectateName = h('b', { class: 'touch-spectate-name', 'data-testid': 'touch-spectate-name' }, '');
    this.spectateBox = h(
      'div',
      { class: 'touch-spectate', 'data-testid': 'touch-spectate', hidden: true },
      this.tapButton('spectate-prev', '◀', () => this.input.pressSpectate(-1), '上一个观战队友'),
      this.spectateName,
      this.tapButton('spectate-next', '▶', () => this.input.pressSpectate(1), '下一个观战队友'),
    );

    this.el = h(
      'div',
      { class: 'touch-ui', 'data-testid': 'touch-ui' },
      this.lookLayer,
      h('div', { class: 'touch-tip' }, '左侧移动 · 右侧转向 · 开火键可滑动瞄准'),
      h('div', { class: 'touch-rotate' }, '建议横屏游玩'),
      this.stick,
      actions,
      weapons,
      useButton,
      this.spectateBox,
    );
    root.append(this.el);
    this.layoutNodes.stick = this.stick;
    for (const id of ['weapon1', 'weapon2', 'weapon3'] as const) this.layoutNodes[id] = weapons.querySelector(`[data-testid="touch-weapon-${id.slice(-1)}"]`) as HTMLElement;
    for (const id of ['fire', 'aim', 'reload', 'jump', 'crouch', 'walk'] as const) this.layoutNodes[id] = actions.querySelector(`[data-testid="touch-${id}"]`) as HTMLElement;
    if (useButton) this.layoutNodes.use = useButton;
    this.el.classList.add('custom-layout');
    this.applyLayout();
    this.unsubscribeLayout = subscribeTouchLayout((layout) => this.setLayout(layout));

    this.bindStick();
    this.bindLook();
    this.input.onReleaseAll = () => this.reset();
    this.input.onReleaseWeaponActions = () => this.resetWeaponActions();
    // 长按按钮不该弹系统菜单 / 拖拽幽灵图；按钮自己的 pointer 事件已经处理完毕。
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    this.el.addEventListener('dragstart', (e) => e.preventDefault());
    // 全屏是明确操作，不能在摇杆/开火首次按下时改变视口并打断手势。
    if (document.fullscreenEnabled && typeof document.documentElement.requestFullscreen === 'function') {
      this.fullscreenButton = h('button', {
        class: 'btn ghost sm', type: 'button', 'data-testid': 'touch-fullscreen',
        'aria-label': '切换全屏', 'aria-pressed': 'false',
        onclick: async () => {
          this.input.releaseAll();
          try {
            if (document.fullscreenElement) await document.exitFullscreen();
            else await document.documentElement.requestFullscreen();
          } catch { /* iOS / iframe 不支持时仍可正常游玩 */ }
        },
      }, '全屏');
      root.querySelector('.match-menu')?.prepend(this.fullscreenButton);
      document.addEventListener('fullscreenchange', this.onFullscreenChange);
      this.onFullscreenChange();
    }
    window.addEventListener('resize', this.onViewportChange);
    window.addEventListener('orientationchange', this.onViewportChange);
  }

  /** 切枪仅释放旧武器动作，保留仍被按住的摇杆、转向、跳跃和姿态。 */
  private resetWeaponActions(): void {
    if (this.disposed) return;
    for (const release of this.releaseWeaponButtons) release();
    const reload = this.pulses.get('reload');
    if (reload !== undefined) cancelAnimationFrame(reload);
    this.pulses.delete('reload');
  }

  /** 死亡 / 菜单 / 断线：把摇杆与所有高亮归位（按键状态已由 releaseAll 清掉） */
  reset(): void {
    if (this.disposed) return;
    if (this.stickId !== null) {
      const id = this.stickId;
      this.stickId = null;
      this.release(this.stick, id);
    }
    if (this.lookId !== null) {
      const id = this.lookId;
      this.lookId = null;
      this.release(this.lookLayer, id);
    }
    for (const release of this.releaseButtons) release();
    for (const frame of this.pulses.values()) cancelAnimationFrame(frame);
    this.pulses.clear();
    for (const [el, timer] of this.tapFeedback) {
      clearTimeout(timer);
      el.classList.remove('pressed');
    }
    this.tapFeedback.clear();
    this.manualWalk = this.stickWalk = false;
    this.knob.style.transform = '';
    this.stick.classList.remove('on');
    for (const el of this.pressables) {
      el.classList.remove('on');
      el.setAttribute('aria-pressed', 'false');
    }
  }

  /** 当前武器与开镜状态：槽位按钮高亮，近战时把开镜按钮改成「重击」 */
  setState(weapon: WeaponId, aiming: boolean, meleeOnly = false): void {
    if (this.disposed) return;
    this.weaponButtons.forEach((el, i) => {
      const disabled = meleeOnly && i < 2;
      (el as HTMLButtonElement).disabled = disabled;
      el.setAttribute('aria-disabled', String(disabled));
    });
    if (weapon !== this.currentWeapon) {
      this.currentWeapon = weapon;
      const slot = weaponSlot(weapon);
      this.weaponButtons.forEach((el, i) => {
        const selected = i + 1 === slot;
        el.classList.toggle('on', selected);
        el.setAttribute('aria-pressed', String(selected));
      });
      const melee = weapon === 'melee';
      this.aimButton.textContent = melee ? '重击' : '开镜';
      this.aimButton.setAttribute('aria-label', melee ? '近战重击（按住）' : '开镜');
    }
    this.aimButton.classList.toggle('on', weapon !== 'melee' && aiming);
    this.walkButton.classList.toggle('on', this.input.buttons.walk);
  }

  /**
   * 观战（阶段11）：阵亡后显示左右切换按钮 + 「正在观战：X」；复活 / 退出观战就收起。
   * 每帧调一次（文案与显隐都是幂等写入），不持有网络或对局状态。
   */
  setSpectate(active: boolean, label: string): void {
    if (this.disposed) return;
    this.spectateBox.hidden = !active;
    if (this.spectateName.textContent !== label) this.spectateName.textContent = label;
  }

  dispose(): void {
    if (this.disposed) return;
    this.unsubscribeLayout?.();
    this.unsubscribeLayout = null;
    this.input.releaseAll();
    this.disposed = true;
    this.input.onReleaseAll = null;
    this.input.onReleaseWeaponActions = null;
    window.removeEventListener('resize', this.onViewportChange);
    window.removeEventListener('orientationchange', this.onViewportChange);
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    this.fullscreenButton?.remove();
    this.releaseButtons.length = this.releaseWeaponButtons.length = 0;
    this.el.remove();
  }

  setLayout(layout: TouchLayout): void {
    this.layout = cloneTouchLayout(layout);
    this.applyLayout();
  }
  // ———— 按钮工厂 ————

  /** 「按住」按钮：按下置位、松开清位（开火 / 开镜 / 跳跃） */
  private applyLayout(): void {
    const useDefaults = isDefaultTouchLayout(this.layout);
    this.el.classList.toggle('default-layout', useDefaults);
    for (const id of Object.keys(this.layoutNodes) as TouchControlId[]) {
      const el = this.layoutNodes[id];
      if (!el) continue;
      if (useDefaults) {
        el.style.left = el.style.top = el.style.right = el.style.bottom = el.style.transform = '';
        continue;
      }
      const p = this.layout[id];
      el.style.left = `${p.x * 100}%`;
      el.style.top = `${p.y * 100}%`;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      el.style.transform = 'translate(-50%, -50%)';
    }
  }

  private holdButton(testid: string, label: string, name: HeldButton, aria = label): HTMLElement {
    const el = h('button', { class: `tbtn tbtn-${testid.replace('touch-', '')}`, type: 'button', 'data-testid': testid, 'aria-label': aria }, label);
    let pointerId: number | null = null;
    let x = 0, y = 0;
    const down = (e: PointerEvent) => {
      if (this.disposed || pointerId !== null) return;
      e.preventDefault();
      pointerId = e.pointerId;
      x = e.clientX; y = e.clientY;
      this.capture(el, e);
      this.input.buttons[name] = true;
      if (name === 'aim') this.input.pressAim();
      el.classList.add('on');
    };
    const up = (e?: PointerEvent) => {
      if (e && e.pointerId !== pointerId) return;
      const id = pointerId;
      pointerId = null;
      this.input.buttons[name] = false;
      el.classList.remove('on');
      if (id !== null) this.release(el, id);
    };
    el.addEventListener('pointerdown', down);
    // 双拇指：按住开火的同一根手指也能拖动瞄准。
    if (name === 'fire') el.addEventListener('pointermove', (e: PointerEvent) => {
      if (this.disposed || e.pointerId !== pointerId) return;
      e.preventDefault();
      if (x >= window.innerWidth / 2 && e.clientX >= window.innerWidth / 2) this.input.touchLook(e.clientX - x, e.clientY - y);
      x = e.clientX; y = e.clientY;
    });
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
    const release = () => up();
    this.releaseButtons.push(release);
    if (name === 'fire' || name === 'aim') this.releaseWeaponButtons.push(release);
    return el;
  }

  /** 「按一次」按钮：pointerdown 触发一个动作（换弹 / 切枪） */
  private tapButton(testid: string, label: string, action: () => void, title = ''): HTMLElement {
    const el = h('button', { class: `tbtn tbtn-${testid.replace('touch-', '')}`, type: 'button', 'data-testid': testid, title, 'aria-label': title || label }, label);
    el.addEventListener('pointerdown', (e: PointerEvent) => {
      if (this.disposed || el.disabled) return;
      e.preventDefault();
      this.capture(el, e);
      // 按压反馈和当前武器的 .on 分开，不能让 120ms 定时器擦掉槽位高亮。
      const old = this.tapFeedback.get(el);
      if (old !== undefined) clearTimeout(old);
      el.classList.add('pressed');
      this.tapFeedback.set(el, window.setTimeout(() => {
        this.tapFeedback.delete(el);
        el.classList.remove('pressed');
      }, 120));
      action();
    });
    return el;
  }

  /** 「开关」按钮：按一次置位、再按一次清位（蹲 / 静步） */
  private toggleButton(testid: string, label: string, name: HeldButton): HTMLElement {
    const el = h('button', { class: `tbtn tbtn-${testid.replace('touch-', '')}`, type: 'button', 'data-testid': testid, 'aria-label': label, 'aria-pressed': 'false' }, label);
    el.addEventListener('pointerdown', (e: PointerEvent) => {
      if (this.disposed) return;
      e.preventDefault();
      this.capture(el, e);
      const on = name === 'walk' ? !this.manualWalk : !this.input.buttons[name];
      if (name === 'walk') {
        this.manualWalk = on;
        this.input.buttons.walk = on || this.stickWalk;
      } else this.input.buttons[name] = on;
      el.classList.toggle('on', on);
      el.setAttribute('aria-pressed', String(on));
    });
    this.pressables.push(el);
    return el;
  }

  /** 换弹：按住两帧再松开，保证至少一帧的命令里带上 reload（服务器只认自己看到的边沿） */
  private pulse(name: HeldButton): void {
    const old = this.pulses.get(name);
    if (old !== undefined) cancelAnimationFrame(old);
    this.input.buttons[name] = true;
    this.pulses.set(name, requestAnimationFrame(() => {
      this.pulses.set(name, requestAnimationFrame(() => {
        this.pulses.delete(name);
        this.input.buttons[name] = false;
      }));
    }));
  }

  // ———— 摇杆与转向 ————

  private bindStick(): void {
    this.stick.addEventListener('pointerdown', (e: PointerEvent) => {
      if (this.disposed || this.stickId !== null) return;
      e.preventDefault();
      this.capture(this.stick, e);
      this.stickId = e.pointerId;
      const box = this.stick.getBoundingClientRect();
      this.stickCx = box.left + box.width / 2;
      this.stickCy = box.top + box.height / 2;
      this.stickR = Math.max(36, box.width / 2 - 8);
      this.stick.classList.add('on');
      this.moveStick(e.clientX, e.clientY);
    });
    this.stick.addEventListener('pointermove', (e: PointerEvent) => {
      if (this.stickId !== e.pointerId) return;
      e.preventDefault();
      this.moveStick(e.clientX, e.clientY);
    });
    const end = (e: PointerEvent) => {
      if (this.stickId !== e.pointerId) return;
      this.stickId = null;
      this.input.buttons.forward = this.input.buttons.back = this.input.buttons.left = this.input.buttons.right = false;
      this.stickWalk = false;
      this.input.buttons.walk = this.manualWalk;
      this.knob.style.transform = '';
      this.stick.classList.remove('on');
    };
    this.stick.addEventListener('pointerup', end);
    this.stick.addEventListener('pointercancel', end);
    this.stick.addEventListener('lostpointercapture', end);
  }

  /** 摇杆偏移 → 八方向移动键；轻推同时按静步 */
  private moveStick(x: number, y: number): void {
    let dx = x - this.stickCx;
    let dy = y - this.stickCy;
    const len = Math.hypot(dx, dy);
    const max = this.stickR;
    if (len > max) {
      dx = (dx / len) * max;
      dy = (dy / len) * max;
    }
    this.knob.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
    const nx = dx / max;
    const ny = dy / max;
    const mag = Math.hypot(nx, ny);
    const b = this.input.buttons;
    b.forward = b.back = b.left = b.right = false;
    this.stickWalk = mag >= STICK_DEAD && mag < STICK_WALK_BELOW;
    b.walk = this.manualWalk || this.stickWalk;
    if (mag < STICK_DEAD) return;
    // 屏幕坐标：y 向上为负 → 前是 ny < 0；按 45° 分八个方向（左右优先，前后其次）
    const angle = Math.atan2(-ny, nx); // 右 0、上 π/2、左 ±π
    const up = Math.sin(angle) > 0.38;
    const down = Math.sin(angle) < -0.38;
    const right = Math.cos(angle) > 0.38;
    const left = Math.cos(angle) < -0.38;
    if (up) b.forward = true;
    if (down) b.back = true;
    if (right) b.right = true;
    if (left) b.left = true;
    // 轻推自动静步；手动开关不被推到底或松开摇杆覆盖。
  }

  private bindLook(): void {
    this.lookLayer.addEventListener('pointerdown', (e: PointerEvent) => {
      if (this.disposed || this.lookId !== null || e.clientX < window.innerWidth / 2) return;
      e.preventDefault();
      this.capture(this.lookLayer, e);
      this.lookId = e.pointerId;
      this.lookX = e.clientX;
      this.lookY = e.clientY;
    });
    this.lookLayer.addEventListener('pointermove', (e: PointerEvent) => {
      if (this.lookId !== e.pointerId) return;
      e.preventDefault();
      if (this.lookX >= window.innerWidth / 2 && e.clientX >= window.innerWidth / 2) this.input.touchLook(e.clientX - this.lookX, e.clientY - this.lookY);
      this.lookX = e.clientX;
      this.lookY = e.clientY;
    });
    const end = (e: PointerEvent) => {
      if (this.lookId === e.pointerId) this.lookId = null;
    };
    this.lookLayer.addEventListener('pointerup', end);
    this.lookLayer.addEventListener('pointercancel', end);
    this.lookLayer.addEventListener('lostpointercapture', end);
  }

  /** 捕获指针：合成事件（验收脚本）里可能不允许，忽略即可 */
  private capture(el: HTMLElement, e: PointerEvent): void {
    try {
      el.setPointerCapture(e.pointerId);
    } catch {}
  }

  private release(el: HTMLElement, id: number): void {
    try {
      el.releasePointerCapture(id);
    } catch {}
  }
}