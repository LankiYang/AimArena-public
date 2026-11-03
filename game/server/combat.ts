// combat.ts（服务端）— 权威武器状态 / 位置历史 / 事件
//
//   职责：每个 tick「移动之后」推进一次武器；射线、伤害、死亡、复活全部在这里算。
//   它不认识网络，也不认识 World/MoveState：世界通过 BallisticsWorld 结构传入，身体由 match 每 tick setBody 更新，
//   重生点与「死亡时清移动/输入」由 host 回调交给 match。这样纯逻辑测试可以直接驱动这一份代码。
//
//   与 SPEC 对应的几条硬规则：
//     · 每个人每 tick 最多一发（不因积压命令多开枪）；半自动只认真实 press 边沿。
//     · 收到输入就记 lastInputTick；连续 8 tick 无新输入 → 暂停 fire/reload（防失联连射），不制造按键边沿。
//     · 服务器冻结或死亡时不射击；队友挡枪不扣血；出生保护期内不扣血；自己开火立刻取消自己的保护。
//     · 只对目标位置做最多 6 tick(187.5 ms) 回溯；死亡 / 新生命（life 不同）不能被旧历史击中。
import type { Team } from '../shared/catalog.ts';
import type { CombatEvent, CombatSelf, ShotRay, V3, WeaponId, WeaponState } from '../shared/combat.ts';
import { aimDir } from '../shared/combat.ts';
import {
  absorbArmor, armorRegenerating, clearArmor, equipArmor, newArmorState, stepArmorRegen,
  type ArmorKind, type ArmorState,
} from '../shared/economy.ts';
import { EYE_STAND } from '../shared/sim/movement.ts';
import { BTN, type UserCmd } from '../shared/protocol.ts';
import { traceMelee, traceRay, penetrationDamage, type BallisticsWorld, type HumanCandidate } from '../shared/sim/ballistics.ts';
import {
  WEAPONS, ammoOf, baseDamage, cancelWeaponActions, cloneWeaponState, firingState, isReloading, isWeaponId, meleeDamage,
  newWeaponState, resetWeapon, shotAngles, startEquip, stepWeaponInput, ticksFor,
  type WeaponAttack,
} from '../shared/sim/weapons.ts';
import { SOURCE_WEAPONS } from '../shared/sim/weapon-source.ts';
import { TDM, tdmTicks } from '../shared/tdm.ts';

/** 回放窗口：最多 6 tick（187.5 ms） */
export const MAX_LAG_TICKS = 6;
/** 位置历史长度（tick） */
export const HISTORY_TICKS = 8;
/** 连续多少 tick 没有新输入就松开按键 */
export const INPUT_TIMEOUT_TICKS = 8;
/** 与近战视模轻/重攻击命中帧（0.18 秒）一致。 */
const MELEE_HIT_TICKS = ticksFor(0.18);
/** 团队死斗的官方数值：阵亡 1.5 秒后复活，复活后 15 秒出生保护（shared/tdm.ts）；爆破由 match 关闭自动复活与保护 */
export const RESPAWN_TICKS = tdmTicks(TDM.respawnSec);
export const PROTECT_TICKS = tdmTicks(TDM.protectSec);
/** 本项目伤害助攻规则：目标死亡前 10 秒内累计实际扣血至少 50；击杀者不重复获助攻。 */
export const ASSIST_WINDOW_TICKS = ticksFor(10);
export const ASSIST_DAMAGE = 50;

/** 在射击轴周围采样圆盘锥；极近竖直的视角改用 X 轴建立正交基。 */
function pelletDirection(axis: V3, degrees: number, power: number, sample: { angle: number; radius: number } | undefined): V3 {
  if (!sample || degrees <= 0) return axis;
  const angle = sample.angle * Math.PI * 2;
  const radius = Math.tan(Math.pow(sample.radius, power) * degrees * Math.PI / 180);
  let rx: number, ry: number, rz: number;
  if (Math.abs(axis.y) < 0.99) { rx = -axis.z; ry = 0; rz = axis.x; }
  else { rx = 0; ry = axis.z; rz = -axis.y; }
  const scale = 1 / Math.hypot(rx, ry, rz);
  rx *= scale; ry *= scale; rz *= scale;
  const ux = axis.y * rz - axis.z * ry;
  const uy = axis.z * rx - axis.x * rz;
  const uz = axis.x * ry - axis.y * rx;
  const x = Math.cos(angle) * radius, y = Math.sin(angle) * radius;
  const dx = axis.x + rx * x + ux * y;
  const dy = axis.y + ry * x + uy * y;
  const dz = axis.z + rz * x + uz * y;
  const length = Math.hypot(dx, dy, dz);
  return { x: dx / length, y: dy / length, z: dz / length };
}

