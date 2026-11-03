// match.ts — 权威对局循环（32 Hz，每个 tick 4 个 1/128 s 物理子步）：玩家输入消费、移动模拟、人机移动、快照下发
//
//   流程：createMatch → 异步加载世界（碰撞 BVH）+ 导航网格 → 所有真人发来 loaded（或 60 秒超时）→ 解冻开打
// 真人：有界 FIFO 保留每条移动命令的时间；按服务器时间补充预算，每 tick 最多补算两条。
// 人机：每 tick 由 BotBrain 产生普通移动/射击/换弹指令，走同一份 stepPlayer 与 CombatSystem。
//   快照：每个 tick（32 Hz）给每个真人发一份（自己的完整状态 + 其他人）
//   战斗：每个 tick 移动完之后调 combat.advance 一次（射速、命中、伤害、死亡、复活都在 server/combat.ts）；
//        每 2 tick（16 Hz）给每个真人发一份 CombatUpdate（自己的 CombatSelf + 这两 tick 的事件，死者也收）
//   爆破：回合机在 server/snd.ts（只做规则）；团队死斗：整场机在 server/tdm.ts（准备期 / 570 秒计时 / 击杀目标）。
//   本文件负责复活 / 锁枪 / 定身 / 人机任务 / 广播接线。
//   观战（阶段11，仅爆破 SND）：死者自动跟随就近存活队友（规则在 shared/spectate.ts），每 tick 把观战目标写进快照帧头；
//         `[ / ]` / 触屏左右按钮走 spectateNext / spectatePrev 命令循环切换。快照只发自己 + 队友的 hp / armor；
//         公开 shot 向双方发送以呈现弹道和空间枪声，个人武器状态与敌方血量 / 护甲另行隔离。
import { randomUUID } from 'node:crypto';
import type { Team } from '../shared/catalog.ts';
import type { SquadMate, V3 } from '../shared/combat.ts';
import type { MatchBoard, Member, SndMatchSummary, TdmMatchSummary } from '../shared/lobby.ts';
import type { P3 } from '../shared/mapdata.ts';
import type { WeaponId } from '../shared/combat.ts';
import {
  addCredits, ARMOR, armorKindCode, buyFailText, buyOkText, buyPrice, ECONOMY, isFreeItem,
  nextLossStreak, roundReward, SND_DEFAULT_SIDEARM, type BuyFailReason, type BuyItem,
} from '../shared/economy.ts';
import { SND, type SndEvent, type SndView } from '../shared/snd.ts';
import { INFECTION, infectionSpeedMultiplier } from '../shared/infection.ts';
import { TDM, tdmTicks, type TdmEvent, type TdmView } from '../shared/tdm.ts';
import { BTN, decodeInput, encodeSnapshot, quantYaw, EF_ALIVE, EF_GROUNDED, EF_TEAM1, type EntitySnap, type UserCmd } from '../shared/protocol.ts';
import { cycleSpectateTarget, nearestSpectateTarget, spectateOrder, type SpectateMate } from '../shared/spectate.ts';
import { eyeHeight, newMoveState, speed2, type MoveState } from '../shared/sim/movement.ts';
import { stepPlayer } from '../shared/sim/player.ts';
import { negotiatedRopesFor } from '../shared/rope.ts';
import { TICK_DT, TICK_RATE } from '../shared/sim/tick.ts';
import { weaponSlot } from '../shared/sim/weapons.ts';
import { CombatSystem, type CombatBody, type RespawnPoint } from './combat.ts';
import type { Client, Lobby, MatchHandle, Room } from './lobby.ts';
export interface MatchHost {
  clients: Map<number, Client>;
  broadcastRoom(room: Room): void;
  endMatch(room: Room): void;
}
import { getMapData, inSite, sitePoint } from './mapdata.ts';
import { loadNav, type Nav } from './nav.ts';
import { BotBrain, botBuyPlan, botSightMetrics, type BotActor } from './bot.ts';
import { BotSquad, type BotMission } from './bot-team.ts';
import { hashSeed } from './bot-persona.ts';
import { buildZonePlan, prepareCoverGraph, postPlantCoverPoints, type CoverPoint, type TacticsZone } from './bot-tactics.ts';
import { BotWorkBudget } from './bot-work.ts';
import { SndRules, type SndActor } from './snd.ts';
import { TdmRules } from './tdm.ts';
import { InfectionRules } from './infection.ts';
import { acquireWorld, WorldLoadCancelled, type ServerWorld, type WorldLease, type QueueState } from './world.ts';
import { pickSpawn } from './spawn.ts';
import { addPump, removePump, type RoomPump } from './room-pump.ts';
import { PlayerInputBuffer } from './player-input.ts';

const SNAPSHOT_EVERY = 1;
/** CombatUpdate 下发间隔（tick）：16 Hz */
const COMBAT_EVERY = 2;
/** 落后时每次回调最多补两帧，让其它房间、网络和计时器及时执行。 */
const MAX_CATCHUP_STEPS = 2;
const MEASURE_STAGES = process.env.PERF_METER === '1';

const LOAD_TIMEOUT_MS = 60000;
/** 使用键（E）在最近这么多 tick 内有过命令才算仍按着；断流即视为松开 */
const USE_FRESH_TICKS = 8;

/** 1.2.1 起 combat 包使用紧凑同步：完整武器快照只在重置点 / 每秒关键帧下发。 */
function supportsCompactCombat(build: string): boolean {
  const a = String(build ?? '').split('.').map((v) => Number.parseInt(v, 10) || 0);
  const b = [1, 2, 1];
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (a[i] ?? 0) > b[i];
  }
  return true;
}

interface Player {
  id: number;
  member: Member;
  team: Team;
  bot: boolean;
  /** 队内序号：重生点按它取（与出生时同一个点） */
  indexInTeam: number;
  s: MoveState;
  yaw: number;
  pitch: number;
  hp: number;
  alive: boolean;
  /** 爆破经济：余额（TDM 恒为 0） */
  credits: number;
  /** 爆破经济：本回合买下的主武器（null = 只有随身手枪）；每回合开始重购 */
  primary: WeaponId | null;
  /** 爆破经济：本回合的副武器（默认免费手枪 classics；每回合开始重置） */
  secondary: WeaponId;
  /** 人机：本回合的购买计划是否已经执行过（每回合重置） */
  botBought: boolean;
  /** 最后实际消费的序号；真人输入按命令时间排队，不按网络包合并移动。 */
  lastSeq: number;
  input: PlayerInputBuffer;
  /** 使用键（E）：最近一次消费的命令里是否按着、何时消费的（爆破安放 / 拆除用） */
  use: boolean;
  useTick: number;
  /** 人机：自己的命令序号与寻路状态 */
  brain: BotBrain | null;
  /** 观战（阶段11）：服务器指定的观战目标（队友 pid）；null = 未观战（活着，或没有存活队友 → 自由转头） */
  spectate: number | null;
}

/** opts.manual：测试用，不起墙钟循环，由 handle.advance(n) 手动推进。
 *  返回值里额外带一个 testSlay（**仅 manual 模式**，见实现处注释）：验收脚本要一个可控的「自杀」时机。 */
