// match-menu.ts — 对局内 Esc 菜单：暗遮罩 + 居中面板，以及它的两个子弹窗（设置 / 退出确认）
//
// 规矩（SPEC）：
//   · 菜单只是界面层：不暂停服务器、不操作对战连接。开 / 关、焦点、锁鼠标的意图都在这里，
//     真正的动作（lock / unlock / leave / 设置生效）由 match.ts 通过回调提供。
//   · 只有「继续游戏」和主菜单层的 Esc 请求恢复锁定；点遮罩 / 面板空白 / 游戏 HUD 一律不重锁。
//   · 锁定成功（notifyLocked）才隐藏菜单；浏览器拒绝（notifyLockFailed，或点了继续却迟迟没锁上）
//     时菜单保留并显示重试提示，可以再点。**不会**用 setTimeout 自己重锁。
//   · 子弹窗（设置 / 退出确认）开着时，Esc 与 Tab 都归它；关掉后焦点回到打开它的那颗按钮。
//   · dispose 主动关掉子弹窗（通用 modal 挂在 body 上，不主动关会把它的 keydown 留在文档上）、
//     摘掉自己的 keydown、移出 DOM；重复 open / dispose 都是安全的。
import { h } from './dom.ts';
import { modal, trapTab } from './overlay.ts';
import { openSettings } from './settings.ts';
import { openKillLeaderboard } from './leaderboard.ts';

export interface MatchMenuOpts {
  /** 菜单挂到哪（对局容器），随对局容器一起销毁 */
  root: HTMLElement;
  /** 当前是否处于指针锁定：决定 Esc 是「主动解锁」还是「恢复锁定」 */
  isLocked: () => boolean;
  /** 触摸模式：没有指针锁定，「继续游戏」直接关菜单（由 match.ts 传入） */
  isTouch?: () => boolean;
  /** 请求锁定鼠标（由 match.ts 转给 input.lock()） */
  requestLock: () => void;
  /** 请求解锁鼠标（由 match.ts 转给 input.unlock() 并打开菜单） */
  requestUnlock: () => void;
  /** 确认退出对局：调用既有 onLeave，成功路径只调一次 */
  onLeave: () => void;
  /** 设置项改动后立刻作用到对局上（FOV / 准星颜色） */
  onSettingsChange: () => void;
  /** 菜单显示 / 隐藏时通知外部（中心提示与右上「菜单」按钮的显隐） */
  onVisibilityChange?: (open: boolean) => void;
}

export const MENU_RETRY_TEXT = '浏览器暂时拒绝锁定鼠标，请稍等一秒再点继续游戏';
/** 点了「继续游戏」却迟迟没锁上（某些浏览器是静默失败，不报 pointerlockerror）时的补提示延时；只补提示，不重锁 */
const RETRY_HINT_MS = 400;

export class MatchMenu {
  /** 全屏暗遮罩（点它、点面板空白都只是 stopPropagation：不重锁也不关菜单） */
  readonly el: HTMLElement;
  private readonly o: MatchMenuOpts;
  private readonly panel: HTMLElement;
  private readonly resumeBtn: HTMLButtonElement;
  private readonly settingsBtn: HTMLButtonElement;
  private readonly exitBtn: HTMLButtonElement;
  private readonly retry: HTMLElement;
  /** 当前开着的子弹窗的 close（设置 / 退出确认互斥，不叠层）；null = 没开 */
  private subClose: (() => void) | null = null;
  /** 打开子弹窗时焦点在哪颗按钮上，关掉子弹窗要还回去 */
  private entry: HTMLElement | null = null;
  private retryTimer = 0;
  private open_ = false;
  private disposed = false;