/** 一具身体：由 match 每个 tick（移动之后）写入 */
export interface CombatBody {
  /** 脚底坐标 */
  x: number;
  y: number;
  z: number;
  /** 眼睛相对脚底的高度（eyeHeight(s)） */
  eye: number;
  crouch: number;
  /** 水平速度 */
  speed: number;
  grounded?: boolean;
  walking?: boolean;
  crouchHeld?: boolean;
  landT?: number;
  landV?: number;
  tagged?: boolean;
  tagState?: number;
  tagSpeed?: number;
  yaw: number;
  pitch: number;
}

export interface RespawnPoint {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** match 提供的外部动作 */
export interface CombatHost {
  /** 复活点（复用 match 现有的 spawnPoint(队, 队内序号)） */
  respawn(id: number): RespawnPoint;
  /** 死亡瞬间：清移动速度、清待处理输入 */
  onDeath(id: number): void;
  /** 近战实际扣血后通知模式规则；可用于服务端权威感染转换。 */
  onMeleeHit?(attacker: number, victim: number, damage: number, tick: number): void;
  /** 复活：按复活点重置移动状态与视角；命令 seq 必须保持单调（不得重置 lastSeq） */
  onRespawn(id: number, sp: RespawnPoint): void;
}

export interface CombatStatus {
  hp: number;
  alive: boolean;
  life: number;
}

/** 人机决策只读标量；后坐力是射线角度，不是 CombatSelf 的相机后坐力。 */
export interface BotCombatState extends Readonly<Pick<CombatSelf, 'hp' | 'weapon' | 'mag' | 'reserve' | 'reloadUntil' | 'equipUntil'>> {
  readonly shotYaw: number;
  readonly shotPitch: number;
  readonly nextFireTick: number;
  readonly aim: boolean;
}

interface Hist {
  tick: number;
  life: number;
  alive: boolean;
  x: number;
  y: number;
  z: number;
  crouch: number;
}

interface CPlayer {
  id: number;
  team: Team;
  bot: boolean;
  hp: number;
  alive: boolean;
  /** 护甲（爆破经济）：档位 / 剩余点 / 再生池 / 最近受击 tick；死亡与回合开始都清空 */
  armor: ArmorState;
  /** 生命序号：每复活一次 +1，用来隔绝旧历史 */
  life: number;
  /** 本次生命的出生 tick（复活时更新）：所见时刻早于它的回溯不能命中这具新身体 */
  spawnTick: number;
  w: WeaponState;
  body: CombatBody;
  /** 由命令流推出来的按键状态与按下边沿命令序号。 */
  fireHeld: boolean;
  fireEdge: boolean;
  fireEdgeSeq: number;
  reloadHeld: boolean;
  reloadEdge: boolean;
  aimHeld: boolean;
  aimEdge: boolean;
  aimEdgeSeq: number;
  /** 最后收到输入（任意命令）的 tick */
  lastInputTick: number;
  /** 最近一条命令里客户端自报的「所见 tick」（0 = 现在） */
  viewTick: number;
  commandSeq: number;
  recoilYaw: number;
  recoilPitch: number;
  /** 死亡 tick；0 = 活着 */
  deathTick: number;
  protectedUntil: number;
  /** 爆破锁枪：不能开枪 / 换弹（移动不受影响） */
  lock: boolean;
  pendingMelee: { due: number; attack: WeaponAttack } | null;
  history: Hist[];
  kills: number;
  deaths: number;
  assists: number;
  /** 只记录实际扣掉的 HP；按生命和时间窗口清理，霰弹多弹丸也只结算一次助攻。 */
  damageLog: { attacker: number; tick: number; damage: number }[];
}

const emptyBody = (): CombatBody => ({ x: 0, y: 0, z: 0, eye: EYE_STAND, crouch: 0, speed: 0, yaw: 0, pitch: 0 });

/** viewTick 夹紧：<=0 或未来 tick 视作当前 tick，过旧的夹到 当前-6 */
export function clampViewTick(viewTick: number, tick: number): number {
  const v = Math.floor(Number(viewTick) || 0);
  if (v <= 0 || v > tick) return tick;
  return v < tick - MAX_LAG_TICKS ? tick - MAX_LAG_TICKS : v;
}

export class CombatSystem {
  private players = new Map<number, CPlayer>();
  private events: CombatEvent[] = [];
  private shotSeq = 0;
  private tick = 0;
  private teamKills: [number, number] = [0, 0];
  /** 世界（projectile 汤 + 材质码）与外部动作（重生点 / 死亡清场） */
  private world: BallisticsWorld;
  private host: CombatHost;
  private respawnTicks: number;
  private protectTicks: number;
  /** true（TDM）：死后按 respawnTicks 自动复活；false（爆破）：只由 spawn() 在回合开始时复活 */
  private autoRespawn: boolean;
  private readonly maxHpOf: (id: number) => number;
  private readonly canRespawn: (id: number) => boolean;
  private readonly weaponPolicy: ((id: number, weapon: WeaponId) => WeaponId) | null;

