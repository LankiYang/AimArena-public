// combat-hud.ts — 战斗 HUD：生命 / 弹药 / 换弹 / 复活 / 击杀信息 / 命中提示
//
// 规矩（SPEC）：
//   · 所有状态数字都来自服务端的 CombatSelf，前端不自己改弹药、不本地判伤；
//     剩余时间 = (until - tick) / 32（服务器 32Hz）。
//   · 命中 X 只在 shot.rays 中有真实伤害、shooter === 本地 id 时出现一次（友军/保护目标不算），任一伤害射线爆头即金色；
//     红色受击边只在任一伤害射线命中本地 id 时闪一次。
//   · 击杀信息最多 4 条、5 秒消失；名字取自服务器给的名字表，查不到就写「玩家」，不暴露数字 id。
//   · setMenu(true) 才让武器按钮可点；1 主武器、2 副武器、3 刀，分类独立保留。
//   · 观战（阶段11）：自己阵亡后显示「正在观战：<队友名>」+ 该队友的血量 / 弹药，右上角队友列表高亮当前观战目标；
//     目标缺失（没有存活队友）时写「队友全部阵亡 · 自由视角」。数据全来自服务器（CombatUpdate.squad 只含队友）。
//
// 合同类型统一来自 game/shared/combat.ts（不再本地重声明）；tick 频率取自 shared/sim/tick.ts
import type { CombatEvent, CombatSelf, WeaponId } from '../../shared/combat.ts';
import { ARMOR, type ArmorKind } from '../../shared/economy.ts';
import { SPECTATE_FREE_LOOK, SPECTATE_KEYS_DESKTOP, SPECTATE_KEYS_TOUCH, spectateLabel } from '../../shared/spectate.ts';
import { TDM } from '../../shared/tdm.ts';
import { DEFAULT_SIDEARM, DEFAULT_WEAPON, WEAPONS, weaponSlot } from '../../shared/sim/weapons.ts';
import { TICK_RATE } from '../../shared/sim/tick.ts';
import { h } from './dom.ts';
import { weaponIcon } from './art.ts';

const TICK = TICK_RATE; // 服务器 32Hz：tick → 秒
const MAX_HP = 100; // SPEC：满血 100HP，血条按它算比例
const FEED_MAX = 4; // 击杀信息最多 4 条
const FEED_MS = 5000; // 5 秒后消失
const MARKER_MS = 130; // 命中 X 的停留时间
const HURT_MS = 260; // 受击红边的停留时间
const KILL_BADGE_MS = 720; // 击杀图标停留时间

const weaponName = (id: WeaponId) => WEAPONS[id].name;
const DEFAULT_NAME = '玩家'; // 名字表里查不到时的替代，绝不显示数字 id

/** 护甲档位中文名（HUD 盾牌旁的小字） */
const armorKindName = (kind: ArmorKind | null): string => (kind ? ARMOR[kind].name : '');

interface FeedRow {
  el: HTMLElement;
  timer: number;
}

/** 观战面板的数据（阶段11）：全部来自服务器，客户端不自己算血量 / 弹药 */
export interface SpectateHudView {
  /** 观战目标；null = 没有存活队友（回落死亡点自由转头） */
  target: { id: number; name: string; hp: number; mag: number; reserve: number; weapon: WeaponId } | null;
  /** 本队队友（顺序 = 服务器玩家表顺序，与 `[ / ]` 循环切换一致）；包含观战目标本人 */
  mates: { id: number; name: string; hp: number; alive: boolean }[];
  /** true = 没有可跟随的队友 */
  freeLook: boolean;
  touch: boolean;
}

export class CombatHud {
  readonly el: HTMLElement;