  constructor(o: MatchMenuOpts) {
    this.o = o;
    this.resumeBtn = h('button', { class: 'btn primary block', type: 'button', 'data-testid': 'match-resume', onclick: () => this.resume() }, '继续游戏');
    this.settingsBtn = h('button', { class: 'btn block', type: 'button', 'data-testid': 'match-settings', onclick: () => this.openSettingsModal() }, '设置');
    const leaderboardBtn = h('button', { class: 'btn block', type: 'button', 'data-testid': 'match-leaderboard', onclick: () => this.openLeaderboardModal() }, '击杀排行榜');
    this.exitBtn = h('button', { class: 'btn red block', type: 'button', 'data-testid': 'match-exit', onclick: () => this.openExitConfirm() }, '退出对局');
    this.retry = h('div', { class: 'match-retry', role: 'status', 'data-testid': 'match-retry', hidden: true }, MENU_RETRY_TEXT);
    this.panel = h(
      'div',
      { class: 'match-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'match-menu-title', 'data-testid': 'match-menu' },
      h('div', { class: 'panel-head' }, h('div', { class: 'panel-title', id: 'match-menu-title' }, '对局菜单', h('small', null, '对局仍在进行'))),
      h(
        'div',
        { class: 'match-body' },
        this.retry,
        h('div', { class: 'match-actions' }, this.resumeBtn, leaderboardBtn, this.settingsBtn, this.exitBtn),
        h(
          'div',
          { class: 'match-keys' },
          h('span', null, h('i', { class: 'kbd' }, 'WASD'), '移动'),
          h('span', null, h('i', { class: 'kbd' }, '左键'), '射击'),
          h('span', null, h('i', { class: 'kbd' }, 'R'), '换弹'),
          h('span', null, h('i', { class: 'kbd' }, '1 / 2 / 3'), '换枪'),
        ),
      ),
    );
    // 遮罩吃掉 mousedown：绝不让它冒泡到对局容器上（那里是「点画面开始 / 继续」的抢锁入口）
    this.el = h('div', { class: 'match-overlay', onmousedown: (e: MouseEvent) => e.stopPropagation() }, this.panel);
    o.root.append(this.el);
    // 冒泡阶段监听：子弹窗的 keydown 是 capture 且会 stopPropagation，所以它开着时这里收不到 Esc / Tab
    document.addEventListener('keydown', this.onKey);
  }

  get isOpen() {
    return this.open_;
  }

  /** 打开菜单（重复调用安全）。调用方负责「该不该开」：右上按钮只在未锁定时可点、解锁 / 解锁中才调这里 */
  open() {
    if (this.disposed || this.open_) return;
    this.open_ = true;
    this.clearRetry();
    this.el.classList.add('on');
    this.resumeBtn.focus();
    this.o.onVisibilityChange?.(true);
  }

  /** 关闭菜单并收起子弹窗；焦点交还给画布（blur 掉即可，锁定时浏览器本来就不给 DOM 焦点） */
  close() {
    if (!this.open_) return;
    this.open_ = false;
    this.closeSub();
    this.clearRetry();
    this.el.classList.remove('on');
    const a = document.activeElement as HTMLElement | null;
    if (a && a !== document.body && this.el.contains(a)) a.blur();
    this.o.onVisibilityChange?.(false);
  }

  /** 指针锁定成功：这是唯一隐藏菜单的路径（由 match.ts 的 onLockChange 调） */
  notifyLocked() {
    this.clearRetry();
    this.close();
  }

  /** 浏览器明确拒绝锁定（pointerlockerror / SecurityError）：菜单保留，显示重试提示 */
  notifyLockFailed() {
    if (!this.open_ || this.disposed) return;
    this.clearRetry();
    this.retry.hidden = false;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    document.removeEventListener('keydown', this.onKey);
    this.clearRetry();
    const sub = this.subClose;
    this.subClose = null;
    sub?.(); // 主动关掉子弹窗：它会自己 remove wrap 并摘掉自己挂在 document 上的 keydown
    this.entry = null;
    this.open_ = false;
    this.el.classList.remove('on');
    this.el.remove();
  }

  // ———— 内部 ————

  private onKey = (e: KeyboardEvent) => {
    if (this.disposed) return;
    if (e.key === 'Tab') {
      // 子弹窗开着时 Tab 归它（它的 capture 处理已经拦下了，这里只是兜底）
      if (this.open_ && !this.subClose) trapTab(e, this.panel);
      return;
    }
    if (e.key !== 'Escape' || e.repeat || this.subClose) return;
    if (this.open_) {
      this.resume(); // 主菜单层的 Esc = 继续游戏
      return;
    }
    if (this.o.isLocked()) this.o.requestUnlock(); // 游玩中 Esc：主动解锁，由 match.ts 打开菜单
    else this.open();
  };

  /** 「继续游戏」：请求锁定；成功由 notifyLocked 关菜单，失败则保留菜单并提示，允许重试 */
  private resume() {
    if (this.disposed) return;
    // 触摸模式：没有指针锁定这一步，直接关菜单恢复操作
    if (this.o.isTouch?.()) {
      this.o.requestLock();
      this.close();
      return;
    }
    if (this.o.isLocked()) return;
    this.clearRetry();
    this.o.requestLock();
    if (!this.open_ || this.o.isLocked()) return; // 同步锁上了（或菜单已被关）：不用兜底提示
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = 0;
      if (this.open_ && !this.disposed && !this.o.isLocked()) this.retry.hidden = false;
    }, RETRY_HINT_MS);
  }

  private openSettingsModal() {
    if (this.disposed || this.subClose) return; // 不叠第二个子弹窗
    this.entry = document.activeElement as HTMLElement | null;
    // 五项设置复用大厅那份 openSettings：改动即刻 saveProfile，再回调 onSettingsChange 作用到对局
    this.subClose = openSettings(this.o.onSettingsChange, () => this.afterSubClose());
  }

  private openLeaderboardModal() {
    if (this.disposed || this.subClose) return;
    this.entry = document.activeElement as HTMLElement | null;
    this.subClose = openKillLeaderboard(() => this.afterSubClose());
  }

  private openExitConfirm() {
    if (this.disposed || this.subClose) return;
    this.entry = document.activeElement as HTMLElement | null;
    this.subClose = modal({
      title: '退出对局？',
      sub: '离开当前对局并返回房间。',
      testid: 'match-exit-confirm',
      body: h('div', null, '本局仍在服务器上进行，其他玩家不受影响。', h('br'), '想回到本局：留在房间里点「加入对局」即可（有空位时）。'),
      cancelText: '继续留在对局',
      okText: '退出对局',
      okTestid: 'match-exit-accept',
      onOk: () => this.o.onLeave(),
      onClose: () => this.afterSubClose(),
    });
  }

  private closeSub() {
    const sub = this.subClose;
    this.subClose = null;
    sub?.();
  }

  /** 子弹窗关闭后的收尾：焦点还回打开它的那颗按钮（退出成功时对局已经销毁，就不再抢焦点） */
  private afterSubClose() {
    this.subClose = null;
    const entry = this.entry;
    this.entry = null;
    if (this.disposed || !this.open_) return;
    if (entry?.isConnected) entry.focus();
    else this.resumeBtn.focus();
  }

  private clearRetry() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = 0;
    }
    this.retry.hidden = true;
  }
}