  constructor(world: BallisticsWorld, host: CombatHost, opts: {
    respawnTicks?: number; protectTicks?: number; autoRespawn?: boolean;
    maxHpOf?: (id: number) => number;
    canRespawn?: (id: number) => boolean;
    weaponPolicy?: (id: number, weapon: WeaponId) => WeaponId;
  } = {}) {
    this.world = world;
    this.host = host;
    this.respawnTicks = opts.respawnTicks ?? RESPAWN_TICKS;
    this.protectTicks = opts.protectTicks ?? PROTECT_TICKS;
    this.autoRespawn = opts.autoRespawn ?? true;
    this.maxHpOf = opts.maxHpOf ?? (() => 100);
    this.canRespawn = opts.canRespawn ?? (() => true);
    this.weaponPolicy = opts.weaponPolicy ?? null;
  }

  // —— 生命周期 ——
  /** dead：从死亡开始（爆破回合进行中加入的人，等下一回合复活） */
  add(id: number, team: Team, bot: boolean, dead = false) {
    this.players.set(id, {
      id, team, bot,
      hp: dead ? 0 : 100,
      alive: !dead,
      armor: newArmorState(),
      life: 1,
      spawnTick: 0,
      w: newWeaponState(),
      body: emptyBody(),
      fireHeld: false, fireEdge: false, fireEdgeSeq: 0, reloadHeld: false, reloadEdge: false,
      aimHeld: false, aimEdge: false, aimEdgeSeq: 0,
      lastInputTick: 0,
      viewTick: 0,
      commandSeq: 0,
      recoilYaw: 0, recoilPitch: 0,
      deathTick: 0,
      protectedUntil: 0,
      lock: false,
      pendingMelee: null,
      history: [],
      kills: 0, deaths: 0, assists: 0, damageLog: [],
    });
  }

  /** 立即复活到出生点（爆破回合开始：全员回出生点，不论生死）；TDM 不用，走 respawnDue */
  spawn(id: number, tick: number) {
    const p = this.players.get(id);
    if (p) this.revive(p, tick);
  }
  /** 生化模式转换阵营；服务端同时更新伤害友军判定。 */
  setTeam(id: number, team: Team) {
    const p = this.players.get(id);
    if (p) p.team = team;
  }

  /** 强制武器（感染者转换时切近战并清理旧枪动作）。 */
  forceWeapon(id: number, weapon: WeaponId, tick: number) {
    const p = this.players.get(id);
    if (!p || !isWeaponId(weapon)) return;
    p.pendingMelee = null;
    p.w.weapon = weapon;
    p.w.reloadUntil = 0;
    p.w.equipUntil = tick;
    p.fireHeld = p.fireEdge = p.reloadHeld = p.reloadEdge = false;
    p.aimHeld = p.aimEdge = false;
    p.w.nextFireTick = tick;
    this.events.push({ kind: 'equip', player: id, weapon });
  }

  remove(id: number) {
    this.players.delete(id);
    // 离开者不能给后来复用同一 id 的实体留下伤害归属；已经计入的队伍比分保留。
    for (const p of this.players.values()) p.damageLog = p.damageLog.filter(h => h.attacker !== id);
  }