  private readonly select: (weapon: WeaponId) => void;
  private readonly touch: boolean;
  private readonly hpValue: HTMLElement;
  private readonly hpBar: HTMLElement;
  private readonly armorRow: HTMLElement;
  private readonly armorValue: HTMLElement;
  private readonly armorKindText: HTMLElement;
  private readonly armorBar: HTMLElement;
  private readonly ammoValue: HTMLElement;
  private readonly ammoReserve: HTMLElement;
  private readonly weaponName: HTMLElement;
  private readonly reloadState: HTMLElement;
  private readonly reloadBar: HTMLElement;
  private readonly equipmentState: HTMLElement;
  private readonly respawnState: HTMLElement;
  private readonly protectChip: HTMLElement;
  private readonly hitMarker: HTMLElement;
  private readonly hurt: HTMLElement;
  private readonly feed: HTMLElement;
  private readonly buttons: { id: WeaponId; el: HTMLButtonElement }[] = [];
  private readonly timers = new Set<number>();
  private readonly killBadge: HTMLElement;
  private readonly killBadgeIcon: HTMLImageElement;
  private killBadgeTimer = 0;
  private readonly feedRows: FeedRow[] = [];
  /** 观战面板（阶段11） */
  private readonly banner: HTMLElement;
  private readonly bannerDefault: string;
  private readonly spectateEl: HTMLElement;
  private readonly spectateTitle: HTMLElement;
  private readonly spectateHp: HTMLElement;
  private readonly spectateHpBar: HTMLElement;
  private readonly spectateAmmo: HTMLElement;
  private readonly spectateWeapon: HTMLElement;
  private readonly spectateHint: HTMLElement;
  private readonly spectateList: HTMLElement;
  private readonly spectateRows = new Map<number, { el: HTMLElement; name: HTMLElement; hp: HTMLElement }>();
  /** 队友列表的结构签名（身份 / 顺序 / 存活）：变了才重建行，其余只改文字 */
  private spectateSig = '';

  private unlocked = false;
  private infectedOnly = false;
  private disposed = false;
  private weapon: WeaponId = DEFAULT_WEAPON;
  /** 换弹起始 tick，用来把进度条按时间算出来（只依赖 CombatSelf，不写死换弹时长） */
  private reloadFromTick = 0;
  private reloadTotalTicks = 0;
  private lastReloadUntil = -1;

