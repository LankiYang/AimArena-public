// 仅传播实际枪声与队友亲眼目击的旧位置；不提供墙后敌人的实时坐标。
import type { Team } from '../shared/catalog.ts';
import type { CombatEvent, V3 } from '../shared/combat.ts';
import { TICK_RATE } from '../shared/sim/tick.ts';
import { raycast, type BVH } from '../shared/world/bvh.ts';
import { assignPersonas, type BotPersona, type PersonaSeat, type TeamStance } from './bot-persona.ts';
import { TACTICS, closestSegmentPoint, crossfireAngle, type BotSuppression, type SquadTactic } from './bot-tactics.ts';
import type { BotWorkBudget } from './bot-work.ts';

export interface BotContact { point: V3; tick: number }
export interface BotSound extends BotContact { team: Team; shooter: number; radius: number }
/** T1：一条「请求支援」（血量低于阈值且有敌人的 Bot 广播） */
export interface SupportRequest { id: number; team: Team; point: V3; tick: number }
/** T2：一个补位空缺（阵亡队友的最后掩体点，由最近的存活队友接管） */
export interface BotVacancy { forId: number; point: V3; tick: number }
/** T3：交叉火力配对结果 */
export interface BotCrossfire { enemy: number; partner: number; role: 'push' | 'hold'; angle: number }
/** 爆破任务（服务器按回合状态派发）：plant 安放 · defuse 拆除 · pickup 捡包 · push 推进 · guard 守点 */
/** phase：守点任务所在的回合阶段（live 守点 / planted 守包）；人格守点手据此守包点 */
/** face：到位后的朝向目标（守包时看敌方来路 / 拆包时看包）；urgent：炸弹将爆时的拆包优先 */
export interface BotMission { kind: 'plant' | 'defuse' | 'pickup' | 'push' | 'guard'; point: V3; use: boolean; phase?: 'live' | 'planted'; face?: V3; urgent?: boolean }
export interface BotContext {
  pawn?: BVH;
  /** 策略仅选择决策方式；感知、移动和战斗规则仍由共用系统裁决。 */
  strategy?: 'tactical' | 'infected';
  patrols?: readonly V3[];
  contact?: BotContact;
  sounds?: readonly BotSound[];
  report?: (point: V3) => void;
  /** 爆破：本 tick 的任务（无则走默认巡逻 / 警戒） */
  mission?: BotMission;
  /** 附近弹道造成的压制；只在服务端使用，不下发客户端。 */
  suppression?: BotSuppression;
  /** 小队当前的集结 / 等待 / 推进指令。 */
  squad?: SquadTactic;
  /** 地图掩体点图；由 match 按地图缓存并共享给所有 BotBrain。 */
  covers?: readonly import('./bot-tactics.ts').CoverPoint[];
  /** T1：地图区域默认点位表（A / B / Mid），开局建立一次后共享。 */
  zones?: readonly import('./bot-tactics.ts').TacticsZone[];
  /** T1：收到了队友的「请求支援」且自己是最近的空闲队友之一。 */
  support?: { id: number; point: V3; tick: number; count: number };
  /** T2：前移到阵亡队友最后掩体点的补位任务。 */
  vacancy?: BotVacancy;
  /** T3：与队友对同一敌人构成交叉火力时的角色（前压 / 架枪）。 */
  crossfire?: BotCrossfire;
  /** T1：广播「请求支援」（血量低于阈值且有敌人时由 BotBrain 调用）。 */
  requestSupport?: (point: V3) => void;
  /** T3：上报本 tick 的交战目标（无敌人传 null），用于同一敌人的交叉火力配对。 */
  claimTarget?: (enemy: number | null, point?: V3) => void;
  /** T2：上报自己的掩体点（离开掩体传 null），阵亡时作为补位目标。 */
  reportAnchor?: (point: V3 | null) => void;
  /** 每房间共享的可延后导航预算；省略时兼容离线旧调用。 */
  work?: BotWorkBudget;
}

