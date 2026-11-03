// 装备菜单：团队死斗免费切换，爆破模式使用共享经济配置购买。
import type { Mode } from '../../shared/catalog.ts';
import type { WeaponId } from '../../shared/combat.ts';
import { ARMOR, ARMOR_KINDS, ARMOR_REGEN, buyPrice, type ArmorKind, type BuyItem } from '../../shared/economy.ts';
import { WEAPON_ADS, WEAPON_GROUPS, WEAPONS } from '../../shared/sim/weapons.ts';
import { h } from './dom.ts';
import { trapTab } from './overlay.ts';
import { weaponIcon } from './art.ts';

/** 购买窗里显示的余额与拥有状态（SND）；TDM 不传，按免费切换走 */
export interface BuyEconomyView {
  credits: number;
  /** 本回合已拥有的武器（含随身刀 / 免费手枪） */
  owned: readonly WeaponId[];
  armorKind: ArmorKind | null;
  /** 剩余护甲点 */
  armor: number;
  /** 这一刻能不能买（SND 只在回合准备阶段、且活着） */
  buying: boolean;
}

/** 服务器 buyResult 的显示口径（客户端只负责显示，不自己扣款） */
export interface BuyFeedback {
  ok: boolean;
  message: string;
  item: BuyItem;
}

export interface BuyMenuOptions {
  root: HTMLElement;
  /** 模式：snd 走经济（价格 / 余额 / 护甲列），tdm 走免费切换 */
  mode: Mode;
  /** 切换武器（TDM 免费切换；SND 里点已有装备也走它） */
  onSelect: (weapon: WeaponId) => void;
  /** 购买（SND）：发 buy 命令，结果由服务器 buyResult 回来 */
  onBuy: (item: BuyItem) => void;
  onResume: () => void;
  onPause: () => void;
  onVisibilityChange: (open: boolean) => void;
}

// 武器图标统一由 art.ts 提供（购买菜单与击杀信息共用）。