  /** 房间结束 / 对局释放：清掉全部生命周期资源（历史、事件、引用） */
  dispose() {
    this.players.clear();
    this.events.length = 0;
    this.teamKills = [0, 0];
  }

  has(id: number) {
    return this.players.has(id);
  }

  status(id: number): CombatStatus {
    const p = this.players.get(id);
    return p ? { hp: p.hp, alive: p.alive, life: p.life } : { hp: 0, alive: false, life: 0 };
  }
  /** 生化模式角色转换时设置当前生命值。 */
  setHealth(id: number, hp: number) {
    const p = this.players.get(id);
    if (p && p.alive) p.hp = Math.max(1, hp);
  }

  killsOf(id: number) {
    return this.players.get(id)?.kills ?? 0;
  }
  deathsOf(id: number) {
    return this.players.get(id)?.deaths ?? 0;
  }
  assistsOf(id: number) {
    return this.players.get(id)?.assists ?? 0;
  }
  teamKillsOf(): [number, number] {
    return [...this.teamKills];
  }

  setBody(id: number, b: CombatBody) {
    const p = this.players.get(id);
    if (p) { b.walking ??= p.body.walking; b.crouchHeld ??= p.body.crouchHeld; p.body = b; }
  }

  /** 中途加入：落地保护到 untilTick（与出生保护同一字段，只取更晚的那个） */
  protect(id: number, untilTick: number) {
    const p = this.players.get(id);
    if (p) p.protectedUntil = Math.max(p.protectedUntil, untilTick);
  }

  /** 爆破：购买护甲或回合开始时补满点数与再生池。 */
  setArmor(id: number, kind: ArmorKind | null) {
    const p = this.players.get(id);
    if (!p) return;
    if (kind === null) clearArmor(p.armor);
    else equipArmor(p.armor, kind);
  }

  /** 只读：某人当前的护甲（快照 / 自视图 / 测试用） */
  armorOf(id: number): { kind: ArmorKind | null; points: number; pool: number } | null {
    const p = this.players.get(id);
    return p ? { kind: p.armor.kind, points: p.armor.points, pool: p.armor.pool } : null;
  }

  /** 爆破：锁枪 / 解锁（购买 / 读条 / 结算锁） */
  setLock(id: number, locked: boolean) {
    const p = this.players.get(id);
    if (p) { p.lock = locked; if (locked) p.pendingMelee = null; }
  }

  /** 爆破：回合事件排进下一次 takeEvents（与战斗事件同序下发） */
  emit(e: CombatEvent) {
    this.events.push(e);
  }

  // —— 输入 ——
  /** 收到二进制输入包（哪怕命令全被丢弃也算「有输入」，防止误判失联） */
  noteInput(id: number, tick: number) {
    const p = this.players.get(id);
    if (p) p.lastInputTick = tick;
  }

  /** 最新命令驱动 held 状态；pressedEdges 保留合并输入期间的短按及其原始序号。 */
  onCommand(id: number, cmd: UserCmd, tick: number, pressedEdges = 0,
    pressedSeqs?: { fire?: number; aim?: number }) {
    const p = this.players.get(id);
    if (!p) return;
    p.lastInputTick = tick;
    p.viewTick = cmd.viewTick ?? 0;
    p.commandSeq = cmd.seq;
    p.body.walking = (cmd.buttons & BTN.walk) !== 0;
    p.body.crouchHeld = (cmd.buttons & BTN.crouch) !== 0;
    const fire = (cmd.buttons & BTN.fire) !== 0;
    if ((fire && !p.fireHeld) || (pressedEdges & BTN.fire) !== 0) {
      p.fireEdge = true;
      p.fireEdgeSeq = pressedSeqs?.fire ?? cmd.seq;
    }
    p.fireHeld = fire;
    const reload = (cmd.buttons & BTN.reload) !== 0;
    if ((reload && !p.reloadHeld) || (pressedEdges & BTN.reload) !== 0) p.reloadEdge = true;
    p.reloadHeld = reload;
    // 右键（BTN.aim）既要能给枪做 ADS held，也要给近战做重击边沿
    const aim = (cmd.buttons & BTN.aim) !== 0;
    if ((aim && !p.aimHeld) || (pressedEdges & BTN.aim) !== 0) {
      p.aimEdge = true;
      p.aimEdgeSeq = pressedSeqs?.aim ?? cmd.seq;
    }
    p.aimHeld = aim;
  }

