// input.ts — 键鼠 / 触摸输入：指针锁定、按键状态、鼠标位移累积（战术射击标准灵敏度：0.07°/计数 × sens）
//   触摸模式（手机/平板）：没有指针锁定，locked 恒为 true；视角来自触摸拖拽，按键来自 touch-ui.ts，
//   键盘在混合设备上照常可用。
import { profile } from '../profile.ts';
export const YAW_PER_COUNT_DEG = 0.07;
/** 触摸拖拽的转角系数（度/像素，sens=1 时）；触摸拖拽比鼠标点数粗得多，需要更大的系数 */
export const TOUCH_YAW_PER_PX = 0.5;
export const PITCH_LIMIT = 1.18; // 站点 DZ8hUCe3.js m0

export interface TouchEnv {
  queryTouch: string | null;
  ua: string;
  maxTouchPoints: number;
  /** Chromium 的 navigator.userAgentData.mobile */
  uaMobile: boolean;
  /** 物理屏幕尺寸（不是窗口尺寸，避免桌面小窗口被当成手机） */
  screenW: number;
  screenH: number;
  coarse: boolean;
  anyCoarse: boolean;
  anyFine: boolean;
  hoverNone: boolean;
}

/** 纯判定：?touch 强制 > App/B站 WebView > 手机 UA > 小屏触屏设备；大屏默认键鼠 */
export function isTouchDevice(env: TouchEnv): boolean {
  const q = env.queryTouch;
  if (q === '1' || q === 'true') return true;
  if (q === '0' || q === 'false') return false;

  const ua = env.ua;
  const touchPoints = env.maxTouchPoints;
  const mobileUA = env.uaMobile || /Android|iPhone|iPad|iPod|Mobile|HarmonyOS|Windows Phone/i.test(ua);
  // App 壳 / B站 App 内置浏览器：UA 带 AimArenaApp / BiliApp / wv，pointer 经常报 fine
  if (/AimArenaApp/i.test(ua)) return true;
  if (touchPoints > 0 && /BiliApp|bilibili|wv\b/i.test(ua) && mobileUA) return true;
  if (touchPoints > 0 && mobileUA) return true;
  // iPadOS 13+ 的桌面 UA 伪装成 Macintosh
  if (touchPoints > 1 && /Macintosh/i.test(ua)) return true;

  // 没有手机 UA 时，只有「小屏 + 没有精确指针」才按触屏；触屏笔记本 / 桌面触屏默认键鼠
  const smallScreen = env.screenW > 0 && env.screenW <= 900;
  if (touchPoints > 0 && env.anyCoarse && !env.anyFine && smallScreen) return true;
  return smallScreen && env.coarse && env.hoverNone;
}