  constructor(root: HTMLElement, select: (weapon: WeaponId) => void, opts: { touch?: boolean; bomb?: boolean; infection?: boolean } = {}) {
    this.select = select;
    this.touch = opts.touch === true;

    this.hpValue = h('span', { class: 'hud-num', 'data-testid': 'hp-value' }, String(MAX_HP));
    this.hpBar = h('i', null);
    // 护甲（SND 经济）：盾牌 + 数值 + 档位名 + 「回复中」状态；TDM 没有护甲，整行隐藏
    this.armorValue = h('b', { class: 'hud-armor-num', 'data-testid': 'armor-value' }, '0');
    this.armorKindText = h('span', { class: 'hud-armor-kind', 'data-testid': 'armor-kind' }, '');
    this.armorBar = h('i', null);
    this.armorRow = h('div', { class: 'hud-armor', 'data-testid': 'armor-row', hidden: true },
      h('span', { class: 'hud-armor-shield', 'aria-hidden': 'true' }),
      this.armorValue, this.armorKindText,
      h('div', { class: 'hud-armorbar' }, this.armorBar),
    );
    this.ammoValue = h('span', { class: 'hud-mag', 'data-testid': 'ammo-value' }, '0');
    this.ammoReserve = h('span', { class: 'hud-reserve' }, '/ 0');
    this.weaponName = h('div', { class: 'hud-wname', 'data-testid': 'weapon-name' }, WEAPONS.vandal.name);
    this.reloadState = h('div', { class: 'hud-reload', 'data-testid': 'reload-state' });
    this.reloadBar = h('i', null);
    this.equipmentState = h('div', { class: 'hud-reload', 'data-testid': 'equipment-status', 'aria-live': 'polite', hidden: true });
    this.respawnState = h('div', { class: 'hud-respawn', 'data-testid': 'respawn-state' });
    this.protectChip = h('div', { class: 'hud-protect' }, '保护中');
    this.hitMarker = h('div', { class: 'hud-hit', 'data-testid': 'hit-marker' }, h('span', null), h('span', null));
    this.killBadgeIcon = h('img', { class: 'hud-kill-icon', alt: '', draggable: false });
    this.killBadge = h('div', { class: 'hud-kill', 'data-testid': 'kill-marker', 'aria-live': 'polite' },
      this.killBadgeIcon, h('span', { class: 'hud-kill-text' }, '击杀'));
    this.hurt = h('div', { class: 'hud-hurt' });
    this.feed = h('div', { class: 'hud-feed', 'data-testid': 'kill-feed' });
    // 中上说明文案：默认是模式的复活说明，观战时临时改成「观战 · …」，收起时恢复
    this.bannerDefault = opts.infection ? '经典生化 · 人类感染后加入感染者' : opts.bomb ? '爆破 · 阵亡后等待下一回合' : `团队死斗 · ${TDM.respawnSec}秒复活`;
    this.banner = h('div', { class: 'hud-banner' }, this.bannerDefault);

    // —— 观战面板（阶段11，右上角：目标名 / 血量 / 弹药 + 高亮当前目标的队友列表）——
    this.spectateTitle = h('div', { class: 'hud-spectate-title', 'data-testid': 'spectate-title' }, '');
    this.spectateHp = h('b', { class: 'hud-spectate-hp', 'data-testid': 'spectate-hp' }, '0');
    this.spectateHpBar = h('i', null);
    this.spectateAmmo = h('span', { class: 'hud-spectate-ammo', 'data-testid': 'spectate-ammo' }, '—');
    this.spectateWeapon = h('span', { class: 'hud-spectate-weapon', 'data-testid': 'spectate-weapon' }, '');
    this.spectateHint = h('div', { class: 'hud-spectate-hint', 'data-testid': 'spectate-hint' }, SPECTATE_KEYS_DESKTOP);
    this.spectateList = h('ul', { class: 'hud-spectate-list', 'data-testid': 'spectate-list' });
    this.spectateEl = h(
      'section',
      { class: 'hud-spectate', 'data-testid': 'spectate-panel', hidden: true },
      this.spectateTitle,
      h('div', { class: 'hud-spectate-stats' },
        h('span', { class: 'hud-spectate-hplabel' }, 'HP'), this.spectateHp,
        h('div', { class: 'hud-spectate-hpbar' }, this.spectateHpBar),
        this.spectateAmmo, this.spectateWeapon),
      this.spectateList,
      this.spectateHint,
    );

    const menu = h(
      'div',
      { class: 'hud-menu' },
      ...([{ id: DEFAULT_WEAPON, key: 1, testid: 'weapon-primary' }, { id: DEFAULT_SIDEARM, key: 2, testid: 'weapon-secondary' }, { id: 'melee', key: 3, testid: 'weapon-melee' }] as const).map(({ id, key, testid }) => {
        const el = h(
          'button',
          {
            class: 'hud-wbtn',
            type: 'button',
            disabled: true,
            'data-testid': testid,
            onclick: () => {
              const weapon = this.buttons[key - 1].id;
              if (this.unlocked && !this.disposed) this.select(weapon);
            },
          },
          h('span', { class: 'hud-key' }, String(key)),
          WEAPONS[id].name,
        );
        this.buttons.push({ id, el });
        return el;
      }),
    );

    this.el = h(
      'div',
      { class: 'combat-hud', 'data-testid': 'combat-hud' },
      this.banner,
      h('div', { class: 'hud-team-key', 'data-testid': 'team-key' }, h('span', { class: 'ally' }, '● 友方'), h('span', { class: 'enemy' }, '◆ 敌方')),
      this.feed,
      this.spectateEl,
      h('div', { class: 'hud-hitwrap' }, this.hitMarker, this.killBadge),
      this.hurt,
      h('div', { class: 'hud-health' }, h('div', { class: 'hud-hp' }, this.hpValue, h('span', { class: 'hud-hp-unit' }, 'HP')), h('div', { class: 'hud-hpbar' }, this.hpBar), this.armorRow),
      h('div', { class: 'hud-weapon' }, this.weaponName, h('div', { class: 'hud-ammo' }, this.ammoValue, this.ammoReserve)),
      h('div', { class: 'hud-center' }, this.equipmentState, this.reloadState, h('div', { class: 'hud-reloadbar' }, this.reloadBar), this.respawnState, this.protectChip),
      menu,
    );

    root.appendChild(this.el);
    this.syncButtons();
  }

  setEquipmentStatus(message: string): void {
    this.equipmentState.textContent = message;
    this.equipmentState.hidden = message.length === 0;
  }