  // —— 每 tick 推进（match 在「所有玩家移动完」之后调用一次）——
  advance(tick: number, frozen: boolean) {
    this.tick = tick;
    this.respawnDue(tick);
    for (const p of this.players.values()) this.recordHistory(p, tick);
    for (const p of this.players.values()) this.updateWeapon(p, tick, frozen);
    // 护甲再生：每个 tick 推一次。
    for (const p of this.players.values()) if (p.alive) stepArmorRegen(p.armor, tick);
  }

  /** 某个玩家这一 tick 的自身状态（发给对应真人的 CombatSelf） */
  selfOf(id: number, tick: number, extra: { credits?: number; owned?: WeaponId[]; prediction?: boolean } = {}): CombatSelf {
    const p = this.players.get(id);
    if (!p) {
      return {
        hp: 0, alive: false, weapon: 'vandal', mag: 0, reserve: 0,
        reloadUntil: 0, equipUntil: 0, respawnAt: 0, protectedUntil: 0, recoilYaw: 0, recoilPitch: 0,
        armor: 0, armorKind: null, armorPool: 0, armorRegen: false,
        credits: extra.credits ?? 0, owned: extra.owned ? [...extra.owned] : [],
        ...(extra.prediction === false ? {} : { prediction: newWeaponState() }),
        attackSerial: 0, ackFire: 0, inputSeq: 0,
      };
    }
    const a = ammoOf(p.w);
    return {
      hp: p.hp,
      alive: p.alive,
      weapon: p.w.weapon,
      mag: a.mag,
      reserve: a.reserve,
      reloadUntil: isReloading(p.w, tick) ? p.w.reloadUntil : 0,
      equipUntil: tick < p.w.equipUntil ? p.w.equipUntil : 0,
      respawnAt: p.alive || !this.autoRespawn ? 0 : p.deathTick + this.respawnTicks,
      protectedUntil: p.protectedUntil > tick ? p.protectedUntil : 0,
      recoilYaw: p.recoilYaw,
      recoilPitch: p.recoilPitch,
      armor: p.armor.points,
      armorKind: p.armor.kind,
      armorPool: p.armor.pool,
      armorRegen: p.alive && armorRegenerating(p.armor, tick),
      credits: extra.credits ?? 0,
      owned: extra.owned ? [...extra.owned] : [],
      ...(extra.prediction === false ? {} : { prediction: cloneWeaponState(p.w) }),
      attackSerial: p.w.attackSerial, ackFire: p.w.ackFire, inputSeq: p.commandSeq,
    };
  }

  /** 不克隆全部武器弹药/插值树，也不把可变权威状态借给人机。 */
  botStateOf(id: number, tick: number): BotCombatState {
    const p = this.players.get(id);
    if (!p) throw new Error(`Unknown bot combat player: ${id}`);
    const a = ammoOf(p.w), recoil = firingState(p.w, tick);
    return {
      hp: p.hp, weapon: p.w.weapon, mag: a.mag, reserve: a.reserve,
      reloadUntil: isReloading(p.w, tick) ? p.w.reloadUntil : 0,
      equipUntil: tick < p.w.equipUntil ? p.w.equipUntil : 0,
      shotYaw: recoil.yaw, shotPitch: recoil.pitch, nextFireTick: p.w.nextFireTick, aim: p.w.aim,
    };
  }

  /** 换枪请求（合法性已由 call site 校验过 weapon 是否合法）：活着且不是当前枪才换 */
  selectWeapon(id: number, weapon: WeaponId, tick: number): boolean {
    const p = this.players.get(id);
    if (!p || !p.alive || !isWeaponId(weapon) || weapon === p.w.weapon) return false;
    // 模式约束必须在切枪副作用之前检查，拒绝请求不能取消待命中的近战。
    if (this.weaponPolicy && this.weaponPolicy(id, weapon) !== weapon) return false;
    p.pendingMelee = null;
    startEquip(p.w, weapon, tick);
    this.events.push({ kind: 'equip', player: id, weapon });
    return true;
  }

  /** 检查用的只读入口：拿某个玩家的武器状态（弹药、连发序号、换弹/换枪时间） */
  weaponState(id: number): WeaponState | null {
    return this.players.get(id)?.w ?? null;
  }