export interface BotObservationActor { id: number; team: Team; alive?: boolean; s?: V3 }

/** 每局独立、容量有界；同 tick 的报点到下一 tick 才可读，避免遍历顺序偏向先行动者。 */
export class BotSquad {
  private reports: [BotContact[], BotContact[]] = [[], []];
  private sounds: BotSound[] = [];
  private personas = new Map<number, BotPersona>();
  private stances: [TeamStance, TeamStance] | null = null;
  private actors: BotObservationActor[] = [];
  private suppression = new Map<number, BotSuppression>();
  private waits = new Map<number, { point: V3; until: number; release: number }>();
  /** T1：每队最近一条「请求支援」 */
  private requests: (SupportRequest | null)[] = [null, null];
  /** T3：每个 Bot 本 tick 上报的交战目标（敌人 ID + 当时位置） */
  private claims = new Map<number, { enemy: number; point: V3; tick: number }>();
  /** T2：每个 Bot 上报的当前掩体点，阵亡时作为补位目标 */
  private anchors = new Map<number, V3>();
  /** 上一次观察到的每个人位置（没有掩体上报时作为补位目标兜底） */
  private lastPos = new Map<number, V3>();
  /** 已阵亡但尚未复活的人（actor 快照可能滞后一 tick，用事件集补正） */
  private dead = new Set<number>();
  /** T2：每队的补位空缺 */
  private vacancies: BotVacancy[][] = [[], []];
  /** 同 tick 内所有人的听到的声音列表都一样：每 tick 只过滤一次，不再按人重复分配数组。 */
  private soundViewTick = -1;
  private soundView: readonly BotSound[] = [];

  /**
   * seed 缺省：没有人格（旧行为，全队同一套逻辑；离线夹具用）。
   * seed 给定：按名单（每队座位顺序）与站点数生成人格；同一对局种子可复现。
   */
  constructor(seed?: number, roster: readonly PersonaSeat[] = [], siteCount = 0) {
    if (seed === undefined) return;
    const plan = assignPersonas(seed, roster, siteCount);
    this.personas = plan.personas;
    this.stances = plan.stances;
  }

  personaOf(id: number): BotPersona | undefined { return this.personas.get(id); }
  stanceOf(team: Team): TeamStance | null { return this.stances?.[team] ?? null; }

  report(team: Team, point: V3, tick: number): void {
    const list = this.reports[team];
    const last = list[list.length - 1];
    if (last?.tick === tick) return;
    list.push({ point: { ...point }, tick });
    if (list.length > 8) list.shift();
  }

  /** T1：广播一条「请求支援」；同队只保留最新一条，由 context() 分派给最近的空闲队友。 */
  request(team: Team, id: number, point: V3, tick: number): void {
    const old = this.requests[team];
    if (old?.tick === tick && old.id === id) return;
    this.requests[team] = { id, team, point: { ...point }, tick };
  }

  /** T2：记录某个 Bot 的掩体点（null = 已离开掩体）。 */
  reportAnchor(id: number, point: V3 | null): void {
    if (point) this.anchors.set(id, { ...point });
    else this.anchors.delete(id);
  }

  /** T3：上报本 tick 的交战目标；没有敌人时清掉自己的认领，避免旧目标参与配对。 */
  claimTarget(id: number, enemy: number | null, point: V3 | undefined, tick: number): void {
    if (enemy === null || !point) { this.claims.delete(id); return; }
    this.claims.set(id, { enemy, point: { ...point }, tick });
  }