/** 自制盾牌图标，用颜色区分护甲类型。 */
function armorShieldIcon(color: string): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' width='32' height='32'>`
    + `<path d='M16 3.5 5.5 7.4v8.4c0 6.9 4.4 11.4 10.5 12.7 6.1-1.3 10.5-5.8 10.5-12.7V7.4L16 3.5Z' fill='${color}' stroke='rgba(15,23,42,0.45)' stroke-width='1.6' stroke-linejoin='round'/>`
    + `<path d='M16 8.6v13.4' stroke='rgba(255,255,255,0.55)' stroke-width='1.6' stroke-linecap='round'/>`
    + `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** 护甲图标按类型配色。 */
const ARMOR_ICONS: Record<ArmorKind, string> = {
  light: armorShieldIcon('#60A5FA'),
  regen: armorShieldIcon('#10B981'),
  heavy: armorShieldIcon('#374151'),
};


const STAGE = { width: 1116, height: 677 } as const;
const TILE_GAP = 6;
interface Column {
  x: number;
  w: number;
  groups: readonly string[];
}
/** TDM：第五列是近战（本项目没有护甲） */
const TDM_COLUMNS: readonly Column[] = [
  { x: 20, w: 136, groups: ['手枪'] },
  { x: 174, w: 200, groups: ['冲锋枪', '霰弹枪'] },
  { x: 379, w: 225, groups: ['步枪'] },
  { x: 609, w: 205, groups: ['狙击枪', '机枪'] },
  { x: 832, w: 122, groups: ['近战'] },
];
/** 爆破模式第五列显示防护与近战。 */
const SND_COLUMNS: readonly Column[] = [
  ...TDM_COLUMNS.slice(0, 4),
  { x: 832, w: 122, groups: ['防护', '近战'] },
];
/** SND 在顶部留出余额条的位置：表头下移、格子从 61 开始（总高不变） */
const SND_HEAD_TOP = 30;
const SND_TILE_TOP = 61;
const CATEGORY_BY_WEAPON = new Map(
  WEAPON_GROUPS.flatMap((group) => group.weapons.map((id) => [id, group.name] as const)),
);

interface TileLayout {
  item: BuyItem;
  category: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Card {
  item: BuyItem;
  button: HTMLButtonElement;
  cost: HTMLElement;
}

interface DamageRange {
  start: number;
  end: number;
  head: number;
  body: number;
  legs: number;
}

const numberText = (value: number) => Number.isInteger(value)
  ? String(value)
  : String(Math.round(value * 100) / 100);

const itemName = (item: BuyItem) => (item.type === 'weapon' ? WEAPONS[item.id].name : ARMOR[item.id].name);
const itemCategory = (item: BuyItem) => (item.type === 'weapon' ? CATEGORY_BY_WEAPON.get(item.id) ?? '武器' : '防护');
const itemIcon = (item: BuyItem) => (item.type === 'weapon' ? weaponIcon(item.id) : ARMOR_ICONS[item.id]);

function layoutsFor(items: readonly BuyItem[], categories: readonly string[], x: number, top: number, bottom: number, width: number): TileLayout[] {
  const height = (bottom - top - TILE_GAP * (items.length - 1)) / items.length;
  return items.map((item, index) => ({
    item,
    category: categories[index],
    x,
    y: top + index * (height + TILE_GAP),
    w: width,
    h: height,
  }));
}

function damageRanges(id: WeaponId): DamageRange[] {
  const def = WEAPONS[id];
  if (def.melee) return [];
  const falloffs = def.falloffs ?? (def.falloff ? [def.falloff] : []);
  const rows: DamageRange[] = [];
  let start = 0;
  let damage = def.damage;
  for (const falloff of falloffs) {
    rows.push({ start, end: falloff.distance, ...damage });
    start = falloff.distance;
    damage = falloff.damage;
  }
  rows.push({ start, end: def.range, ...damage });
  return rows;
}

/** 根据共享经济配置说明护甲效果。 */
function armorNote(kind: ArmorKind): string {
  const def = ARMOR[kind];
  return kind === 'regen'
    ? `脱战 ${ARMOR_REGEN.delaySeconds} 秒后，护甲从 ${def.pool} 点储备中恢复。`
    : `护甲吸收 ${Math.round(def.absorb * 100)}% 的伤害，最多承受 ${def.points} 点。`;
}

function statBar(label: string, value: string, fill: number) {
  return h(
    'div',
    { class: 'al-buy-bar' },
    h('span', null, label),
    h('b', null, value),
    h('i', null, h('i', { style: { width: `${Math.min(1, Math.max(0, fill)) * 100}%` } })),
  );
}

export class BuyMenu {
  readonly el: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly options: BuyMenuOptions;
  private readonly status: HTMLElement;
  private readonly creditsBar: HTMLElement;
  private readonly creditsValue: HTMLElement;
  private readonly cards: Card[];
  private readonly detailName: HTMLElement;
  private readonly detailCategory: HTMLElement;
  private readonly detailIcon: HTMLImageElement;
  private readonly detailBody: HTMLElement;
  private readonly detailFoot: HTMLElement;
  private readonly resizeObserver: ResizeObserver | null;
  private readonly filters: HTMLElement;
  private readonly mobileSub: HTMLElement;
  private compact = false;
  private category = '全部';
  private current: WeaponId = 'vandal';
  private canSwitch = false;
  private hovered: BuyItem | null = null;
  private open_ = false;
  private disposed = false;
  private economy: BuyEconomyView | null = null;
  private statusTimer = 0;

  constructor(options: BuyMenuOptions) {
    this.options = options;
    const snd = options.mode === 'snd';
    const groupsByName = new Map(WEAPON_GROUPS.map((group) => [group.name, group] as const));
    const cards: Card[] = [];
    const heads: HTMLElement[] = [];
    const tiles: TileLayout[] = [];
    const columns = snd ? SND_COLUMNS : TDM_COLUMNS;
    const headTop = snd ? SND_HEAD_TOP : 6;
    const tileTop = snd ? SND_TILE_TOP : 37;

    /** 一个分类下的条目：防护 = 三档护甲（复制原站第五列），其余 = 武器 */
    const itemsOf = (name: string): BuyItem[] => name === '防护'
      ? ARMOR_KINDS.map((id) => ({ type: 'armor', id }) as const)
      : (groupsByName.get(name)?.weapons ?? []).map((id) => ({ type: 'weapon', id }) as const);

    for (const column of columns) {
      const groups = column.groups.map((name) => {
        if (name !== '防护' && !groupsByName.has(name)) throw new Error(`装备菜单缺少武器分类：${name}`);
        return name;
      });
      groups.forEach((name, index) => {
        heads.push(h(
          'div',
          {
            class: 'al-buy-head buy-category',
            style: { left: `${column.x}px`, width: `${column.w}px`, top: `${index === 0 ? headTop : 345}px` },
            'aria-label': name,
          },
          name,
        ));
      });
      if (groups.length === 1) {
        const items = itemsOf(groups[0]);
        tiles.push(...layoutsFor(items, items.map(() => groups[0]), column.x, tileTop, 630, column.w));
      } else {
        const top = itemsOf(groups[0]), bottom = itemsOf(groups[1]);
        tiles.push(...layoutsFor(top, top.map(() => groups[0]), column.x, tileTop, 335, column.w));
        tiles.push(...layoutsFor(bottom, bottom.map(() => groups[1]), column.x, 373, 630, column.w));
      }
    }

    for (const layout of tiles) {
      const item = layout.item;
      const cost = h('span', { class: 'al-buy-cost' });
      const button = h(
        'button',
        {
          class: 'al-buy-tile buy-option',
          type: 'button',
          style: {
            left: `${layout.x}px`,
            top: `${layout.y}px`,
            width: `${layout.w}px`,
            height: `${layout.h}px`,
          },
          // 武器沿用 buy-<weaponId>（现有回归脚本按它点格子）；护甲是 buy-armor-<kind>
          'data-testid': item.type === 'weapon' ? `buy-${item.id}` : `buy-armor-${item.id}`,
          'data-category': layout.category,
          'aria-label': `${itemName(item)}，${layout.category}`,
          'aria-pressed': 'false',
          onpointerenter: () => {
            this.hovered = item;
            this.refreshDetail();
          },
          onfocus: () => {
            this.hovered = item;
            this.refreshDetail();
          },
          onclick: () => this.activate(item),
        },
        h('span', { class: 'al-buy-mobile-category' }, layout.category),
        h('span', { class: 'al-buy-chips' }, h('span', { class: 'al-buy-chip' }, snd ? '已有' : '在用')),
        h('img', { class: 'al-buy-icon', src: itemIcon(item), alt: '', draggable: 'false' }),
        h(
          'span',
          { class: 'al-buy-tag' },
          h('span', { class: 'al-buy-name' }, itemName(item)),
          h(
            'span',
            { class: 'al-buy-stat' },
            item.type === 'weapon'
              ? (item.id === 'melee' ? '轻击 50　重击 75' : `${numberText(WEAPONS[item.id].rate)} 发/秒　${WEAPONS[item.id].magazine} 发`)
              : `护甲 ${ARMOR[item.id].points} 点${ARMOR[item.id].pool > 0 ? `　池 ${ARMOR[item.id].pool}` : ''}`,
          ),
          cost,
        ),
      );
      cards.push({ item, button, cost });
    }
    this.cards = cards;

    this.detailName = h('div', { class: 'al-buy-dname' });
    this.detailCategory = h('div', { class: 'al-buy-dcat' });
    this.detailIcon = h('img', { class: 'al-buy-dicon', alt: '', draggable: 'false' });
    this.detailBody = h('div');
    this.detailFoot = h('p', { class: 'al-buy-dfoot' });
    const detail = h(
      'aside',
      {
        class: 'al-buy-detail',
        style: { left: '966px', top: '37px', width: '144px', height: '593px' },
        'aria-live': 'polite',
      },
      this.detailName,
      this.detailCategory,
      this.detailIcon,
      this.detailBody,
      this.detailFoot,
    );
    this.status = h(
      'div',
      { class: 'al-buy-foot', 'data-testid': 'buy-status', 'aria-live': 'polite' },
      '点击枪械立即切换；',
      h('kbd', null, 'B'),
      ' 关闭，',
      h('kbd', null, 'Esc'),
      ' 回到暂停菜单',
    );
    this.creditsValue = h('b', { 'data-testid': 'buy-credits' }, '0');
    this.creditsBar = h(
      'div',
      { class: 'al-buy-credits', 'aria-live': 'polite' },
      h('span', null, snd ? '余额' : '本模式免费'),
      this.creditsValue,
      h('small', null, snd ? '购买阶段内可随时补买 · 死亡后重购' : ''),
    );
    this.filters = h('div', { class: 'al-buy-filters', 'aria-label': '装备分类' },
      ...['全部', ...(snd ? columns.flatMap((c) => c.groups) : WEAPON_GROUPS.map(group => group.name))].map(name => h('button', {
        type: 'button', 'data-category-filter': name, 'aria-pressed': String(name === this.category),
        onclick: () => {
          this.category = name;
          this.refresh();
          const catalog = this.panel.querySelector('.al-buy-catalog');
          if (catalog) catalog.scrollTop = 0;
        },
      }, name)),
    );
    this.mobileSub = h('small', null, snd ? '买不起的置灰 · 点击已有装备即切换' : '免费切换 · 主副武器独立保留');
    const mobileHead = h('div', { class: 'al-buy-mobile-head' },
      h('div', null, h('strong', null, snd ? '选择装备' : '选择装备'), this.mobileSub),
      h('button', { class: 'btn ghost', type: 'button', 'data-testid': 'buy-close', onclick: () => this.close(true) }, '返回对局'),
    );
    this.panel = h(
      'div',
      {
        class: 'al-buy-stage buy-panel',
        tabindex: '-1',
        style: { width: `${STAGE.width}px`, height: `${STAGE.height}px` },
        onpointerleave: () => {
          this.hovered = null;
          this.refreshDetail();
        },
      },
      mobileHead,
      this.filters,
      h('div', { class: 'al-buy-catalog' }, ...heads, this.creditsBar, ...cards.map((card) => card.button), detail),
      h('div', { class: 'al-buy-line' }),
      this.status,
    );
    this.el = h(
      'div',
      {
        class: 'al-buy buy-overlay',
        'data-testid': 'buy-menu',
        'data-mode': options.mode,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': '装备菜单',
        'aria-hidden': 'true',
        onmousedown: (e: MouseEvent) => e.stopPropagation(),
        onpointerdown: (e: PointerEvent) => e.stopPropagation(),
      },
      this.panel,
    );
    options.root.append(this.el);
    this.resizeStage();
    this.resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(this.resizeStage);
    this.resizeObserver?.observe(this.el);
    window.addEventListener('resize', this.resizeStage);
    this.refresh();
    document.addEventListener('keydown', this.onKeyDown, true);
  }

  get isOpen() {
    return this.open_;
  }

  /**
   * 每帧调用一次：当前手上的武器 + 现在能不能开菜单（SND 只在购买阶段且活着）。
   * economy 为 null 表示 TDM（免费切换，不显示价格 / 余额）。
   */
  update(current: WeaponId, canSwitch: boolean, economy: BuyEconomyView | null = null) {
    const changed = this.current !== current || this.canSwitch !== canSwitch
      || !sameEconomy(this.economy, economy);
    this.current = current;
    this.canSwitch = canSwitch;
    this.economy = economy;
    if (!changed) return;
    // 购买窗一关就自动收起菜单（回合开始了不能继续买）
    if (this.open_ && !canSwitch && economy?.buying === false) {
      this.close(false);
      return;
    }
    this.refresh();
  }

  /** 服务器 buyResult：状态条显示「已购买 … · 余额 …」或失败原因；不自己算扣款 */
  notify(result: BuyFeedback) {
    this.setStatus(result.message, result.ok ? 'ok' : 'warn');
    this.refresh();
  }

  open() {
    if (this.disposed || this.open_ || !this.canSwitch) return false;
    this.open_ = true;
    this.hovered = null;
    this.category = '全部';
    this.el.classList.add('on');
    this.el.setAttribute('aria-hidden', 'false');
    this.resizeStage();
    this.refresh();
    this.panel.scrollTop = 0;
    this.panel.focus();
    this.options.onVisibilityChange(true);
    return true;
  }

  close(resume: boolean) {
    if (!this.open_) return;
    this.open_ = false;
    this.hovered = null;
    this.el.classList.remove('on');
    this.el.setAttribute('aria-hidden', 'true');
    this.options.onVisibilityChange(false);
    if (resume && !this.disposed) this.options.onResume();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    document.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('resize', this.resizeStage);
    this.resizeObserver?.disconnect();
    window.clearTimeout(this.statusTimer);
    this.open_ = false;
    this.el.remove();
  }

  // ———— 内部 ————

  private get snd() {
    return this.options.mode === 'snd';
  }

  private get buying() {
    return this.canSwitch && (this.economy?.buying ?? false);
  }

  private ownedWeapons(): Set<WeaponId> {
    return new Set(this.economy?.owned ?? []);
  }

  /** 这件装备是不是已经属于我（SND）；TDM 里“拥有”就是身上的枪，由 is-equipped 表示 */
  private isOwned(item: BuyItem): boolean {
    if (item.type === 'weapon') return !this.snd || this.ownedWeapons().has(item.id);
    return !!this.economy && this.economy.armorKind === item.id && this.economy.armor >= ARMOR[item.id].points;
  }

  /** 手上 / 身上正在用的（含被打掉一部分的甲） */
  private isEquipped(item: BuyItem): boolean {
    if (item.type === 'weapon') return item.id === this.current;
    return !!this.economy && this.economy.armorKind === item.id && this.economy.armor > 0;
  }

  private affordable(item: BuyItem): boolean {
    if (!this.snd) return true;
    if (!this.economy) return true;
    return this.economy.credits >= buyPrice(item);
  }

  /** 点击格子：已有 → 切换；买得起 → 购买；买不起 → 只给提示（格子已置灰，不会真的买） */
  private activate(item: BuyItem) {
    if (!this.open_ || !this.canSwitch) return;
    if (this.snd && !this.isOwned(item)) {
      if (!this.economy?.buying) {
        this.setStatus('购买窗已关闭：装备只在回合准备阶段购买', 'warn');
        return;
      }
      if (!this.affordable(item)) {
        const price = buyPrice(item);
        const left = price - (this.economy?.credits ?? 0);
        this.setStatus(`余额不足：${itemName(item)} ${price}，当前 ${this.economy?.credits ?? 0}，还差 ${left}`, 'warn');
        return;
      }
      this.setStatus(`正在购买 ${itemName(item)}…`, 'ok');
      this.options.onBuy(item);
      return;
    }
    if (item.type === 'weapon') {
      if (this.snd && !this.isOwned(item)) return;
      this.options.onSelect(item.id);
      this.close(true);
      return;
    }
    this.setStatus(`${itemName(item)}：已经在身上了`, 'ok');
  }

  private setStatus(text: string, kind: 'ok' | 'warn') {
    this.status.textContent = text;
    this.status.classList.toggle('is-warn', kind === 'warn');
    this.status.classList.toggle('is-ok', kind === 'ok');
    window.clearTimeout(this.statusTimer);
    this.statusTimer = window.setTimeout(() => {
      if (!this.disposed) this.refresh();
    }, 6000);
  }

  private resizeStage = () => {
    const compact = this.options.root.classList.contains('touch')
      || (this.el.clientWidth > 0 && this.el.clientWidth < 900)
      || (this.el.clientHeight > 0 && this.el.clientHeight < 500);
    if (compact !== this.compact) {
      this.compact = compact;
      this.el.classList.toggle('is-compact', compact);
      this.refresh();
    }
    if (compact) {
      this.panel.style.transform = 'none';
      return;
    }
    const fit = Math.min(this.el.clientWidth / STAGE.width, this.el.clientHeight / STAGE.height);
    const scale = fit > 0 ? Math.min(fit, Math.max(fit * 0.75, 0.85)) : 1;
    this.panel.style.transform = `translate(-50%, -50%) scale(${scale})`;
  };

  private refreshDetail() {
    const item = this.hovered ?? this.cards.find((card) => card.item.type === 'weapon' && card.item.id === this.current)?.item
      ?? { type: 'weapon', id: this.current } as BuyItem;
    const name = itemName(item);
    this.detailName.textContent = name;
    this.detailCategory.textContent = itemCategory(item);
    this.detailIcon.src = itemIcon(item);

    if (item.type === 'armor') {
      const def = ARMOR[item.id];
      const bars = [
        statBar('护甲值', `${def.points} 点`, def.points / 50),
        statBar('吸收伤害', `${Math.round(def.absorb * 100)}%`, def.absorb),
      ];
      if (def.pool > 0) bars.push(statBar('再生池', `${def.pool} 点`, def.pool / 50));
      this.detailBody.replaceChildren(
        h('div', { class: 'al-buy-bars' }, ...bars),
        h('dl', { class: 'al-buy-kv' },
          h('dt', null, '价格'), h('dd', null, h('b', null, String(def.price))),
          h('dt', null, '护甲点'), h('dd', null, h('b', null, String(def.points))),
          h('dt', null, '吸收'), h('dd', null, h('b', null, `${Math.round(def.absorb * 100)}%`)),
          ...(def.pool > 0 ? [h('dt', null, '再生'), h('dd', null, h('b', null, `${ARMOR_REGEN.perSecond} 点/秒`))] : []),
        ),
        h('p', { class: 'al-buy-note' }, armorNote(item.id)),
        h('p', { class: 'al-buy-note' }, '头部伤害不走护甲；头盔与护甲捆绑，不单独购买。'),
      );
      this.detailFoot.textContent = this.footText(item);
      this.detailFoot.classList.toggle('is-now', this.isEquipped(item));
      return;
    }

    const id = item.id;
    const def = WEAPONS[id];
    const bars = def.melee
      ? [
        statBar('轻击', '50 点', 50 / 150),
        statBar('重击', '75 点', 75 / 150),
        statBar('射程', `${numberText(def.range)} 米`, def.range / 50),
      ]
      : [
        statBar('射速', `${numberText(def.rate)} 发/秒`, def.rate / 16),
        statBar(def.pelletsPerShot > 1 ? '身体伤害/弹丸' : '身体伤害', `${numberText(def.damage.body)} 点`, def.damage.body / 150),
        statBar('弹匣', `${def.magazine} 发`, def.magazine / 50),
      ];
    const content: HTMLElement[] = [h('div', { class: 'al-buy-bars' }, ...bars)];
    if (def.melee) {
      content.push(h('p', { class: 'al-buy-note' }, '轻击 50 点，右键重击 75 点；命中距离 2 米，不消耗弹药。随身装备，无需购买。'));
    } else {
      const ads = WEAPON_ADS[id];
      const stats: HTMLElement[] = [
        h('dt', null, '换弹'),
        h('dd', null, h('b', null, numberText(def.reload)), ' 秒'),
        h('dt', null, '备弹'),
        h('dd', null, h('b', null, String(def.reserve)), ' 发'),
      ];
      if (def.pelletsPerShot > 1) {
        stats.push(h('dt', null, '弹丸/发'), h('dd', null, h('b', null, String(def.pelletsPerShot))));
      }
      stats.push(
        h('dt', null, '开镜'),
        h('dd', null, h('b', null, ads ? ads.zoomMultipliers.map((zoom) => `${numberText(zoom)}×`).join(' / ') : '无')),
      );
      content.push(h('dl', { class: 'al-buy-kv' }, ...stats));
      const table = h(
        'table',
        { class: 'al-buy-dmg' },
        h('thead', null, h('tr', null, h('th', null, '距离'), h('th', null, '头'), h('th', null, '身'), h('th', null, '腿'))),
        h(
          'tbody',
          null,
          ...damageRanges(id).map((range) => h(
            'tr',
            { key: `${range.start}-${range.end}` },
            h('td', null, `${numberText(range.start)}–${numberText(range.end)} 米`),
            h('td', { class: 'is-head' }, String(Math.round(range.head))),
            h('td', null, String(Math.round(range.body))),
            h('td', { class: 'is-leg' }, String(Math.round(range.legs))),
          )),
        ),
      );
      content.push(table);
      if (def.pelletsPerShot > 1) {
        content.push(h('p', { class: 'al-buy-note' }, '伤害表为单颗弹丸数值；每发独立判定全部弹丸，按实际命中数量累计伤害。'));
      }
      if (this.snd) {
        content.push(h('p', { class: 'al-buy-note' }, '死亡后武器与护甲全丢，下一回合重新购买。'));
      }
    }
    this.detailBody.replaceChildren(...content);
    this.detailFoot.textContent = this.footText(item);
    this.detailFoot.classList.toggle('is-now', this.isEquipped(item));
  }

  /** 详情面板底部的一句话状态（购买 / 切换 / 买不起 / 窗口关闭） */
  private footText(item: BuyItem): string {
    if (!this.snd) return this.isEquipped(item) ? '正在用这一把' : this.canSwitch ? '点格子切换' : '当前无法切换';
    if (this.isEquipped(item)) return item.type === 'armor' ? '正在穿这一档' : '正在用这一把';
    if (this.isOwned(item)) return '已拥有 · 点格子装备';
    const price = buyPrice(item);
    if (!this.canSwitch) return '购买窗已关闭（只在回合准备阶段购买）';
    if (!this.affordable(item)) return `买不起：还差 ${price - (this.economy?.credits ?? 0)}`;
    return price > 0 ? `点击购买 ${price}` : '点击装备（随身免费）';
  }

  private refresh() {
    const snd = this.snd;
    const eco = this.economy;
    const buying = this.buying;
    this.creditsValue.textContent = snd ? String(eco?.credits ?? 0) : '免费';
    this.creditsBar.classList.toggle('is-closed', snd && !buying);
    this.creditsBar.hidden = !snd;
    for (const card of this.cards) {
      const item = card.item;
      const equipped = this.isEquipped(item);
      const owned = !equipped && this.isOwned(item) && snd;
      const poor = snd && !this.isOwned(item) && !!eco && !this.affordable(item);
      const open = this.canSwitch;
      card.button.disabled = !open;
      card.button.hidden = this.compact && this.category !== '全部' && itemCategory(item) !== this.category;
      card.cost.textContent = snd ? (buyPrice(item) > 0 ? String(buyPrice(item)) : '免费') : '';
      card.cost.hidden = !snd;
      card.button.classList.toggle('is-equipped', equipped);
      card.button.classList.toggle('is-owned', owned);
      card.button.classList.toggle('is-poor', poor);
      card.button.classList.toggle('is-locked', snd && !buying);
      card.button.setAttribute('aria-pressed', String(equipped));
      card.button.setAttribute('aria-disabled', String(poor || (snd && !buying)));
      card.button.setAttribute('aria-label', `${itemName(item)}，${itemCategory(item)}${equipped ? '，正在用' : ''}`
        + (snd && !equipped ? `，${this.isOwned(item) ? '已拥有' : `价格 ${buyPrice(item)}`}${poor ? '，买不起' : ''}` : ''));
    }
    for (const button of this.filters.querySelectorAll<HTMLButtonElement>('button'))
      button.setAttribute('aria-pressed', String(button.dataset.categoryFilter === this.category));
    this.status.classList.toggle('is-warn', !this.canSwitch);
    if (this.compact) {
      this.status.textContent = this.statusText();
    } else {
      this.status.replaceChildren(...this.statusParts());
    }
    this.mobileSub.textContent = snd
      ? `余额 ${eco?.credits ?? 0} · ${buying ? '买不起的置灰' : '购买窗已关闭'}`
      : '免费切换 · 主副武器独立保留';
    this.refreshDetail();
  }

  /** 状态条文案（服务器 buyResult 会被 setStatus 覆盖，几秒后回到这句） */
  private statusText(): string {
    if (this.snd) return this.canSwitch
      ? `余额 ${this.economy?.credits ?? 0} · 点击购买 / 点已有装备切换`
      : '购买窗已关闭（只在回合准备阶段购买）';
    return this.canSwitch ? '点选武器立即装备 · 当前试玩无需购买' : '当前无法切换装备';
  }

  private statusParts(): (Node | string)[] {
    if (this.snd) {
      return this.canSwitch
        ? ['点击购买装备（余额 ', h('b', null, String(this.economy?.credits ?? 0)), '）；', h('kbd', null, 'B'), ' 关闭，', h('kbd', null, 'Esc'), ' 回到暂停菜单']
        : ['购买窗已关闭：只在回合准备阶段购买装备；', h('kbd', null, 'B'), ' / ', h('kbd', null, 'Esc'), ' 关闭。'];
    }
    return [
      this.canSwitch ? '点击枪械立即切换；' : '当前无法切换装备；',
      h('kbd', null, 'B'),
      this.canSwitch ? ' 关闭，' : ' / ',
      h('kbd', null, 'Esc'),
      this.canSwitch ? ' 回到暂停菜单' : ' 关闭。',
    ];
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.open_) return;
    if (e.key === 'Tab') {
      trapTab(e, this.panel);
      return;
    }
    if ((e.code !== 'KeyB' && e.code !== 'Escape') || e.repeat) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.close(e.code === 'KeyB');
    if (e.code === 'Escape') this.options.onPause();
  };
}

/** 余额 / 拥有表 / 护甲有没有变（避免每帧重建 DOM） */
function sameEconomy(a: BuyEconomyView | null, b: BuyEconomyView | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.credits === b.credits && a.armor === b.armor && a.armorKind === b.armorKind && a.buying === b.buying
    && a.owned.length === b.owned.length && a.owned.every((w, i) => w === b.owned[i]);
}