/** 触摸模式：?touch=1/0 强制 > 设置里的手动模式 > 自动识别（App / B站 WebView / 尺寸 / UA） */
export function detectTouch(): boolean {
  const q = new URLSearchParams(location.search).get('touch');
  if (q === '1' || q === 'true') return true;
  if (q === '0' || q === 'false') return false;
  if (profile.controlMode === 'touch') return true;
  if (profile.controlMode === 'mouse') return false;
  return isTouchDevice({
    queryTouch: null,
    ua: navigator.userAgent || '',
    maxTouchPoints: navigator.maxTouchPoints || 0,
    uaMobile: (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile === true,
    screenW: screen.width || innerWidth || 0,
    screenH: screen.height || innerHeight || 0,
    coarse: matchMedia('(pointer: coarse)').matches,
    anyCoarse: matchMedia('(any-pointer: coarse)').matches,
    anyFine: matchMedia('(any-pointer: fine)').matches,
    hoverNone: matchMedia('(hover: none)').matches,
  });
}

export interface Buttons {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  crouch: boolean;
  walk: boolean;
  fire: boolean;
  aim: boolean;
  reload: boolean;
  use: boolean;
}

const KEYMAP: Record<string, keyof Buttons> = {
  KeyW: 'forward',
  KeyS: 'back',
  KeyA: 'left',
  KeyD: 'right',
  Space: 'jump',
  ControlLeft: 'crouch',
  KeyC: 'crouch',
  ShiftLeft: 'walk',
  KeyR: 'reload',
  KeyE: 'use',
};

export class Input {
  buttons: Buttons = { forward: false, back: false, left: false, right: false, jump: false, crouch: false, walk: false, fire: false, aim: false, reload: false, use: false };
  /** 自上次 consumeMouse() 以来累积的鼠标位移（计数） */
  private mdx = 0;
  private mdy = 0;
  /** 自上次 consumeAimPresses() 以来的桌面右键按下次数；开镜默认按原站切换模式处理。 */
  private aimPresses = 0;
  /** 诊断：自上次 consumeMouse 以来收到的 mousemove 事件数 */
  private _mouseEvents = 0;
  /** 诊断：自上次 consumeMouse 以来单次最大 |movementX| */
  private _mouseMaxDx = 0;
  locked = false;
  /** 触摸模式：无指针锁定、鼠标事件不参与，视角由触摸拖拽累积 */
  readonly touch = detectTouch();
  /** releaseAll() 的附加回调：触摸层用它把摇杆与按钮视觉归位 */
  onReleaseAll: (() => void) | null = null;
  /** 切枪只松开攻击/开镜/换弹；触摸层仅取消对应按钮，不打断摇杆和转向。 */
  onReleaseWeaponActions: (() => void) | null = null;
  /** 一次性按键（数字键换枪、B 买枪、Tab 等）由 onKey 回调处理 */
  onKey: ((code: string, down: boolean) => void) | null = null;
  /** 观战切换目标（阶段11）：桌面 `[` / `]` 与触摸层的左右按钮共用这一条路径（dir = +1 / -1） */
  onSpectateKey: ((dir: 1 | -1) => void) | null = null;
  onLockChange: ((locked: boolean) => void) | null = null;
  onLockError: ((e: unknown) => void) | null = null;
  /** 锁定时顺带进全屏 */
  fullscreen = true;
  private el: HTMLElement;
  private handlers: [EventTarget, string, EventListener][] = [];

  constructor(el: HTMLElement) {
    this.el = el;
    const on = (t: EventTarget, ev: string, fn: (e: never) => void) => {
      t.addEventListener(ev, fn as EventListener);
      this.handlers.push([t, ev, fn as EventListener]);
    };
    on(document, 'keydown', (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (this.locked && (e.code === 'Tab' || e.code === 'Space' || e.ctrlKey)) e.preventDefault();
      // 长按的系统重复键（repeat）不派发给 onKey：切枪这类「按一次算一次」的操作不能连发。
      // 按键状态本身在第一次 keydown 就置位了，丢掉重复事件不影响移动 / 射击。
      if (e.repeat) return;
      // 观战切换目标（阶段11）：`[` / `]`。不要求指针锁定，也不在 KEYMAP 里——阵亡后菜单可能开着，
      // 切队友仍然安全（对局层还会再判一次「已阵亡 + 不在弹窗里」）。
      if (e.code === 'BracketLeft' || e.code === 'BracketRight') this.onSpectateKey?.(e.code === 'BracketRight' ? 1 : -1);
      const b = KEYMAP[e.code];
      // 未锁定（菜单 / 弹窗 / 尚未点画面）时 keydown 不置位：焦点落在按钮或滑块上按 WASD 不该有移动状态，
      // 菜单里按 R 也不该触发换弹。清状态只走 keyup（keyup 永远受理），回来一按就恢复。
      // Esc 不在这张表里，所以未锁定时也照样派发给 onKey（菜单要靠它开合）。
      if (b && this.locked) this.buttons[b] = true;
      this.onKey?.(e.code, true);
    });
    on(document, 'keyup', (e: KeyboardEvent) => {
      const b = KEYMAP[e.code];
      if (b) this.buttons[b] = false;
      this.onKey?.(e.code, false);
    });
    // 窗口失焦：既松开全部按键，也主动解锁——与菜单逻辑一致：回到页面要自己点「继续游戏」才恢复鼠标
    on(window, 'blur', () => {
      this.releaseAll();
      this.unlock();
    });
    // 手机切后台不一定触发 blur；不得把最后一次开火/移动带回前台。
    on(document, 'visibilitychange', () => {
      if (document.hidden) this.releaseAll();
    });
    on(document, 'mousemove', (e: MouseEvent) => {
      if (this.touch || !this.locked) return; // 触摸模式：鼠标不参与转向（触屏笔电也不让鼠标乱转）
      this.mdx += e.movementX;
      this.mdy += e.movementY;
      this._mouseEvents++;
      const abs = Math.abs(e.movementX);
      if (abs > this._mouseMaxDx) this._mouseMaxDx = abs;
    });
    on(document, 'mousedown', (e: MouseEvent) => {
      if (this.touch || !this.locked) return; // 触摸的兼容鼠标事件不能当成开火
      if (e.button === 0) this.buttons.fire = true;
      if (e.button === 2) {
        this.buttons.aim = true;
        this.aimPresses++;
      }
    });
    on(document, 'mouseup', (e: MouseEvent) => {
      if (this.touch) return;
      if (e.button === 0) this.buttons.fire = false;
      if (e.button === 2) this.buttons.aim = false;
    });
    on(document, 'contextmenu', (e: MouseEvent) => this.locked && e.preventDefault());
    on(document, 'pointerlockerror', () => this.onLockError?.(new Error('pointerlockerror')));
    on(document, 'pointerlockchange', () => {
      if (this.touch) return; // 触摸模式没有指针锁定：真实锁定事件不应改写 locked
      this.locked = document.pointerLockElement === this.el;
      if (!this.locked) this.releaseAll();
      this.onLockChange?.(this.locked);
    });
    if (this.touch) this.locked = true; // 触摸模式：没有「点画面锁定」这一步，直接可操作
  }

  /** 请求锁定鼠标（必须在点击等用户手势里调用）。先锁鼠标再尝试全屏：
   *  requestFullscreen 可能吃掉这次用户激活，导致指针锁定失败——切后台回来时最明显。
   *  Chrome 在 Esc 解锁后约 1 秒内拒绝再次锁定，失败时 onLockError 通知界面，下一次点击再试。 */
  lock() {
    if (this.touch || this.locked) return; // 触摸模式不需要（也不能）锁定鼠标
    try {
      const r = this.el.requestPointerLock?.() as unknown as Promise<void> | undefined;
      r?.catch?.((e: unknown) => this.onLockError?.(e));
    } catch (e) {
      this.onLockError?.(e);
    }
    try {
      if (this.fullscreen && !document.fullscreenElement)
        void document.documentElement.requestFullscreen?.().catch(() => {});
    } catch {}
  }

  unlock() {
    if (this.touch) return; // 触摸模式没有指针锁定可退
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** 切枪不能伪造移动键的 keyup；保留移动、姿态、跳跃与累积视角。 */
  releaseWeaponActions() {
    this.buttons.fire = this.buttons.aim = this.buttons.reload = false;
    this.aimPresses = 0;
    this.onReleaseWeaponActions?.();
  }

  releaseAll() {
    for (const k of Object.keys(this.buttons) as (keyof Buttons)[]) this.buttons[k] = false;
    // 累积的鼠标位移一起清掉：解锁瞬间的那点抖动不该在恢复锁定后的第一帧甩出去
    this.mdx = this.mdy = 0;
    this._mouseEvents = this._mouseMaxDx = 0;
    this.aimPresses = 0;
    this.onReleaseAll?.();
  }

  /** 触摸开镜按钮的按下边沿：与桌面右键共用同一套逐档切换 */
  pressAim() {
    this.aimPresses++;
  }

  /** 触摸层注入的视角位移（像素），与鼠标位移共用同一累积器 */
  touchLook(dx: number, dy: number) {
    this.mdx += dx;
    this.mdy += dy;
  }

  /** 触摸层的观战左右按钮：与桌面 `[` / `]` 完全同一条路径（触摸层不碰网络与对局规则） */
  pressSpectate(dir: 1 | -1) {
    this.onSpectateKey?.(dir);
  }

  /** 触摸按钮模拟一次按键（换枪 / 检视这类「按一次算一次」的操作） */
  pressKey(code: string) {
    this.onKey?.(code, true);
  }

  consumeMouse() {
    const r = { dx: this.mdx, dy: this.mdy, events: this._mouseEvents, maxDx: this._mouseMaxDx };
    this.mdx = this.mdy = 0;
    this._mouseEvents = 0;
    this._mouseMaxDx = 0;
    return r;
  }

  consumeAimPresses() {
    const presses = this.aimPresses;
    this.aimPresses = 0;
    return presses;
  }

  dispose() {
    // 先摘掉自己的监听再解锁：否则 exitPointerLock 触发的 pointerlockchange 会回调 onLockChange，
    // 在对局已经销毁的时候又把菜单建出来。
    for (const [t, ev, fn] of this.handlers) t.removeEventListener(ev, fn);
    this.handlers.length = 0;
    this.onKey = null;
    this.onSpectateKey = null;
    this.onLockChange = null;
    this.onLockError = null;
    this.releaseAll();
    this.unlock();
  }
}