  observe(events: readonly CombatEvent[], actors: readonly BotObservationActor[], tick: number, world?: BVH): void {
    this.actors = actors.map(a => ({ id: a.id, team: a.team, alive: a.alive, s: a.s ? { ...a.s } : undefined }));
    for (const a of this.actors) if (a.alive !== false && a.s) this.lastPos.set(a.id!, { x: a.s.x, y: a.s.y, z: a.s.z });
    for (const id of this.suppression.keys()) if (!this.actors.some(a => a.id === id && a.alive !== false)) this.forget(id);
    for (const event of events) {
      if (event.kind === 'roundStart') { this.reset(); continue; }
      if (event.kind === 'death') {
        // T2：先记下死者最后的掩体点（没有就用最后位置），再清掉他的认领 / 上报，最后留下补位空缺。
        const fallback = this.anchors.get(event.player) ?? this.lastPos.get(event.player);
        this.forget(event.player);
        this.dead.add(event.player);
        const actor = this.actors.find(a => a.id === event.player);
        if ((actor?.team === 0 || actor?.team === 1) && fallback)
          this.vacancies[actor.team].push({ forId: event.player, point: { ...fallback }, tick });
        continue;
      }
      if (event.kind === 'respawn') { this.forget(event.player); this.dead.delete(event.player); continue; }
      if (event.kind !== 'shot' || event.weapon === 'melee') continue;
      const actor = actors.find(p => p.id === event.shooter);
      if (!actor) continue;
      const silenced = ['ghost', 'phantom', 'spectre'].includes(event.weapon);
      this.sounds.push({ team: actor.team, shooter: actor.id, tick, radius: silenced ? 18 : 32,
        // 声音只能给近似地面位置，不能带出敌方的姿态、速度或当前目标。
        point: { x: event.origin.x, y: event.origin.y - 1.5, z: event.origin.z } });
      // 子弹掠过附近或命中时建立短暂压制状态。没有位置快照时仍保留声音，但不凭空推断压制。
      for (const target of this.actors) {
        if (!target.alive || target.team === actor.team || !target.s) continue;
        let nearest = Infinity, hit = false;
        for (const ray of event.rays) {
          hit ||= ray.hit === target.id;
          const body = { x: target.s.x, y: target.s.y + 1.1, z: target.s.z };
          const close = closestSegmentPoint(body, event.origin, ray.end);
          const d = Math.hypot(body.x - close.x, body.y - close.y, body.z - close.z);
          if (d >= 2.4 || d >= nearest) continue;
          // 薄墙另一侧的弹道不算掠过；只有目标附近的无遮挡弹道会造成压制。
          if (world && d > .1 && raycast(world, body.x, body.y, body.z,
            (close.x - body.x) / d, (close.y - body.y) / d, (close.z - body.z) / d, Math.max(0, d - .02))) continue;
          nearest = d;
        }
        if (hit || nearest < 2.4) {
          const intensity = hit ? 1 : Math.max(.2, 1 - nearest / 2.4);
          const old = this.suppression.get(target.id);
          const previous = old && old.until > tick ? old.intensity * (old.until - tick) / Math.max(1, old.until - old.tick) : 0;
          // 只给来弹方向上约 10m 的估计点，不泄露墙后射手的精确位置 / 距离。
          const dx = event.origin.x - target.s.x, dz = event.origin.z - target.s.z, length = Math.max(.01, Math.hypot(dx, dz));
          this.suppression.set(target.id, {
            tick, until: tick + Math.round((.65 + intensity * .85) * TICK_RATE),
            intensity: Math.max(previous, intensity),
            source: { x: target.s.x + dx / length * 10, y: target.s.y + 1.3, z: target.s.z + dz / length * 10 },
          });
        }
      }
    }
    this.sounds = this.sounds.filter(s => tick - s.tick <= 2 * TICK_RATE).slice(-32);
    for (const [id, state] of this.suppression) if (state.until <= tick) this.suppression.delete(id);
  }