export function createMatch(room: Room, lobby: MatchHost, opts: { manual?: boolean; world?: ServerWorld } = {}): MatchHandle & { testSlay?(id: number): void } {
  const settings = room.settings;
  const statsId = randomUUID();
  const sentStats = new Map<number, string>();
  const snapshotPlayers: Player[] = [];
  const snapshotEntities: EntitySnap[] = [];
  const snapshotOthers: EntitySnap[] = [];
  const snapshotMasks: [EntitySnap[], EntitySnap[]] = [[], []];
  let lastBoardSignature = '';
  const mapData = getMapData(settings.map);
  const sites = Object.keys(mapData.snd.sites);
  // 人机人格：每局按对局种子与座位名单生成一次（同一局可复现，不同局打法不同）
  const bots = room.members.filter((x): x is Member & { team: Team } => x.bot && x.team !== -1).map(x => ({ id: x.id, team: x.team }));
  const squad = new BotSquad(hashSeed(statsId), bots, settings.mode === 'snd' ? sites.length : 0);
  const patrols = sites.map(site => sitePoint(mapData, site));
  /** 爆破回合机（只在爆破模式存在）：规则在 server/snd.ts，这里把它接到复活 / 锁枪 / 定身 / 广播 / 人机任务上 */
  const snd: SndRules | null = settings.mode === 'snd'
    ? new SndRules({ scoreLimit: settings.scoreLimit, sites, siteAt: (x, y, z) => inSite(mapData, x, y, z) })
    : null;
  /** 爆破：上一次回合机推进后的回合视图（人机任务与战斗广播共用） */
  let sndView: SndView | null = null;
  /** 爆破经济：每人本回合已拥有的武器（主 / 副 / 刀）+ 余额扣款、回合奖金都在下面几个函数里 */
  const loadoutOf = (p: Player): WeaponId[] => {
    if (!snd) return []; // TDM 免费切枪：不受拥有关系限制
    const out: WeaponId[] = ['melee', p.secondary];
    if (p.primary) out.push(p.primary);
    return out;
  };
  /** 回合开始 / 重生：清空买来的装备与护甲（护甲在 CombatSystem.revive 里清） */
  const resetLoadout = (p: Player) => {
    p.primary = null;
    p.secondary = SND_DEFAULT_SIDEARM;
    p.botBought = false;
  };
  /** 经典生化整场机：prepare → active → ended；感染状态单独按 JSON 下发。 */
  const infection: InfectionRules | null = settings.mode === 'infection' ? new InfectionRules() : null;
  let infectionStateReady = false;
  let infectionEnded = false;
  let lastInfectionBroadcastTick = -Infinity;
  const players = new Map<number, Player>();
  const tdm: TdmRules | null = settings.mode === 'tdm' ? new TdmRules({ target: settings.scoreLimit }) : null;
  /** 团队死斗：上一次整场机推进后的视图（随 CombatUpdate 下发） */
  let tdmView: TdmView | null = null;
  let resultTimer: NodeJS.Timeout | null = null;
  const loaded = new Set<number>();
  let botCount = 0;
  /** 已经收到过完整武器快照的真人：加入后的第一份 combat 必须带完整快照，不能等下一个 1 秒关键帧。 */
  const weaponKeyframesSent = new Set<number>();
  let world: ServerWorld | null = null;
  let nav: Nav | null = null;
  let coverGraph: readonly CoverPoint[] = [];
  /** 安包后守包点按包点/阵营缓存，避免每个 Bot 每 tick 重新过滤排序 384 个掩体点 */
  const postPlantPoints = new Map<string, V3[]>();
  /** 出生点中心是静态的，按队伍缓存 */
  const spawnCenters = new Map<Team, V3>();
  /** 拆包告警每 tick 只写一次小队黑板，不随 Bot 数量重复写 */
  let defuseReportTick = -1;
  /** T1：区域默认点位表（按包点切区，开局建一次，不在局中重抽） */
  let zonePlan: readonly TacticsZone[] = [];
  let tacticsReady = false;
  const botWork = new BotWorkBudget(opts.manual ? null : undefined);
  let combat: CombatSystem | null = null;
  let diagBotMs = 0, diagSightMs = 0, diagSightRays = 0, diagMoveMs = 0, diagCombatMs = 0, diagBroadcastMs = 0;
  let diagInputMax = 0, diagInputTotal = 0, diagInputSamples = 0;
  const diagTickSamples = MEASURE_STAGES ? new Float32Array(2048) : null;
  let tick = 0;
  let frozen = true;
  let disposed = false;
  let registered = false;

  /** 生化沿用独立出生区；团队死斗固定对应爆破初始进攻 / 防守出生区。 */
  const spawnsFor = (team: Team): P3[] => {
    if (settings.mode === 'infection') return team === 0 ? mapData.tdm.BL : mapData.tdm.GR;
    const attacking = snd ? team === snd.attackTeam() : team === 0;
    return attacking ? mapData.snd.spawns.attack.spawns : mapData.snd.spawns.defend.spawns;
  };

  /** 紧凑错位 + 实际落脚面 + 身体净空；与实图回归共用同一份出生选择。 */
  function spawnPoint(team: Team, index: number): { x: number; y: number; z: number; yaw: number } {
    const list = spawnsFor(team), base = list[index % list.length];
    if (!world) return { ...base, yaw: base.yaw ?? 0 };
    return pickSpawn(world, list, spawnsFor(team === 0 ? 1 : 0), index,
      [...players.values()].filter(p => p.alive).map(p => p.s), nav);
  }

  /** dead：爆破回合中途加入（只能观战，下一回合开始复活） */
  function addPlayer(m: Member, indexInTeam: number, dead = false) {
    if (m.team === -1) return;
    const sp = spawnPoint(m.team, indexInTeam);
    const p: Player = {
      id: m.id,
      member: m,
      team: m.team,
      bot: m.bot,
      indexInTeam,
      s: newMoveState(sp.x, sp.y, sp.z),
      yaw: quantYaw(sp.yaw),
      pitch: 0,
      hp: dead ? 0 : 100,
      alive: !dead,
      credits: snd ? ECONOMY.startCredits : 0,
      primary: null,
      secondary: SND_DEFAULT_SIDEARM,
      botBought: false,
      lastSeq: 0,
      input: new PlayerInputBuffer(),
      use: false,
      useTick: 0,
      spectate: null,
      brain: m.bot ? new BotBrain(m.difficulty ?? settings.botDifficulty, squad.personaOf(m.id) ?? null) : null,
    };
    players.set(m.id, p);
    if (m.bot) botCount++;
    combat?.add(m.id, m.team, m.bot, dead);
    combat?.setLock(m.id, lockedNow(m.id));
    if (!m.bot) {
      const c = lobby.clients.get(m.id);
      if (c) c.onBinary = (buf) => onInput(p, buf);
    }
  }

  /** 使用键：只在命令被消费时更新（断流超过 USE_FRESH_TICKS 即视为松开） */
  function noteUse(p: Player, buttons: number) {
    p.use = (buttons & BTN.use) !== 0;
    p.useTick = tick;
  }

  function onInput(p: Player, buf: Uint8Array) {
    const cmds = decodeInput(buf);
    if (!cmds) return;
    // 只要收到包就算「有输入」：失联判定据此松开 fire/reload，避免最后一条命令一直连射
    combat?.noteInput(p.id, tick);
    for (const c of cmds) p.input.push(c);
  }

  /** 爆破：人机这一 tick 的任务（按回合阶段与持包 / 包的状态派发；购买 / 结算 / 整场结束不派） */
  /** 守点点位：人格有站点就守它（与守点手 / 潜伏手一致），没有则按座位轮流 */
  function guardPoint(p: Player) {
    const site = squad.personaOf(p.id)?.site ?? -1;
    return sitePoint(mapData, sites[(site >= 0 ? site : p.indexInTeam) % sites.length]);
  }

  /** 敌方出生点中心：守包时人机朝这里看，回防 / 包抄都从这个方向来 */
  function spawnCenter(team: Team): V3 {
    const hit = spawnCenters.get(team);
    if (hit) return hit;
    const list = spawnsFor(team);
    let x = 0, y = 0, z = 0;
    for (const s of list) { x += s.x; y += s.y; z += s.z; }
    const n = Math.max(1, list.length);
    const center = { x: x / n, y: y / n, z: z / n };
    spawnCenters.set(team, center);
    return center;
  }

  /** 安包后守包点：按角度均匀分布在包点周围的掩体点，避免全队挤在包点中心 */
  function postPlantPoint(p: Player, center: V3, attacker: boolean): V3 {
    if (!coverGraph.length) return center;
    const key = `${center.x.toFixed(1)}:${center.y.toFixed(1)}:${center.z.toFixed(1)}:${attacker ? 1 : 0}`;
    let points = postPlantPoints.get(key);
    if (!points) {
      points = postPlantCoverPoints(center, coverGraph, attacker);
      postPlantPoints.set(key, points);
    }
    if (!points.length) return center;
    const idx = (p.indexInTeam >= 0 ? p.indexInTeam : Math.abs(p.id)) + (attacker ? 0 : 2);
    return points[idx % points.length];
  }

  function missionOf(p: Player): BotMission | undefined {
    if (!snd || !sndView) return undefined;
    const v = sndView;
    const atk = v.attack;
    const plan = sitePoint(mapData, snd.plannedSite());
    // 某队活人里离 at 最近的那个（捡包 / 拆包各只派一人，其余人守点或推进）
    const nearestOf = (team: Team, at: { x: number; z: number }): number => {
      let best = -1, bestD = Infinity;
      for (const q of players.values()) {
        if (!q.alive || q.team !== team) continue;
        const d = Math.hypot(q.s.x - at.x, q.s.z - at.z);
        if (d < bestD) { bestD = d; best = q.id; }
      }
      return best;
    };
    if (v.phase === 'live') {
      if (p.team !== atk) return { kind: 'guard', point: guardPoint(p), use: false, phase: 'live' };
      if (v.spike === 'carried' && v.carrier === p.id) return { kind: 'plant', point: plan, use: true };
      if (v.spike === 'dropped' && v.spikeAt && nearestOf(atk, v.spikeAt) === p.id) return { kind: 'pickup', point: { ...v.spikeAt }, use: false };
      return { kind: 'push', point: plan, use: false };
    }
    if (v.phase === 'planted' && v.site && v.spikeAt) {
      const center = sitePoint(mapData, v.site);
      const face = spawnCenter(p.team === 0 ? 1 : 0);
      const defusing = v.channel === 'defuse';
      const urgent = v.phaseEnd - tick <= tdmTicks(10) || v.defuseTicks >= tdmTicks(SND.defuseCheckpointSec) || defusing;
      if (p.team !== atk) {
        if (nearestOf(p.team, v.spikeAt) === p.id)
          return { kind: 'defuse', point: { ...v.spikeAt }, use: true, face: center, urgent };
        return { kind: 'guard', point: postPlantPoint(p, center, false), use: false, phase: 'planted', face };
      }
      // 进攻方守包：分散到包点周围掩体；有人在拆包时全部看向包
      return { kind: 'guard', point: postPlantPoint(p, center, true), use: false, phase: 'planted', face: defusing ? center : face };
    }
    return undefined;
  }

  // ———— 爆破经济：购买（余额 / 购买窗 / 槽位 / 护甲） ————

  /**
   * 购买核心（真人命令与人机计划共用）：逐条校验，成功则扣款并立即装备。
   *   · 只在爆破模式、且回合机处于购买窗（buy 阶段，30 秒）内；
   *   · 阵亡时不能买（本回合已淘汰，等下一回合）；
   *   · 余额不足 / 该槽位已是这件装备 → 拒绝（**不退款**：换枪与换甲都是重新买）。
   * 返回失败原因，成功时 reason 为 null。
   */
  function tryBuy(p: Player, item: BuyItem): { ok: boolean; price: number; reason: BuyFailReason | null } {
    const price = buyPrice(item);
    if (!snd || !combat) return { ok: false, price, reason: 'not-snd' };
    if (!p.alive) return { ok: false, price, reason: 'not-alive' };
    if (!snd.buyWindowOpen()) return { ok: false, price, reason: 'window-closed' };
    if (item.type === 'armor') {
      const cur = combat.armorOf(p.id);
      const def = ARMOR[item.id];
      // 同一档且甲 / 再生池都满 → 没必要重买；甲被打碎后可以再买一次补满（照 CS 的「重新买甲」口径）
      if (cur && cur.kind === item.id && cur.points >= def.points && cur.pool >= def.pool)
        return { ok: false, price, reason: 'already-owned' };
      if (p.credits < price) return { ok: false, price, reason: 'insufficient-credits' };
      p.credits = addCredits(p.credits, -price);
      combat.setArmor(p.id, item.id);
      return { ok: true, price, reason: null };
    }
    const slot = weaponSlot(item.id);
    // 刀与免费手枪是随身装备，不需要也不允许再买一次（价格本来就是 0）
    if (isFreeItem(item) || (slot === 1 && p.primary === item.id) || (slot === 2 && p.secondary === item.id))
      return { ok: false, price, reason: 'already-owned' };
    if (p.credits < price) return { ok: false, price, reason: 'insufficient-credits' };
    p.credits = addCredits(p.credits, -price);
    if (slot === 1) p.primary = item.id;
    else p.secondary = item.id;
    // 买完立即装备（同一 tick 的发改包已包含它；换枪的 equip 锁定同正常切枪）
    combat.selectWeapon(p.id, item.id, tick);
    return { ok: true, price, reason: null };
  }

  /** 真人的 buy 命令（大厅转进来）：无论成交与否都回一份 buyResult（含中文提示与最新余额） */
  function handleBuy(id: number, item: BuyItem) {
    const p = players.get(id);
    if (!p || p.bot) return;
    const res = tryBuy(p, item);
    const message = res.ok
      ? buyOkText(item, res.price, p.credits)
      : buyFailText(res.reason as BuyFailReason, item, p.credits);
    lobby.clients.get(id)?.send({
      t: 'buyResult', ok: res.ok, item, price: res.price, credits: p.credits, message,
      ...(res.reason ? { reason: res.reason } : {}),
    });
  }

  /** 人机购买：按余额分层（保底 eco / 半起 / full buy），同一档内随机选枪；每回合只买一次 */
  function botBuy(p: Player) {
    if (!snd || !combat || p.botBought) return;
    p.botBought = true;
    const plan = botBuyPlan(p.credits, squad.personaOf(p.id));
    for (const item of plan) {
      const res = tryBuy(p, item);
      if (!res.ok) continue;
    }
  }

  function botCmd(p: Player, actors: readonly BotActor[]): UserCmd {
    let cs = combat!.botStateOf(p.id, tick);
    const enemySpawns = spawnsFor(p.team === 0 ? 1 : 0);
    // 安包后有人在拆包：进攻方共享一条“包点有动静”，守包人机才会从掩体转向包点
    if (sndView?.phase === 'planted' && sndView.channel === 'defuse' && sndView.spikeAt && defuseReportTick !== tick) {
      squad.report(sndView.attack, sndView.spikeAt, tick);
      defuseReportTick = tick;
    }
    // 爆破：购买阶段先按余额把装备买了（人机不在购买窗里走动，与冻结同样不出命令）
    if (snd && sndView?.phase === 'buy') botBuy(p);
    // 爆破：购买 / 结算 / 整场结束时人机站着不动（与冻结同样不出命令）
    const phase = sndView?.phase;
    const hold = frozen || phase === 'buy' || phase === 'end' || phase === 'over' || (!!tdm && tdm.lockOf());
    const persona = squad.personaOf(p.id);
    const ws = combat!.weaponState(p.id);
    const ammoOf = (w: WeaponId) => (ws ? ws.ammo[w].mag + ws.ammo[w].reserve : 0);
    // 弹药用尽按正常换枪流程取备用枪（人格的副枪优先），全部耗尽后用刀；不凭空补弹。
    if (!frozen && cs.mag === 0 && cs.reserve === 0 && cs.weapon !== 'melee') {
      const usable = (w: WeaponId) => w !== cs.weapon && ammoOf(w) > 0;
      const next = persona && usable(persona.sidearm) ? persona.sidearm
        : (persona || cs.weapon === 'vandal') && usable('ghost') ? 'ghost' : 'melee';
      combat!.selectWeapon(p.id, next, tick);
      cs = combat!.botStateOf(p.id, tick); // AI 当帧读到真实的新枪及装备锁定，不继续按旧枪开火。
    }
    // 人格想换的枪（狙击手贴脸换副枪、拉开后换回主枪）：有弹药才换，购买 / 结算期间不换
    const want = infection?.isInfected(p.id) ? null : p.brain?.wantedWeapon() ?? null;
    if (!hold && want && want !== cs.weapon && ammoOf(want) > 0) {
      combat!.selectWeapon(p.id, want, tick);
      cs = combat!.botStateOf(p.id, tick);
    }
    // squad.context 每次都返回新对象；直接补上本 tick 的任务 / 掩体图 / 预算，省掉一次展开拷贝。
    const context = squad.context(p.team, tick, world!.pawn, patrols, p.id);
    context.strategy = infection?.isInfected(p.id) ? 'infected' : 'tactical';
    context.mission = missionOf(p); context.covers = coverGraph; context.work = botWork; context.zones = zonePlan;
    return p.brain!.command(p, actors, tick, hold, world!.projectile, nav, cs,
      enemySpawns[p.indexInTeam % enemySpawns.length], context);
  }

  /** 中途加入的出生保护（tick，与复活保护同长）：加入瞬间正在打的人不能直接把他带走；爆破没有保护 */
const JOIN_PROTECT_TICKS = tdmTicks(TDM.protectSec);
/** 战斗系统需要的外部动作：重生点 / 死亡清场 / 复活重置（seq 不重置，保持单调） */
  function syncInfectionRoles() {
    if (!infection || !combat) return;
    for (const p of players.values()) {
      const infected = infection.isInfected(p.id);
      const team: Team = infected ? 1 : 0;
      const roleChanged = p.team !== team;
      const weapon = combat.weaponState(p.id)?.weapon;
      const needsInfectedSetup = infected && weapon !== 'melee';
      if (roleChanged || needsInfectedSetup) {
        if (infected && roleChanged) {
          p.brain?.reset();
          squad.forget(p.id);
        }
        p.team = team;
        combat.setTeam(p.id, team);
        combat.forceWeapon(p.id, infected ? 'melee' : 'vandal', tick);
        if (infected && p.alive) combat.setHealth(p.id, INFECTION.infectedHp);
      }
    }
    syncLocks();
  }
  function broadcastInfection(force = false, stateTick = tick) {
    if (!infectionStateReady || !infection) return;
    if (!force && tick - lastInfectionBroadcastTick < TICK_RATE) return;
    lastInfectionBroadcastTick = tick;
    const state = infection.view(stateTick);
    for (const m of room.members) if (!m.bot) lobby.clients.get(m.id)?.send(state);
  }


  const combatHost = {
    respawn: (id: number): RespawnPoint => {
      const p = players.get(id);
      if (!p) return { x: 0, y: 0, z: 0, yaw: 0 };
      return spawnPoint(p.team, p.indexInTeam);
    },
    onDeath: (id: number) => {
      squad.forget(id);
      const p = players.get(id);
      if (!p) return;
      snd?.release(id, { x: p.s.x, y: p.s.y, z: p.s.z }); // 持包者死亡：包掉在死亡位置
      // 死亡：清移动速度、清待处理输入
      p.s.vx = 0;
      p.s.vz = 0;
      p.s.vy = 0;
      p.s.rope = -1; // 死在绳上：脱绳（复活时本来就是整份重置）
      p.s.ropeT = 0;
      p.input.clear();
      p.use = false;
      p.brain?.reset();
    },
    onMeleeHit: (attacker: number, victim: number, damage: number, hitTick: number) => {
      if (!infection || damage <= 0 || !infection.isInfected(attacker)) return;
      if (!infection.infect(victim)) return;
      syncInfectionRoles();
      broadcastInfection(true, hitTick);
    },
    onRespawn: (id: number, sp: RespawnPoint) => {
      squad.forget(id);
      const p = players.get(id);
      if (!p) return;
      p.s = newMoveState(sp.x, sp.y, sp.z);
      p.yaw = quantYaw(sp.yaw);
      p.pitch = 0;
      if (infection?.isInfected(id)) combat?.setHealth(id, INFECTION.infectedHp);
      p.brain?.reset();
      p.input.clear();
      p.use = false;
    },
  };

  /** 移动之后把权威身体写进战斗系统（脚底坐标 + 眼高 + 水平速度，射线起点用服务器自己的数据） */
  function syncBody(p: Player) {
    const body: CombatBody = {
      x: p.s.x,
      y: p.s.y,
      z: p.s.z,
      eye: eyeHeight(p.s),
      crouch: p.s.crouch,
      speed: speed2(p.s),
      grounded: p.s.grounded,
      landT: p.s.landT >= 0 ? tick * TICK_DT - (p.lastSeq * TICK_DT - p.s.landT) : undefined,
      landV: p.s.landV,
      tagged: p.s.tag >= 0,
      yaw: p.yaw,
      pitch: p.pitch,
    };
    combat?.setBody(p.id, body);
  }

  function step() {
    if (!world) return;
    tick++;
    botWork.begin(tick);
    // 感知取本tick开始时的身体副本，避免玩家遍历顺序改变人机看到的位置。
    // Bot perception needs a tick-start copy; human-only rooms have no consumer for this allocation.
    const actors: BotActor[] = botCount ? [...players.values()].map((p) => ({ id: p.id, team: p.team, alive: p.alive, s: { ...p.s }, yaw: p.yaw, pitch: p.pitch })) : [];
    for (const p of players.values()) {
      if (!p.bot) {
        if (MEASURE_STAGES) {
          diagInputMax = Math.max(diagInputMax, p.input.size);
          diagInputTotal += p.input.size;
          diagInputSamples++;
        }
        p.input.beginTick();
      }
      if (!p.alive) {
        // 死亡：不移动；消费最新命令以继续推进 ACK，不回放旧移动或延迟动作。
        if (!p.bot) {
          const c = p.input.clear();
          if (c) {
            const commandStarted = MEASURE_STAGES ? performance.now() : 0;
            combat?.onCommand(p.id, { ...c, buttons: 0 }, tick);
            if (MEASURE_STAGES) diagCombatMs += performance.now() - commandStarted;
            p.lastSeq = c.seq;
          }
        }
        continue;
      }
      if (p.bot) {
        const decisionStarted = MEASURE_STAGES ? performance.now() : 0;
        const sightMs = botSightMetrics?.ms ?? 0, sightRays = botSightMetrics?.rays ?? 0;
        const cmd = botCmd(p, actors);
        if (MEASURE_STAGES) {
          diagBotMs += performance.now() - decisionStarted;
          diagSightMs += (botSightMetrics?.ms ?? 0) - sightMs;
          diagSightRays += (botSightMetrics?.rays ?? 0) - sightRays;
        }
        p.yaw = cmd.yaw; p.pitch = cmd.pitch;
        noteUse(p, cmd.buttons);
        const commandStarted = MEASURE_STAGES ? performance.now() : 0;
        combat?.onCommand(p.id, cmd, tick);
        const moveStarted = MEASURE_STAGES ? performance.now() : 0;
        if (MEASURE_STAGES) diagCombatMs += moveStarted - commandStarted;
        const movement = combat!.movementOf(p.id, tick);
        stepPlayer(p.s, cmd, frozen || !!snd?.rootedOf(p.id), world.pawn, movement.weapon, movement.zoom, world.climbRopes, infection ? infectionSpeedMultiplier(p.team) : 1);
        if (MEASURE_STAGES) diagMoveMs += performance.now() - moveStarted;
        p.lastSeq = cmd.seq;
        continue;
      }
      if (!p.input.size) continue;
      const ropes = negotiatedRopesFor(settings.map, lobby.clients.get(p.id)?.mapRopeRevision);
      for (let frame; (frame = p.input.take());) {
        const c = frame.command;
        p.yaw = c.yaw;
        p.pitch = c.pitch;
        noteUse(p, c.buttons);
        const commandStarted = MEASURE_STAGES ? performance.now() : 0;
        combat?.onCommand(p.id, c, tick, frame.pressed, frame);
        const moveStarted = MEASURE_STAGES ? performance.now() : 0;
        if (MEASURE_STAGES) diagCombatMs += moveStarted - commandStarted;
        const movement = combat!.movementOf(p.id, tick);
        stepPlayer(p.s, c, frozen || !!snd?.rootedOf(p.id), world.pawn, movement.weapon, movement.zoom, ropes, infection ? infectionSpeedMultiplier(p.team) : 1);
        if (MEASURE_STAGES) diagMoveMs += performance.now() - moveStarted;
        p.lastSeq = c.seq;
      }
    }
    const combatStarted = MEASURE_STAGES ? performance.now() : 0;
    for (const p of players.values()) syncBody(p);
    // 移动之后推进武器一次：命中判定、伤害、死亡、复活都在这里
    combat?.advance(tick, frozen);
    syncStatus();
    let infectionPhaseChanged = false;
    if (infection && !frozen) {
      const previousPhase = infection.phaseNow();
      infection.advance(tick);
      infectionPhaseChanged = previousPhase !== infection.phaseNow();
      syncInfectionRoles();
      infectionStateReady = true;
      if (infection.phaseNow() === 'ended' && !infectionEnded) {
        infectionEnded = true;
        endWithResult(infection.winnerNow() ?? -1, null, TDM.resultSec);
      }
    }
    broadcastInfection(infectionPhaseChanged);
    // 爆破：回合机在战斗推进之后判定（死亡 / 持包 / 读条 / 胜负），事件同 tick 下发
    if (snd && !frozen) applySnd(snd.step(tick, sndActors()));
    if (tdm && combat && !frozen) applyTdm(tdm.step(tick, combat.teamKillsOf()));
    if (MEASURE_STAGES) diagCombatMs += performance.now() - combatStarted;
  }

  function syncStatus() {
    for (const p of players.values()) {
      const st = combat?.status(p.id);
      if (st) {
        p.hp = st.hp;
        p.alive = st.alive;
      }
    }
    syncSpectate();
  }

  // ———— 观战（阶段11）：死亡后跟随队友第一人称 ————

  /** 本队存活队友名单：顺序 = 玩家表顺序（`[ / ]` 循环切换、观战 HUD 队友列表、自动选目标都是这同一份口径） */
  function spectateMates(): SpectateMate[] {
    return [...players.values()].map((q) => ({ id: q.id, team: q.team, alive: q.alive, x: q.s.x, y: q.s.y, z: q.s.z }));
  }

  /** 自动选目标（产品决策 4）：离死者最近的存活队友（欧氏距离）；没有存活队友 → null（回落死亡点自由转头） */
  function pickSpectate(p: Player): number | null {
    return nearestSpectateTarget({ x: p.s.x, y: p.s.y, z: p.s.z }, spectateMates(), p.id, p.team);
  }

  /**
   * 每 tick 维护观战目标：活着 → 清空；死了且目标已阵亡 / 已离场 → 重新就近挑一个；
   * 没有存活队友时保持 null。被观战者收不到任何通知（产品决策 5），这里只改死者自己的字段。
   */
  function syncSpectate() {
    // 团队死斗不做观战：阵亡后镜头留在死亡点，1.5 秒后复活；只有爆破保留观战
    if (!snd) {
      for (const p of players.values()) p.spectate = null;
      return;
    }
    for (const p of players.values()) {
      if (p.alive) {
        p.spectate = null;
        continue;
      }
      const cur = p.spectate === null ? null : players.get(p.spectate);
      if (!cur || !cur.alive || cur.team !== p.team) p.spectate = pickSpectate(p);
    }
  }

  /** `[ / ]`（触屏左右按钮）：在存活队友列表里循环切换；活着、不在对局、没有存活队友一律忽略 */
  function switchSpectate(id: number, dir: 1 | -1) {
    if (!snd) return;
    const p = players.get(id);
    if (!p || p.bot || p.alive) return;
    p.spectate = cycleSpectateTarget(spectateOrder(spectateMates(), p.id, p.team), p.spectate, dir);
  }

  /** 观测队友状态（观战 HUD 的血量 / 弹药与右上角队友列表）：**只包本队队友，永远不含敌人** */
  function squadOf(p: Player): SquadMate[] {
    const out: SquadMate[] = [];
    if (!combat) return out;
    for (const q of players.values()) {
      if (q.id === p.id || q.team !== p.team) continue;
      const ws = combat.weaponState(q.id);
      const ammo = ws ? ws.ammo[ws.weapon] : { mag: 0, reserve: 0 };
      const armor = combat.armorOf(q.id);
      out.push({
        id: q.id, alive: q.alive, hp: q.hp,
        armor: armor?.points ?? 0, armorKind: armor?.kind ?? null,
        weapon: ws?.weapon ?? 'vandal', mag: ammo.mag, reserve: ammo.reserve,
      });
    }
    return out;
  }

  function sndActors(): SndActor[] {
    return [...players.values()].map(p => ({
      id: p.id, team: p.team, alive: p.alive, x: p.s.x, y: p.s.y, z: p.s.z,
      use: p.use && tick - p.useTick < USE_FRESH_TICKS,
    }));
  }

  /** 此人这一 tick 是否不能开枪：爆破 / 生化准备与结算 / 团队死斗准备与结算。 */
  function lockedNow(id: number): boolean {
    if (snd) return snd.lockOf(id);
    if (infection) return infection.phaseNow() !== 'active';
    return tdm ? tdm.lockOf() : false;
  }

  function syncLocks() {
    if (!combat) return;
    for (const p of players.values()) combat.setLock(p.id, lockedNow(p.id));
  }

  /** 回合机的事件：回合开始 → 全员回出生点 / 清装备重购；整场结束 → 通知真人并在结算停留后回房间；其余随战斗事件下发 */
  function applySnd(events: SndEvent[]) {
    if (!snd || !combat) return;
    for (const e of events) {
      if (e.kind === 'matchEnd') { endSnd(e.winner, e.wins); continue; }
      combat.emit(e);
      if (e.kind === 'roundStart') {
        squad.reset();
        for (const p of players.values()) {
          // 上一回合买的东西全丢（死亡也丢）；重生后只有随身刀 + 免费手枪
          resetLoadout(p);
          combat.spawn(p.id, tick);
          // 本回合重新拿免费手枪（不给钱、不扣钱）
          combat.selectWeapon(p.id, SND_DEFAULT_SIDEARM, tick);
        }
      } else if (e.kind === 'roundEnd') {
        // 回合奖金：赢方 3000、输方 1900 起、每多一场连败 +500（上限 3400）
        const loser: Team = e.winner === 0 ? 1 : 0;
        const winReward = roundReward(true, 0);
        const loseReward = roundReward(false, snd.lossStreakOf(loser));
        for (const p of players.values()) {
          if (p.team === -1) continue;
          p.credits = addCredits(p.credits, p.team === e.winner ? winReward : loseReward);
        }
      }
    }
    sndView = snd.view();
    syncStatus();
    syncLocks();
  }

  /** 整场结束（爆破 / 团队死斗共用）：通知真人（结算数据）；停留 resultSec 后房间回到等待 */
  function endWithResult(winner: Team | -1, summary: SndMatchSummary | TdmMatchSummary, resultSec: number) {
    for (const m of room.members) if (!m.bot) lobby.clients.get(m.id)?.send({ t: 'matchEnd', winner, summary });
    if (resultTimer) clearTimeout(resultTimer);
    resultTimer = setTimeout(() => { resultTimer = null; lobby.endMatch(room); }, resultSec * 1000);
  }

  function endSnd(winner: Team, wins: [number, number]) {
    const summary: SndMatchSummary = { wins: [wins[0], wins[1]], rounds: snd ? snd.view().round : 0 };
    endWithResult(winner, summary, SND.resultSec);
  }

  /** 团队死斗的事件：开场随战斗事件下发；整场结束 → 通知真人（结算）并停留后回房间 */
  function applyTdm(events: TdmEvent[]) {
    if (!tdm || !combat) return;
    for (const e of events) {
      if (e.kind === 'matchEnd') {
        endWithResult(e.winner, { target: settings.scoreLimit, kills: [e.kills[0], e.kills[1]], reason: e.reason }, TDM.resultSec);
        continue;
      }
      combat.emit(e);
    }
    tdmView = tdm.view();
    syncLocks();
  }

  function entityOf(p: Player, out?: EntitySnap): EntitySnap {
    const armor = combat?.armorOf(p.id);
    const e: EntitySnap = out ?? {
      id: p.id, flags: 0, crouch: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
      aim: { yaw: 0, pitch: 0 }, vx: 0, vy: 0, vz: 0, hp: 0, armor: 0, armorKind: 0, rope: -1, ropeT: 0,
    };
    e.id = p.id;
    e.flags = (p.alive ? EF_ALIVE : 0) | (p.s.grounded ? EF_GROUNDED : 0) | (p.team === 1 ? EF_TEAM1 : 0);
    e.crouch = p.s.crouch;
    e.x = p.s.x; e.y = p.s.y; e.z = p.s.z;
    e.yaw = p.yaw; e.pitch = p.pitch;
    // 朝向（阶段11）：与 yaw / pitch 同源，不额外占字节；观战摄像机按它跟随被观战队友的视线
    const aim = e.aim ?? (e.aim = { yaw: 0, pitch: 0 });
    aim.yaw = p.yaw; aim.pitch = p.pitch;
    e.vx = p.s.vx; e.vy = p.s.vy; e.vz = p.s.vz;
    e.hp = p.hp;
    e.armor = armor?.points ?? 0;
    e.armorKind = armorKindCode(armor?.kind ?? null);
    // 攀绳：远端玩家据此在绳上插值位置并播报攀爬动画
    e.rope = p.s.rope; e.ropeT = p.s.ropeT;
    return e;
  }


  function broadcastSnapshot() {
    snapshotPlayers.length = 0;
    for (const p of players.values()) snapshotPlayers.push(p);
    snapshotEntities.length = snapshotPlayers.length;
    for (let i = 0; i < snapshotPlayers.length; i++)
      snapshotEntities[i] = entityOf(snapshotPlayers[i], snapshotEntities[i]);
    for (const p of snapshotPlayers) {
      if (p.bot) continue;
      const c = lobby.clients.get(p.id);
      if (!c) continue;
      // 信息泄露修复（产品决策 7）：快照只发「自己 + 队友」的 hp / armor，敌人置 0（客户端不再能读到敌方血量）。
      // 观战目标由服务器指定（spectating）：死者据此跟随队友摄像机，活着时恒为 0。
      snapshotOthers.length = 0;
      for (let i = 0; i < snapshotEntities.length; i++) {
        const e = snapshotEntities[i];
        if (e.id === p.id) continue;
        if (((e.flags & EF_TEAM1) !== 0 ? 1 : 0) === p.team) snapshotOthers.push(e);
        else {
          let masked = snapshotMasks[p.team][i];
          if (!masked) snapshotMasks[p.team][i] = masked = { ...e };
          else Object.assign(masked, e);
          masked.hp = 0; masked.armor = 0; masked.armorKind = 0;
          snapshotOthers.push(masked);
        }
      }
      c.sendBinary(encodeSnapshot(tick, p.lastSeq, frozen, p.s, p.yaw, snapshotOthers,
        { weaponLock: lockedNow(p.id), rooted: !!snd && snd.rootedOf(p.id) }, p.credits, p.spectate));
    }
  }

  /** 16 Hz：每人自己的 CombatSelf + 这两 tick 的公共事件；双方均需 shot 呈现弹道与空间枪声，爆破阵亡额外带队友状态。 */
  function broadcastCombat() {
    if (!combat) return;
    const events = combat.takeEvents();
    squad.observe(events, [...players.values()], tick, world?.projectile);
    for (const p of players.values()) {
      if (p.bot) continue;
      const c = lobby.clients.get(p.id);
      if (!c) continue;
      // shot 是公开射击反馈：复用同一事件批次，不按射手队伍截断敌方的弹道和枪声。
      // 私有武器状态仍只在本人的 self / 爆破队友 squad 中下发，敌方血量与护甲仍由快照遮蔽。
      // 武器完整快照只在重置点（换枪 / 换弹开始 / 死亡 / 复活）和每秒关键帧下发。
      // 常规 16 Hz 包只带简单状态（weapon/mag/reserve/reloadUntil/equipUntil/attackSerial），
      // 客户端用本地预测继续演算，不再每 62ms 重传 18 把枪的弹药和内部后坐力状态。
      // 旧客户端（< 1.2.1）仍按旧格式每个包收完整快照，避免升级期间把在线玩家打断。
      const compactClient = supportsCompactCombat(c.build);
      const firstWeaponSync = compactClient && !weaponKeyframesSent.has(p.id);
      const fullWeapon = !compactClient || firstWeaponSync || tick % TICK_RATE < 2 || events.some((e) =>
        (e.kind === 'equip' || e.kind === 'reload' || e.kind === 'death' || e.kind === 'respawn') && e.player === p.id);
      const self = combat.selfOf(p.id, tick, { credits: p.credits, owned: loadoutOf(p), prediction: fullWeapon });
      if (infection) {
        self.role = infection.isInfected(p.id) ? 'infected' : 'human';
        self.moveSpeedMultiplier = infectionSpeedMultiplier(p.team);
      }
      if (fullWeapon && compactClient) weaponKeyframesSent.add(p.id);
      c.send({
        t: 'combat', tick, self, events,
        // 观战（阶段11）：只有爆破在阵亡时带队友状态（活着 / TDM 都不需要，也少一份泄露面）
        ...(p.alive || !snd ? {} : { squad: squadOf(p) }),
        ...(sndView ? { round: sndView } : {}), ...(tdmView ? { tdm: tdmView } : {}),
      });
      sendStats(p.id);
    }
    broadcastInfection();
    broadcastBoard();
  }

  /** 服务器权威战绩：变化才广播，观战席也收；loaded 时强制补一份以免加载素材期间漏掉。 */
  function broadcastBoard(onlyId?: number) {
    if (!combat) return;
    const board: MatchBoard = {
      t: 'matchBoard', matchId: statsId, tick, teamKills: combat.teamKillsOf(),
      ...(sndView ? { rounds: sndView.wins } : {}),
      players: [...players.values()].sort((a, b) => a.id - b.id).map(p => {
        const m = room.members.find(m => m.id === p.id) ?? p.member;
        return { id: p.id, name: m.name, agent: m.agent, team: p.team, bot: p.bot,
          kills: combat!.killsOf(p.id), deaths: combat!.deathsOf(p.id), assists: combat!.assistsOf(p.id),
          alive: combat!.status(p.id).alive };
      }),
    };
    if (onlyId !== undefined) {
      if (room.members.some(m => m.id === onlyId && !m.bot)) lobby.clients.get(onlyId)?.send(board);
      return;
    }
    const signature = JSON.stringify([board.teamKills, board.players, board.rounds ?? null]);
    if (signature === lastBoardSignature) return;
    lastBoardSignature = signature;
    for (const m of room.members) if (!m.bot) lobby.clients.get(m.id)?.send(board);
  }

  /** 战绩变更才发；重发相同累计值也不会使客户端重复加分。 */
  function sendStats(id: number, final = false) {
    const p = players.get(id), c = lobby.clients.get(id);
    if (!combat || !p || p.bot || !c) return;
    const kills = combat.killsOf(id), deaths = combat.deathsOf(id);
    const sig = `${kills}/${deaths}`;
    if (!final && sentStats.get(id) === sig) return;
    sentStats.set(id, sig);
    c.send({ t: 'matchStats', matchId: statsId, you: id, kills, deaths, ...(final ? { final: true } : {}) });
  }

  let lastTime = 0, acc = 0, nextSnap = 0, nextCombat = 0;
  // 每个房间仅保留窗口内数字汇总；输出时才格式化，避免逐 tick 日志。
  let diagStarted = 0, diagRuns = 0, diagGapTotal = 0, diagGapMax = 0;
  let diagTicks = 0, diagTickTotal = 0, diagTickMax = 0;
  let diagBacklogMax = 0, diagDropped = 0, diagCatchupRuns = 0;
  function run() {
    const now = performance.now();
    const gapMs = Math.max(0, now - lastTime);
    const pending = acc + gapMs / 1000;
    diagRuns++;
    diagGapTotal += gapMs;
    diagGapMax = Math.max(diagGapMax, gapMs);
    diagBacklogMax = Math.max(diagBacklogMax, pending * 1000);
    diagDropped += Math.max(0, pending - 0.25) * 1000;
    acc = Math.min(0.25, pending);
    lastTime = now;
    let catchup = 0;
    while (acc >= TICK_DT && catchup < MAX_CATCHUP_STEPS) {
      acc -= TICK_DT;
      const tickStarted = performance.now();
      step();
      catchup++;
      // 快照 / 战斗包按 tick 下发（SNAPSHOT_EVERY / COMBAT_EVERY）：补两帧时也要补齐两份，
      // 否则一次回调推两个 tick 时客户端会少收一帧，观测频率掉到 28 Hz 以下。
      const broadcastStarted = MEASURE_STAGES ? performance.now() : 0;
      if (tick >= nextSnap) { nextSnap = tick + SNAPSHOT_EVERY; broadcastSnapshot(); }
      if (tick >= nextCombat) { nextCombat = tick + COMBAT_EVERY; broadcastCombat(); }
      const tickFinished = performance.now();
      if (MEASURE_STAGES) diagBroadcastMs += tickFinished - broadcastStarted;
      const tickMs = tickFinished - tickStarted;
      if (diagTickSamples) diagTickSamples[diagTicks % diagTickSamples.length] = tickMs;
      diagTicks++;
      diagTickTotal += tickMs;
      diagTickMax = Math.max(diagTickMax, tickMs);
    }
    if (catchup > 1) diagCatchupRuns++;
    if (now - diagStarted >= 30000) {
      let clients = 0;
      for (const p of players.values()) if (!p.bot && lobby.clients.has(p.id)) clients++;
      const samples = diagTickSamples?.subarray(0, Math.min(diagTicks, diagTickSamples.length)).sort();
      const avg = (ms: number) => (diagTicks ? ms / diagTicks : 0).toFixed(2);
      const stages = samples?.length
        ? ` tick_p95_ms=${samples[Math.floor((samples.length - 1) * .95)].toFixed(2)} tick_p99_ms=${samples[Math.floor((samples.length - 1) * .99)].toFixed(2)} bot_avg_ms=${avg(diagBotMs)} sight_avg_ms=${avg(diagSightMs)} sight_rays_per_tick=${avg(diagSightRays)} move_avg_ms=${avg(diagMoveMs)} combat_avg_ms=${avg(diagCombatMs)} broadcast_avg_ms=${avg(diagBroadcastMs)} input_queue_max=${diagInputMax} input_queue_avg=${(diagInputSamples ? diagInputTotal / diagInputSamples : 0).toFixed(2)}`
        : '';
      console.log(`[match-perf] time=${new Date().toISOString()} match=${statsId} map=${settings.map} window_ms=${(now - diagStarted).toFixed(0)} clients=${clients} bots=${botCount} runs=${diagRuns} gap_avg_ms=${(diagGapTotal / diagRuns).toFixed(2)} gap_max_ms=${diagGapMax.toFixed(2)} ticks=${diagTicks} tick_avg_ms=${(diagTicks ? diagTickTotal / diagTicks : 0).toFixed(2)} tick_max_ms=${diagTickMax.toFixed(2)} backlog_max_ms=${diagBacklogMax.toFixed(2)} dropped_ms=${diagDropped.toFixed(2)} catchup_runs=${diagCatchupRuns}${stages}`);
      diagStarted = now;
      diagRuns = diagGapTotal = diagGapMax = 0;
      diagTicks = diagTickTotal = diagTickMax = 0;
      diagBacklogMax = diagDropped = diagCatchupRuns = 0;
      diagBotMs = diagSightMs = diagSightRays = diagMoveMs = diagCombatMs = diagBroadcastMs = 0;
      diagInputMax = diagInputTotal = diagInputSamples = 0;
    }
  }

  /** 共用调度器调用：跑一轮本房间的 tick，并报告下一次 tick 的绝对到期时刻。
   *  调度器在全部房间执行结束后统一计算剩余等待时间，后续房间耗时不会重复计入等待。 */
  const pump: RoomPump = () => {
    if (disposed) return Infinity;
    run();
    if (disposed) return Infinity;
    return lastTime + (TICK_DT - acc) * 1000;
  };

  /** 手动推进（测试）：不靠墙钟，直接跑 n 个 tick，并按同样的频率下发快照与战斗 */
  function advanceTicks(n: number) {
    for (let i = 0; i < n && !disposed; i++) {
      step();
      if (tick >= nextSnap) { nextSnap = tick + SNAPSHOT_EVERY; broadcastSnapshot(); }
      if (tick >= nextCombat) { nextCombat = tick + COMBAT_EVERY; broadcastCombat(); }
    }
  }

  function startIfReady() {
    if (!world || room.state !== 'loading') return;
    const humans = [...players.values()].filter((p) => !p.bot);
    if (!humans.every((p) => loaded.has(p.id))) return;
    unfreeze();
  }
  function unfreeze() {
    if (disposed || room.state !== 'loading') return;
    frozen = false;
    room.state = 'playing';
    lobby.broadcastRoom(room);
    if (snd && combat) applySnd(snd.start(tick)); // 爆破：第 1 回合开始（购买阶段）
    if (tdm && combat) applyTdm(tdm.start(tick)); // 团队死斗：准备期开始（不能开火）
    if (infection && combat) {
      infection.start(tick, [...players.keys()]);
      infectionStateReady = true;
      syncInfectionRoles();
      broadcastInfection(true);
    }
  }

  // —— 启动 ——
  const counts: Record<number, number> = { 0: 0, 1: 0 };
  // 排队进度推给房间里的真人（含观战）：客户端在加载画面显示「第 N / 共 M 位」
  const broadcastQueue = (q: QueueState | null) => {
    // 只在真的被挡住时提示排队；正在加载（第一个、预算也够）不打扰玩家
    const waiting = q && q.blocked;
    const msg = waiting
      ? { t: 'queue' as const, map: settings.map, position: q!.position, total: q!.total, residentBytes: q!.residentBytes, budgetBytes: q!.budgetBytes }
      : { t: 'queue' as const, map: settings.map, position: 0, total: 0, residentBytes: 0, budgetBytes: 0 };
    for (const m of room.members) if (!m.bot) lobby.clients.get(m.id)?.send(msg);
  };
  const lease: WorldLease = opts.world
    ? { promise: Promise.resolve(opts.world), release() {} }
    : acquireWorld(settings.map, broadcastQueue);
  void (async () => {
    try {
      world = await lease.promise;
      broadcastQueue(null);
      if (disposed) return;
      // 爆破：死后不自动复活；生化：仅感染者自动复活、感染者血量与武器由服务端策略强制。
      combat = new CombatSystem({ projectile: world.projectile, codes: world.codes }, combatHost,
        {
          autoRespawn: !snd,
          protectTicks: snd || infection ? 0 : undefined,
          maxHpOf: id => infection?.isInfected(id) ? INFECTION.infectedHp : 100,
          canRespawn: id => !infection || infection.isInfected(id),
          weaponPolicy: (id, weapon) => infection?.isInfected(id) ? 'melee' : weapon,
        });
      for (const m of room.members) if (m.team !== -1) addPlayer(m, counts[m.team]++);
      lastTime = performance.now();
      diagStarted = lastTime;
      if (!opts.manual) { registered = true; addPump(pump); }
      startIfReady();
      // 导航网格（首次烘焙要几秒）：好了人机才开始走
      loadNav(world)
        .then((n) => {
          if (disposed || !world) return;
          nav = n;
          // T1 区域默认点位表：一次导航吸附，之后所有 Bot 共享。
          zonePlan = buildZonePlan(patrols, n);
          const seeds = [
            ...mapData.tdm.BL, ...mapData.tdm.GR,
            ...mapData.snd.spawns.attack.spawns, ...mapData.snd.spawns.defend.spawns,
            ...patrols,
          ];
          void prepareCoverGraph(world.projectile, n, seeds).then(points => {
            if (disposed) return;
            coverGraph = points; tacticsReady = true; postPlantPoints.clear();
            console.log(`[bot] ${settings.map}: 掩体点 ${coverGraph.length}`);
          }).catch(e => {
            tacticsReady = true;
            console.error(`[bot] ${settings.map} 掩体图不可用，使用局部规划`, e);
          });
        })
        .catch((e) => console.error(`[match] ${settings.map} 导航网格不可用`, e));
    } catch (e) {
      if (e instanceof WorldLoadCancelled || disposed) return;
      console.error('[match] 世界加载失败', e);
      if (!disposed) lobby.endMatch(room);
    }
  })();
  const timeout = setTimeout(() => world && unfreeze(), LOAD_TIMEOUT_MS);

  const removePlayer = (id: number) => {
    squad.forget(id);
    sendStats(id, true); // 必须在 combat.remove 前读取最终值（正常退出仍能收到）。
    sentStats.delete(id);
    const gone = players.get(id);
    if (gone?.bot) botCount--;
    players.delete(id);
    infection?.removePlayer(id);
    if (infection) {
      infectionStateReady = true;
      broadcastInfection(true);
    }
    combat?.remove(id);
    // 离场者可能是某个死者的观战目标：立刻重挑（不等下一 tick 的 syncStatus）
    syncSpectate();
    const c = lobby.clients.get(id);
    if (c) c.onBinary = null;
  };

  /** 中途加入：先清掉被顶掉的人机，再按该队现有人数安排出生位；已开打的局给几秒落地保护 */
  const joinPlayer = (m: Member, replaceBotId: number | null) => {
    if (replaceBotId !== null) removePlayer(replaceBotId);
    if (m.team === -1) return;
    const index = [...players.values()].filter((p) => p.team === m.team).length;
    // 爆破：回合进行中（存活 / 已安包）加入的人本回合只能观战，下一回合开始复活；爆破没有落地保护
    const midRound = !!snd && (sndView?.phase === 'live' || sndView?.phase === 'planted');
    addPlayer(m, index, midRound);
    if (infection) {
      infection.addPlayer(m.id);
      infectionStateReady = true;
      syncInfectionRoles();
      broadcastInfection(true);
    }
    weaponKeyframesSent.delete(m.id); // 新加入 / 换客户端：下一份 combat 必须带完整武器快照
    if (!frozen && !snd) combat?.protect(m.id, tick + JOIN_PROTECT_TICKS);
  };

  return {
    playerLoaded(id) {
      loaded.add(id);
      broadcastBoard(id);
      startIfReady();
    },
    playerLeft(id) {
      loaded.delete(id);
      removePlayer(id);
      // 真人全走光了：对局结束，房间回到等待
      if (world && ![...players.values()].some((p) => !p.bot)) lobby.endMatch(room);
      else startIfReady();
    },
    /** 大厅把「中途加入的真人」转进来（房间成员表已经更新过） */
    joinPlayer(member: Member, replaceBotId: number | null) {
      joinPlayer(member, replaceBotId);
    },
    /** 掉线的真人在宽限期内接回：角色原地未动，这里只把输入通道接到新连接上，命令序号从头计 */
    resumePlayer(id: number) {
      const p = players.get(id);
      const c = lobby.clients.get(id);
      if (!p || p.bot || !c) return;
      p.lastSeq = 0;
      p.input.reconnect();
      p.use = false;
      combat?.onCommand(id, { seq: 0, buttons: 0, yaw: p.yaw, pitch: p.pitch }, tick);
      c.onBinary = (buf) => onInput(p, buf);
      weaponKeyframesSent.delete(id); // 重连后的客户端武器预测是空的：下一份 combat 补完整快照
      sentStats.delete(id);
      sendStats(id);
      if (infectionStateReady && infection) c.send(infection.view(tick));
    },
    /** 大厅把 requestWeapon 转进来（合法性由大厅校验，这里只再确认活着 / 不是当前枪）
     *  爆破：只允许切到本回合已拥有的武器（免费手枪 / 刀 / 买下的枪），防作弊；TDM 照旧不受限。 */
    selectWeapon(id: number, weapon: WeaponId) {
      const p = players.get(id);
      if (infection && p && infection.isInfected(id)) return;
      if (snd) {
        if (!p || !loadoutOf(p).includes(weapon)) return;
      }
      combat?.selectWeapon(id, weapon, tick);
    },
    /** 大厅把 buy 命令转进来（SND 经济）：校验余额 / 购买窗 / 槽位后扣款并下发装备 */
    buy(id: number, item: BuyItem) {
      handleBuy(id, item);
    },
    /** 大厅把观战切换转进来（阶段11，`[ / ]` 与触屏左右按钮同一条路径）：活着 / 没有存活队友时忽略 */
    spectate(id: number, dir: 1 | -1) {
      switchSpectate(id, dir);
    },
    advance(ticks: number) {
      advanceTicks(ticks);
    },
    ready() {
      return world !== null && combat !== null && nav !== null && tacticsReady;
    },
    dispose() {
      disposed = true;
      lease.release();
      clearTimeout(timeout);
      if (resultTimer) { clearTimeout(resultTimer); resultTimer = null; }
      if (registered) { registered = false; removePump(pump); }
      for (const p of players.values()) if (!p.bot) removePlayer(p.id);
      combat?.dispose();
      combat = null;
      players.clear();
      loaded.clear();
      squad.reset();
      coverGraph = [];
      postPlantPoints.clear();
      zonePlan = [];
      nav = null;
    },
    // 仅测试（opts.manual）：让某人立刻阵亡（自杀，不计任何人的击杀），验收脚本用它制造可控的死亡时机。
    // 真实对局（大厅起的对局）返回的对象里根本没有这个键，网络层也没有任何消息能走到这里。
    ...(opts.manual ? {
      testSlay(id: number) {
        if (!combat?.slay(id)) return;
        syncStatus();
      },
    } : {}),
  };
}