  /** 每收到一次 CombatSelf 调一次；tick 是服务器 tick，用来算剩余时间 */
  update(self: CombatSelf, tick: number): void {
    if (this.disposed || !self) return;
    // —— 生命（左下） ——
    const hp = Number.isFinite(self.hp) ? Math.max(0, Math.round(self.hp)) : 0;
    this.hpValue.textContent = String(hp);
    const pct = Math.max(0, Math.min(100, (hp / MAX_HP) * 100));
    this.hpBar.style.width = `${pct}%`;
    this.el.classList.toggle('hud-critical', hp > 0 && hp <= 30);
    this.el.classList.toggle('hud-dead', !self.alive);

    // —— 护甲（SND 经济）：数值 / 档位名 / 盾牌；无甲、死亡后整行隐藏 ——
    const armorKind = self.armorKind ?? null;
    const armorPoints = Number.isFinite(self.armor) ? Math.max(0, Math.round(self.armor)) : 0;
    this.armorRow.hidden = armorKind === null;
    this.armorValue.textContent = String(armorPoints);
    this.armorKindText.textContent = armorKindName(armorKind);
    this.armorBar.style.width = armorKind === null ? '0%' : `${Math.max(0, Math.min(100, (armorPoints / ARMOR[armorKind].points) * 100))}%`;
    // 再生甲在脱战 3 秒后回甲：盾牌显示「回复中」
    this.armorRow.classList.toggle('is-regen', self.armorRegen === true);

    // —— 弹药 / 武器名（右下） ——
    this.weapon = self.weapon;
    const slot = weaponSlot(self.weapon);
    const selected = this.buttons[slot - 1];
    if (selected.id !== self.weapon) {
      selected.id = self.weapon;
      selected.el.replaceChildren(h('span', { class: 'hud-key' }, String(slot)), weaponName(self.weapon));
    }
    this.weaponName.textContent = weaponName(self.weapon);
    this.ammoValue.textContent = this.weapon === 'melee' ? '—' : String(Math.max(0, Math.round(self.mag)));
    this.ammoReserve.textContent = this.weapon === 'melee' ? '' : `/ ${Math.max(0, Math.round(self.reserve))}`;
    this.syncButtons();

    // —— 中下：换弹 / 复活 ——
    const reloadLeft = self.reloadUntil - tick;
    if (!self.alive) {
      this.reloadState.textContent = '';
      this.reloadBar.style.width = '0%';
      this.el.classList.remove('hud-reloading');
      if (self.respawnAt > 0) {
        const left = Math.max(0, (self.respawnAt - tick) / TICK);
        this.respawnState.textContent = `${left.toFixed(1)}s 后复活`;
      } else {
        // 爆破模式不自动复活：本回合淘汰后等下一回合（服务端 respawnAt 为 0）
        this.respawnState.textContent = '本回合已淘汰 · 等待下一回合';
      }
      this.respawnState.classList.add('on');
      this.lastReloadUntil = -1;
    } else {
      this.respawnState.textContent = '';
      this.respawnState.classList.remove('on');
      if (this.weapon === 'melee') {
        this.reloadState.textContent = '';
        this.reloadBar.style.width = '0%';
        this.el.classList.remove('hud-reloading');
        this.lastReloadUntil = -1;
      } else if (reloadLeft > 0) {
        this.reloadState.textContent = `换弹中 ${(reloadLeft / TICK).toFixed(1)}s`;
        this.el.classList.add('hud-reloading');
        // 进度完全按 tick 算：自换弹开始已过的 tick / 总 tick（不写死换弹时长）
        if (self.reloadUntil !== this.lastReloadUntil) {
          this.lastReloadUntil = self.reloadUntil;
          this.reloadFromTick = tick;
          this.reloadTotalTicks = Math.max(1, reloadLeft);
        }
        const done = (tick - this.reloadFromTick) / this.reloadTotalTicks;
        this.reloadBar.style.width = `${Math.max(0, Math.min(100, done * 100))}%`;
      } else {
        this.reloadState.textContent = this.touch ? '点击换弹' : 'R 换弹';
        this.reloadBar.style.width = '0%';
        this.el.classList.remove('hud-reloading');
        this.lastReloadUntil = -1;
      }
    }

    // —— 复活后的出生保护（团队死斗 15 秒，开火即取消）——
    const protectedNow = self.alive && self.protectedUntil > tick;
    this.protectChip.classList.toggle('on', protectedNow);
  }