  movementOf(id: number, tick: number) {
    const p = this.players.get(id);
    const weapon = p?.w.weapon ?? 'vandal';
    return { weapon, zoom: !!p?.aimHeld && !!SOURCE_WEAPONS[weapon].stability?.ads.levels.length
      && tick >= (p?.w.zoomLockUntil ?? 0) && tick >= (p?.w.equipUntil ?? 0) && !!p && !isReloading(p.w, tick) };
  }

  /** 取走并清空累积事件（每 2 tick 下发一次，发完就清，内存不累积） */
  takeEvents(): CombatEvent[] {
    if (!this.events.length) return [];
    const out = this.events;
    this.events = [];
    return out;
  }

  // —— 内部 ——

  private recordHistory(p: CPlayer, tick: number) {
    p.history.push({ tick, life: p.life, alive: p.alive, x: p.body.x, y: p.body.y, z: p.body.z, crouch: p.body.crouch });
    while (p.history.length > HISTORY_TICKS) p.history.shift();
  }

  /** 不晚于 tick 的最近一条历史位置；没有（复活后还没满 6 tick 之类）返回 null */
  private historyAt(p: CPlayer, tick: number): Hist | null {
    let best: Hist | null = null;
    for (const h of p.history) {
      if (h.tick > tick) continue;
      if (!best || h.tick > best.tick) best = h;
    }
    return best;
  }

  private respawnDue(tick: number) {
    if (!this.autoRespawn) return;
    for (const p of this.players.values()) {
      if (p.alive || !this.canRespawn(p.id) || tick < p.deathTick + this.respawnTicks) continue;
      this.revive(p, tick);
    }
  }

  /** 复活（自动复活与回合开始共用）：回复活点、重置身体 / 武器 / 历史 / 按键，life+1 隔绝旧历史 */
  private revive(p: CPlayer, tick: number) {
    const sp = this.host.respawn(p.id);
    this.host.onRespawn(p.id, sp);
    p.alive = true;
    p.hp = this.maxHpOf(p.id);
    // 护甲不随复活继承：SND 每回合重购（TDM 本来就没有护甲）
    clearArmor(p.armor);
    p.life++;
    p.spawnTick = tick;
    p.body = { x: sp.x, y: sp.y, z: sp.z, eye: EYE_STAND, crouch: 0, speed: 0, yaw: sp.yaw, pitch: 0 };
    p.pendingMelee = null;
    resetWeapon(p.w);
    if (this.weaponPolicy) p.w.weapon = this.weaponPolicy(p.id, p.w.weapon);
    p.deathTick = 0;
    p.protectedUntil = tick + this.protectTicks;
    p.recoilYaw = 0;
    p.recoilPitch = 0;
    // 复活清按键边沿（含近战重击的 aim 边沿）与轻/重节拍（resetWeapon 已把 nextFireTick 归零）
    p.fireHeld = p.fireEdge = p.reloadHeld = p.reloadEdge = false;
    p.aimHeld = p.aimEdge = false;
    p.fireEdgeSeq = p.aimEdgeSeq = 0;
    p.viewTick = 0;
    p.history.length = 0;
    p.damageLog.length = 0;
    this.events.push({ kind: 'respawn', player: p.id });
  }