  context(team: Team, tick: number, pawn?: BVH, patrols?: readonly V3[], actorId?: number): BotContext {
    const contact = this.reports[team].findLast(r => r.tick < tick && tick - r.tick <= 3 * TICK_RATE);
    const state = actorId === undefined ? undefined : this.suppression.get(actorId);
    if (this.soundViewTick !== tick) {
      this.soundView = this.sounds.filter(s => tick - s.tick <= 2 * TICK_RATE);
      this.soundViewTick = tick;
    }
    // T1/T2/T3 分派：全部用已有的 actor 快照做纯几何计算，不新增导航查询。
    const tactics = actorId === undefined ? null : {
      support: this.supportFor(team, actorId, tick),
      vacancy: this.vacancyFor(team, actorId, tick),
      crossfire: this.crossfireFor(team, actorId, tick),
    };
    if (tactics) for (const list of this.vacancies) {
      while (list.length && tick - list[0].tick > TACTICS.fillTicks) list.shift();
    }
    return { pawn, patrols, contact: contact ? { tick: contact.tick, point: { ...contact.point } } : undefined,
      sounds: this.soundView,
      suppression: state && state.tick < tick && state.until > tick ? {
        ...state, intensity: state.intensity * (state.until - tick) / Math.max(1, state.until - state.tick),
        source: state.source ? { ...state.source } : undefined,
      } : undefined,
      squad: actorId === undefined ? undefined : this.tactic(team, actorId, tick, contact),
      report: point => this.report(team, point, tick),
      support: tactics?.support,
      vacancy: tactics?.vacancy,
      crossfire: tactics?.crossfire,
      requestSupport: actorId === undefined ? undefined : point => this.request(team, actorId, point, tick),
      claimTarget: actorId === undefined ? undefined : (enemy, point) => this.claimTarget(actorId, enemy, point, tick),
      reportAnchor: actorId === undefined ? undefined : point => this.reportAnchor(actorId, point) };
  }

  /** 从事件集补正后的存活判定：actor 快照可能滞后一 tick。 */
  private aliveNow(a: BotObservationActor): boolean { return a.alive !== false && !this.dead.has(a.id!); }

  /** T1：距离请求者最近的空闲队友（近 1 秒没有交战目标）最多 2 人响应；全队在交战时退化为最近的队友。 */
  private supportFor(team: Team, actorId: number, tick: number): BotContext['support'] {
    const req = this.requests[team];
    if (!req || req.id === actorId || req.tick > tick || tick - req.tick > TACTICS.requestTicks) return undefined;
    const distance = (a: BotObservationActor) => Math.hypot((a.s?.x ?? 0) - req.point.x, (a.s?.z ?? 0) - req.point.z);
    const members = this.actors
      .filter(a => this.aliveNow(a) && a.team === team && a.s && a.id !== req.id)
      .sort((a, b) => distance(a) - distance(b));
    const idle = (a: BotObservationActor) => { const c = this.claims.get(a.id!); return !c || tick - c.tick > TICK_RATE; };
    const responders = members.filter(idle).slice(0, TACTICS.responders);
    for (const a of members) {
      if (responders.length >= TACTICS.responders) break;
      if (!responders.includes(a)) responders.push(a);
    }
    if (!responders.some(a => a.id === actorId)) return undefined;
    return { id: req.id, point: { ...req.point }, tick: req.tick, count: responders.length };
  }

  /** T2：最近的存活队友接管阵亡队友的最后掩体点；不是最近的那个返回 undefined。 */
  private vacancyFor(team: Team, actorId: number, tick: number): BotVacancy | undefined {
    let latest: BotVacancy | null = null;
    for (const v of this.vacancies[team]) {
      if (v.forId === actorId || tick - v.tick > TACTICS.fillTicks) continue;
      if (!latest || v.tick > latest.tick) latest = v;
    }
    if (!latest) return undefined;
    let nearest = -1, best = Infinity;
    for (const a of this.actors) {
      // 排除死者与已阵亡的队友：死者自己的位置离补位点最近，不能把“最近队友”算成他自己。
      if (!this.aliveNow(a) || a.team !== team || !a.s || a.id === latest.forId) continue;
      const d = Math.hypot(a.s.x - latest.point.x, a.s.z - latest.point.z);
      if (d < best) { best = d; nearest = a.id!; }
    }
    return nearest === actorId ? { forId: latest.forId, point: { ...latest.point }, tick: latest.tick } : undefined;
  }