  /** 每收到一个战斗事件调一次；names 是 id → 显示名 */
  event(e: CombatEvent, localId: number, names: Map<number, string>): void {
    if (this.disposed || !e) return;
    if (e.kind === 'shot') {
      // 一次攻击聚合所有射线：友军挡枪 / 受保护目标 damage 为 0，不给假命中反馈
      let hit = false;
      let head = false;
      let hurt = false;
      for (const ray of e.rays) {
        if (ray.hit === null || !(ray.damage > 0)) continue;
        hit = true;
        if (ray.part === 'head') head = true;
        if (ray.hit === localId) hurt = true;
      }
      if (e.shooter === localId && hit) this.marker(head);
      if (hurt) this.hurtFlash();
    } else if (e.kind === 'death') {
      this.pushFeed(names.get(e.killer) ?? DEFAULT_NAME, names.get(e.player) ?? DEFAULT_NAME, e.weapon);
      if (e.killer === localId) this.killConfirm(e.weapon);
    }
  }

  /** 解锁（ESC 菜单）时才能点 1/2/3 换枪；锁定时按钮只读、不抢鼠标 */
  setMenu(unlocked: boolean): void {
    if (this.disposed) return;
    this.unlocked = unlocked;
    this.el.classList.toggle('hud-unlocked', unlocked);
    this.syncButtons();
  }
  /** Infection mode: server-selected infected players may only use melee. */
  setInfectedOnly(infected: boolean): void {
    if (this.disposed || this.infectedOnly === infected) return;
    this.infectedOnly = infected;
    this.el.classList.toggle('hud-infected', infected);
    this.syncButtons();
  }

  /**
   * 观战面板（阶段11）：传 null 收起（活着）；传视图就显示「正在观战：<队友名>」+ 目标血量 / 弹药，
   * 右上角队友列表里高亮当前目标。每帧调一次——文字用 diff 写入，队友列表只在身份 / 存活变化时重建。
   */
  setSpectate(s: SpectateHudView | null): void {
    if (this.disposed) return;
    this.el.classList.toggle('hud-spectating', s !== null);
    this.spectateEl.hidden = s === null;
    if (!s) {
      if (this.spectateSig) {
        this.spectateSig = '';
        this.spectateList.replaceChildren();
        this.spectateRows.clear();
      }
      if (this.banner.textContent !== this.bannerDefault) this.banner.textContent = this.bannerDefault;
      return;
    }
    const target = s.target;
    const title = target ? spectateLabel(target.name) : SPECTATE_FREE_LOOK;
    if (this.spectateTitle.textContent !== title) this.spectateTitle.textContent = title;
    const hp = target ? Math.max(0, Math.round(target.hp)) : 0;
    const hpText = String(hp);
    if (this.spectateHp.textContent !== hpText) this.spectateHp.textContent = hpText;
    this.spectateHpBar.style.width = `${target ? Math.max(0, Math.min(100, (hp / MAX_HP) * 100)) : 0}%`;
    // 近战没有弹药：与右下那块 HUD 同一口径（显示「—」而不是 0/0）
    const melee = target?.weapon === 'melee';
    const ammoText = !target || melee ? '—' : `${Math.max(0, Math.round(target.mag))} / ${Math.max(0, Math.round(target.reserve))}`;
    if (this.spectateAmmo.textContent !== ammoText) this.spectateAmmo.textContent = ammoText;
    const weaponText = target ? weaponName(target.weapon) : '';
    if (this.spectateWeapon.textContent !== weaponText) this.spectateWeapon.textContent = weaponText;
    const hint = s.touch ? SPECTATE_KEYS_TOUCH : SPECTATE_KEYS_DESKTOP;
    if (this.spectateHint.textContent !== hint) this.spectateHint.textContent = hint;
    const banner = `观战 · ${hint}`;
    if (this.banner.textContent !== banner) this.banner.textContent = banner;
    // 队友列表：身份 / 顺序 / 存活态变了才重建行
    const sig = `${target?.id ?? 'none'}|${s.mates.map((m) => `${m.id}:${m.alive ? 1 : 0}:${m.name}`).join(',')}`;
    if (sig !== this.spectateSig) {
      this.spectateSig = sig;
      this.spectateRows.clear();
      this.spectateList.replaceChildren();
      for (const m of s.mates) {
        const name = h('b', { class: 'hud-spectate-name', 'data-testid': 'spectate-mate-name' }, m.name);
        const hpEl = h('span', { class: 'hud-spectate-mate-hp', 'data-testid': 'spectate-mate-hp' }, String(Math.max(0, Math.round(m.hp))));
        const el = h('li', { class: 'hud-spectate-row', 'data-testid': 'spectate-mate', 'data-id': String(m.id), 'data-alive': String(m.alive) }, name, hpEl);
        this.spectateRows.set(m.id, { el, name, hp: hpEl });
        this.spectateList.append(el);
      }
    }
    for (const m of s.mates) {
      const row = this.spectateRows.get(m.id);
      if (!row) continue;
      const current = target !== null && m.id === target.id;
      row.el.classList.toggle('on', current);
      row.el.classList.toggle('is-dead', !m.alive);
      row.el.dataset.alive = String(m.alive);
      row.el.setAttribute('aria-current', String(current));
      row.el.setAttribute('aria-label', `${m.name}，${m.alive ? `${Math.max(0, Math.round(m.hp))} 点生命` : '阵亡'}${current ? '（正在观战）' : ''}`);
      const hpText2 = m.alive ? String(Math.max(0, Math.round(m.hp))) : '阵亡';
      if (row.hp.textContent !== hpText2) row.hp.textContent = hpText2;    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const t of this.timers) clearTimeout(t);
    if (this.killBadgeTimer) clearTimeout(this.killBadgeTimer);
    this.timers.clear();
    this.feedRows.length = 0;
    this.el.remove();
  }