  private updateWeapon(p: CPlayer, tick: number, frozen: boolean) {
    if (this.weaponPolicy) {
      const allowed = this.weaponPolicy(p.id, p.w.weapon);
      if (allowed !== p.w.weapon) this.forceWeapon(p.id, allowed, tick);
    }
    if (p.pendingMelee) {
      if (!p.alive || frozen || p.lock || p.w.weapon !== 'melee') p.pendingMelee = null;
      else if (tick >= p.pendingMelee.due) {
        const attack = p.pendingMelee.attack;
        p.pendingMelee = null;
        this.fire(p, tick, attack);
      }
    }
    const fresh = tick - p.lastInputTick < INPUT_TIMEOUT_TICKS;
    const attackSeq = fresh && p.w.weapon === 'melee' && !p.fireHeld && p.aimEdge
      ? p.aimEdgeSeq
      : fresh && p.fireEdge ? p.fireEdgeSeq : p.commandSeq;
    const result = stepWeaponInput(p.w, {
      tick, fire: fresh && p.fireHeld, firePressed: fresh && p.fireEdge,
      reloadPressed: fresh && p.reloadEdge, aim: fresh && p.aimHeld, aimPressed: fresh && p.aimEdge,
      alive: p.alive, frozen: frozen || p.lock || !fresh, commandSeq: attackSeq,
      pose: { speed: p.body.speed, grounded: p.body.grounded ?? true, crouch: p.body.crouch,
        crouchHeld: p.body.crouchHeld, walking: p.body.walking, landT: p.body.landT, landV: p.body.landV,
        tagged: p.body.tagged, tagState: p.body.tagState, tagSpeed: p.body.tagSpeed },
    });
    p.fireEdge = p.reloadEdge = p.aimEdge = false;
    const recoil = firingState(p.w, tick);
    p.recoilYaw = recoil.cameraYaw; p.recoilPitch = recoil.cameraPitch;
    if (result.reloadUntil) this.events.push({ kind: 'reload', player: p.id, weapon: p.w.weapon, until: result.reloadUntil });
    if (result.attack) {
      if (result.attack.weapon === 'melee') {
        p.protectedUntil = 0;
        p.pendingMelee = { due: tick + MELEE_HIT_TICKS, attack: result.attack };
        this.events.push({
          kind: 'meleeStart', player: p.id, attackSerial: result.attack.attackSerial,
          commandSeq: result.attack.commandSeq, heavy: result.attack.heavy,
          origin: { x: p.body.x, y: p.body.y + p.body.eye, z: p.body.z },
        });
      } else this.fire(p, tick, result.attack);
    }
  }

  private fire(p: CPlayer, tick: number, attack: WeaponAttack) {
    const def = WEAPONS[p.w.weapon], { heavy, recoil } = attack;
    const errorDegrees = attack.errorDegrees;
    const ang = def.melee
      ? { yaw: p.body.yaw, pitch: p.body.pitch }
      : shotAngles(p.body.yaw, p.body.pitch, recoil, { yaw: 0, pitch: 0 });
    const dir = aimDir(ang.yaw, ang.pitch);
    const origin: V3 = { x: p.body.x, y: p.body.y + p.body.eye, z: p.body.z };

    // 一次攻击只取一次回溯快照。致死弹丸之后的弹丸仍会被同一具身体挡住。
    const targets = this.targetsFor(p, tick);
    const rays: ShotRay[] = [];
    const count = Math.max(1, def.pelletsPerShot);

    // stepWeaponInput already consumed exactly one attack; only the authority resolves its rays.
    if (!def.melee) p.protectedUntil = 0; // 近战在动作开始时取消保护

    for (let pellet = 0; pellet < count; pellet++) {
      const direction = def.melee ? dir : pelletDirection(dir, errorDegrees, attack.errorPower, attack.spread[pellet]);
      const trace = def.melee
        ? traceMelee(this.world, origin, direction, def.range, targets)
        : traceRay(this.world, origin, direction, def.range, def.penetrationBudget, targets);
      const hit = trace.human?.id ?? null;
      const part = trace.human?.part ?? null;
      let damage = 0;
      let killed = false;
      if (trace.human) {
        const target = this.players.get(trace.human.id);
        // 队友和受保护者同样挡住每颗弹丸，但不扣血。
        if (target && target.team !== p.team && target.protectedUntil <= tick) {
          const base = def.melee
            ? meleeDamage(def, trace.human.part, heavy)
            : baseDamage(def, trace.human.part, trace.human.t);
          damage = def.melee ? base : penetrationDamage(base, trace.penetration, def.penetrationBudget);
          // 护甲：先按比例吸收（头部不走甲），剩余才扣血；护甲点在自己身上扣。
          // damageLog 仍只记「实际扣掉的 HP」——助攻阈值 ASSIST_DAMAGE 的分母不被打甲改变。
          const { healthLoss } = absorbArmor(target.armor, damage, trace.human.part, tick);
          const actualDamage = Math.min(target.hp, healthLoss);
          if (actualDamage > 0) {
            target.damageLog = target.damageLog.filter(h => tick - h.tick <= ASSIST_WINDOW_TICKS);
            target.damageLog.push({ attacker: p.id, tick, damage: actualDamage });
          }
          killed = target.hp > 0 && healthLoss >= target.hp;
          target.hp = Math.max(0, target.hp - healthLoss);
        }
      }
      rays.push({
        end: trace.end, hit, part, damage, killed,
        penetrated: !def.melee && trace.penetration.penetrated,
        impacts: def.melee ? [] : trace.penetration.impacts,
      });
    }

    this.events.push({
      kind: 'shot',
      id: ++this.shotSeq,
      shooter: p.id,
      weapon: def.id,
      attackSerial: attack.attackSerial, commandSeq: attack.commandSeq,
      origin,
      rays,
      ...(def.melee ? { heavy } : {}),
    });

    // shot 先于 death；每个目标只有一次从正血量跨到 0，不重复计分或清理身体。
    for (const ray of rays) {
      if (ray.killed) this.kill(this.players.get(ray.hit!)!, p, tick);
    }
    if (def.melee) {
      for (const ray of rays) {
        if (ray.damage > 0 && ray.hit !== null) this.host.onMeleeHit?.(p.id, ray.hit, ray.damage, tick);
      }
    }
  }