  /** T3：和同一队里对同一敌人有新鲜认领、且以敌人为顶点夹角 >60° 的队友配对；远的那个前压，近的架枪。 */
  private crossfireFor(team: Team, actorId: number, tick: number): BotCrossfire | undefined {
    const mine = this.claims.get(actorId);
    if (!mine || tick - mine.tick > TICK_RATE) return undefined;
    const me = this.actors.find(a => a.id === actorId), enemy = this.actors.find(a => a.id === mine.enemy);
    if (!me?.s || !enemy?.s || enemy.alive === false || !enemy.s) return undefined;
    const partners = this.actors
      .filter(a => this.aliveNow(a) && a.team === team && a.s && a.id !== actorId)
      .filter(a => { const c = this.claims.get(a.id!); return !!c && c.enemy === mine.enemy && tick - c.tick <= TICK_RATE; })
      .sort((a, b) => a.id! - b.id!);
    for (const partner of partners) {
      const angle = crossfireAngle(me.s, partner.s!, enemy.s);
      if (angle < TACTICS.crossfireAngle) continue;
      const myDistance = Math.hypot(me.s.x - enemy.s.x, me.s.z - enemy.s.z);
      const itsDistance = Math.hypot(partner.s!.x - enemy.s.x, partner.s!.z - enemy.s.z);
      const role = myDistance > itsDistance || (myDistance === itsDistance && actorId > partner.id!) ? 'push' : 'hold';
      return { enemy: mine.enemy, partner: partner.id!, role, angle };
    }
    return undefined;
  }

  private tactic(team: Team, actorId: number, tick: number, contact?: BotContact): SquadTactic {
    const members = this.actors.filter(a => a.alive && a.team === team && a.s);
    if (!contact || members.length < 2) return { directive: 'push', ready: true, readyCount: members.length, required: 2 };
    const readyCount = members.filter(a => a.s && Math.hypot(a.s.x - contact.point.x, a.s.z - contact.point.z) <= 8 && Math.abs(a.s.y - contact.point.y) < 2).length;
    const self = members.find(a => a.id === actorId);
    const ready = !!self?.s && Math.hypot(self.s.x - contact.point.x, self.s.z - contact.point.z) <= 8 && Math.abs(self.s.y - contact.point.y) < 2;
    let wait = this.waits.get(actorId);
    if (!wait || Math.hypot(wait.point.x - contact.point.x, wait.point.z - contact.point.z) > 6) {
      wait = { point: { ...contact.point }, until: tick + Math.round(1.25 * TICK_RATE), release: 0 };
      if (ready) this.waits.set(actorId, wait);
    }
    if (readyCount >= 2) wait.release = tick + 3 * TICK_RATE;
    const directive = readyCount >= 2 || tick < wait.release || (ready && tick >= wait.until) ? 'push' : ready ? 'wait' : 'support';
    return { directive, lane: { ...contact.point }, ready, readyCount, required: 2, waitUntil: wait.until };
  }

  forget(id: number): void {
    this.suppression.delete(id); this.waits.delete(id);
    this.claims.delete(id); this.anchors.delete(id); this.lastPos.delete(id);
    for (const list of this.vacancies) {
      const i = list.findIndex(v => v.forId === id);
      if (i >= 0) list.splice(i, 1);
    }
  }

  reset(): void {
    this.reports = [[], []]; this.sounds = []; this.soundView = []; this.soundViewTick = -1; this.actors = [];
    this.suppression.clear(); this.waits.clear(); this.requests = [null, null];
    this.claims.clear(); this.anchors.clear(); this.lastPos.clear(); this.vacancies = [[], []]; this.dead.clear();
  }
}