  // ———— 内部 ————

  private syncButtons(): void {
    for (const b of this.buttons) {
      b.el.disabled = !this.unlocked || (this.infectedOnly && b.id !== 'melee');
      b.el.classList.toggle('on', b.id === this.weapon);
    }
  }

  private after(ms: number, fn: () => void): void {
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      if (!this.disposed) fn();
    }, ms);
    this.timers.add(id);
  }

  private marker(head: boolean): void {
    this.hitMarker.classList.add('on');
    this.hitMarker.classList.toggle('head', head);
    this.after(MARKER_MS, () => {
      this.hitMarker.classList.remove('on', 'head');
    });
  }

  private hurtFlash(): void {
    this.hurt.classList.add('on');
    this.after(HURT_MS, () => this.hurt.classList.remove('on'));
  }

  /** 自己拿到击杀：准心下短暂显示武器剪影 +「击杀」，和击杀提示音一起给即时反馈。 */
  private killConfirm(weapon: WeaponId): void {
    const icon = weaponIcon(weapon);
    if (!icon) return;
    this.killBadgeIcon.src = icon;
    this.killBadgeIcon.alt = weaponName(weapon);
    this.killBadge.classList.remove('on');
    void this.killBadge.offsetWidth; // 重启动画
    this.killBadge.classList.add('on');
    if (this.killBadgeTimer) {
      clearTimeout(this.killBadgeTimer);
      this.timers.delete(this.killBadgeTimer);
    }
    this.killBadgeTimer = window.setTimeout(() => {
      this.timers.delete(this.killBadgeTimer);
      this.killBadge.classList.remove('on');
    }, KILL_BADGE_MS);
    this.timers.add(this.killBadgeTimer);
  }

  private pushFeed(killer: string, victim: string, weapon: WeaponId): void {
    const name = weaponName(weapon);
    const icon = weaponIcon(weapon);
    const row = h(
      'div',
      { class: 'hud-feed-row', 'data-weapon': weapon },
      h('span', { class: 'hud-feed-killer' }, killer),
      h('span', { class: 'hud-feed-gun', title: name },
        icon ? h('img', { class: 'hud-feed-icon', src: icon, alt: name, draggable: false }) : null,
        h('span', { class: 'hud-feed-gun-name' }, name)),
      h('span', { class: 'hud-feed-victim' }, victim),
    );
    this.feed.appendChild(row);
    const entry: FeedRow = { el: row, timer: 0 };
    this.feedRows.push(entry);
    while (this.feedRows.length > FEED_MAX) {
      const old = this.feedRows.shift()!;
      clearTimeout(old.timer);
      old.el.remove();
    }
    entry.timer = window.setTimeout(() => {
      this.timers.delete(entry.timer);
      const i = this.feedRows.indexOf(entry);
      if (i >= 0) this.feedRows.splice(i, 1);
      entry.el.remove();
    }, FEED_MS);
    this.timers.add(entry.timer);
  }
}