  private kill(victim: CPlayer, killer: CPlayer, tick: number) {
    if (!victim.alive || victim.id === killer.id || victim.team === killer.team) return;
    const helpers = new Map<number, number>();
    for (const h of victim.damageLog) {
      if (h.attacker === killer.id || tick - h.tick > ASSIST_WINDOW_TICKS) continue;
      const helper = this.players.get(h.attacker);
      if (!helper || helper.team !== killer.team) continue;
      helpers.set(helper.id, (helpers.get(helper.id) ?? 0) + h.damage);
    }
    for (const [id, damage] of helpers) if (damage >= ASSIST_DAMAGE) this.players.get(id)!.assists++;
    victim.damageLog.length = 0;
    this.teamKills[killer.team]++;
    killer.kills++;
    this.die(victim, killer.id, killer.w.weapon, tick);
  }

  /**
   * 仅测试 / 调试入口（自杀）：让某人立刻阵亡，走与真实击杀**完全相同**的死亡路径（观战验收脚本用：
   * 人机不一定打得中站在出生点的真人，死亡时机必须可控）。
   * 真实对局里没有任何调用点：只有 server/match.ts 在 opts.manual（手动推进的测试对局）下转进来；
   * 网络层没有任何消息能到达这里。不计任何人的击杀数，death 事件里的 killer 记成死者自己。
   */
  slay(id: number): boolean {
    const p = this.players.get(id);
    if (!p || !p.alive) return false;
    p.damageLog.length = 0;
    this.die(p, id, p.w.weapon, this.tick);
    return true;
  }

  /** 死亡落地（真实击杀与测试自杀共用）：清动作 / 护甲 / 按键，通知 match，发一次 death 事件 */
  private die(victim: CPlayer, killerId: number, weapon: WeaponId, tick: number) {
    victim.alive = false;
    victim.pendingMelee = null;
    victim.hp = 0;
    victim.deathTick = tick;
    victim.deaths++;
    // 死亡清「连续开火」状态与全部按键边沿（含近战 aim / 重击边沿）；
    // 轻/重节拍（nextFireTick）不动——它由复活时的 resetWeapon 清零，与「复活重置当前武器/弹药」同一处
    cancelWeaponActions(victim.w);
    // 死亡：武器与护甲全丢（下一回合 / 复活后重购）
    clearArmor(victim.armor);
    victim.recoilYaw = victim.recoilPitch = 0;
    victim.fireHeld = victim.fireEdge = victim.reloadHeld = victim.reloadEdge = false;
    victim.aimHeld = victim.aimEdge = false;
    victim.fireEdgeSeq = victim.aimEdgeSeq = 0;
    this.host.onDeath(victim.id);
    this.events.push({ kind: 'death', player: victim.id, killer: killerId, weapon });
  }

  /** 射线目标：其他所有活人（含队友：挡枪但不扣血），位置按射手「所见 tick」回溯 */
  private targetsFor(shooter: CPlayer, tick: number): HumanCandidate[] {
    const vt = clampViewTick(shooter.viewTick, tick);
    const out: HumanCandidate[] = [];
    for (const t of this.players.values()) {
      if (t.id === shooter.id || !t.alive) continue;
      const h = this.historyAt(t, vt);
      // 死亡 / 新生命不能被旧历史击中：life 变了，或「所见时刻」早于这具身体的出生 tick（复活清历史后的兜底）
      if (vt < t.spawnTick || !h || h.life !== t.life || !h.alive) continue;
      out.push({ id: t.id, x: h.x, y: h.y, z: h.z, crouch: h.crouch });
    }
    return out;
  }
}