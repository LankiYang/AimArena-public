// nav.ts — 人机导航网格：Recast 烘焙（输入 = 人物碰撞汤）、绳索 off-mesh 连接、出生点可达性修剪、路径查询
//   烘焙结果缓存到 game/.cache/nav/<map>.navmesh.bin（首次 8–12 秒/图，之后导入毫秒级）
//   研究记录：game/research/collision-nav.md §7
import fs from 'node:fs';
import path from 'node:path';
import { init, NavMeshQuery, QueryFilter, exportNavMesh, importNavMesh, type NavMesh } from 'recast-navigation';
import { generateTiledNavMesh } from 'recast-navigation/generators';
import type { MapId } from '../shared/catalog.ts';
import { ROPE_CLIMB_SPEED, ROPE_SEGMENT_TOLERANCE, ropeLength, type RopeDef } from '../shared/rope.ts';
import { GAME_DIR } from './paths.ts';
import { getMapData, sitePoint } from './mapdata.ts';
import type { ServerWorld } from './world.ts';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const AGENT = { radius: 0.4, height: 1.8, climb: 0.45, slope: 45 };
const CS = 0.1,
  CH = 0.05;
const CONFIG = {
  cs: CS,
  ch: CH,
  tileSize: 128,
  walkableSlopeAngle: AGENT.slope,
  walkableHeight: Math.ceil(AGENT.height / CH),
  walkableClimb: Math.floor(AGENT.climb / CH),
  walkableRadius: Math.ceil(AGENT.radius / CS),
  maxEdgeLen: Math.round(12 / CS),
  maxSimplificationError: 1.3,
  minRegionArea: 64,
  mergeRegionArea: 400,
  maxVertsPerPoly: 6,
  // recast-navigation 0.43 里这两个按米直接透传（设 0 / 0.6 会在 buildPolyMeshDetail 越界崩溃）
  detailSampleDist: 2.0,
  detailSampleMaxError: 0.1,
  borderSize: Math.ceil(AGENT.radius / CS) + 3,
};
const FLAG_WALK = 1;
const FLAG_ROPE = 2;
// ascent v7 使用校准后的 A 包点连接；其他地图的 v5 数据未变化。
const BAKE_VERSION = 7;
/** 平地奔跑速度（米/秒，与人机估算一致）：只用于路径耗时估算，不参与移动模拟 */
export const WALK_SPEED = 6.75;
/** 一次攀绳的固定开销（秒）：吸附 + 端点脱离的估算余量 */
const ROPE_OVERHEAD = 0.15;
/** 路径点的离散化精度：直线段与绳索段共用 */
export interface PathLimits {
  maxPathPolys: number;
  maxStraightPathPoints: number;
}

/** 路径里用到的一段绳索（按行进方向给出 up/down） */
export interface RopeSegmentUse {
  /** 绳索下标（与 shared/rope.ts 的 ropesFor(map) 一致） */
  rope: number;
  id: string;
  /** true = 从下往上爬 */
  up: boolean;
  /** 这一段绳的攀爬时间（秒） */
  time: number;
  /** 该绳索段在路径里的起点下标（path[segment] → path[segment+1]） */
  segment: number;
}

export interface PathExResult {
  /** 拐点路径（含起终点） */
  path: Vec3[];
  /** 这条路径是否经过绳索离网连接 */
  hasRope: boolean;
  /** 用到的绳索段（按先后顺序） */
  ropeUses: RopeSegmentUse[];
  /** 走这条路的总耗时（秒）：平地按 WALK_SPEED，绳索段按 ROPE_CLIMB_SPEED */
  time: number;
  /** 纯步行的替代方案耗时（秒）；没用到绳索时等于 time，纯步行不可达 = Infinity */
  walkTime: number;
  /** 纯步行的替代路径；只有 hasRope 时才有值（人机据此退回步行） */
  walkPath: Vec3[] | null;
}

export interface PathExOptions {
  /** 允许走绳索离网连接（地图没有攀绳点位时自动退化为纯步行） */
  allowRope?: boolean;
  limits?: PathLimits;
}
const CACHE = path.join(GAME_DIR, '.cache', 'nav');

let ready: Promise<void> | null = null;
const initRecast = () => (ready ??= init());

export class Nav {
  navMesh: NavMesh;
  query: NavMeshQuery;
  filter: QueryFilter;
  private walkingFilter: QueryFilter;
  /** 本局可攀爬的绳索（下标即协议里的绳索 id）；空 = 不支持攀绳 */
  readonly ropes: readonly RopeDef[];

  constructor(navMesh: NavMesh, ropes: readonly RopeDef[] = []) {
    this.navMesh = navMesh;
    this.ropes = ropes;
    this.query = new NavMeshQuery(navMesh);
    this.filter = new QueryFilter();
    this.filter.includeFlags = FLAG_WALK;
    this.filter.excludeFlags = 0;
    this.walkingFilter = new QueryFilter();
    this.walkingFilter.includeFlags = FLAG_WALK;
    this.walkingFilter.excludeFlags = FLAG_ROPE;
    // 兼容已有缓存：标记离网绳索连接，步行AI不选择尚未实现攀绳物理的捷径。
    for (let i = 0; i < navMesh.getMaxTiles(); i++) {
      const tile = navMesh.getTile(i), header = tile.header();
      if (!header) continue;
      const base = navMesh.getPolyRefBase(tile);
      for (let j = header.offMeshBase(); j < header.polyCount(); j++) {
        const flags = tile.polys(j).flags();
        if (flags) navMesh.setPolyFlags(base | j, flags | FLAG_ROPE);
      }
    }
  }

  /** 吸附到可达多边形（半径逐级放大）；失败返回 null */
  snap(p: Vec3, maxExtent = 8, walkingOnly = false): (Vec3 & { ref: number }) | null {
    // 先扩水平范围寻找同楼层，再扩高度；不能半径 1m 内先选到头顶平台。
    for (const h of [.65, 1.25, 2, 4]) for (const e of [1, 2, 4, 8]) {
      if (e > maxExtent) break;
      const r = this.query.findNearestPoly(p, { halfExtents: { x: e, y: h, z: e }, filter: walkingOnly ? this.walkingFilter : this.filter });
      if (r.success && r.nearestRef && Math.abs(r.nearestPoint.y - p.y) <= h)
        return { x: r.nearestPoint.x, y: r.nearestPoint.y, z: r.nearestPoint.z, ref: r.nearestRef };
    }
    return null;
  }

  /** 拐点路径（含起终点）；不可达返回 null */
  path(from: Vec3, to: Vec3, walkingOnly = false, limits?: PathLimits): Vec3[] | null {
    return this.queryPath(from, to, walkingOnly, limits);
  }

  /**
   * 带绳索信息的路径查询：允许走绳索离网连接（allowRope），并给出「是否含绳索 / 用了哪几条 / 耗时对比」。
   * 用到绳索时会额外算一次纯步行路径（walkPath/walkTime），人机据此做「省时 ≥ 门槛 才走绳」的门控。
   */
  pathEx(from: Vec3, to: Vec3, options: PathExOptions = {}): PathExResult | null {
    const allowRope = !!options.allowRope && this.ropes.length > 0;
    const path = this.queryPath(from, to, !allowRope, options.limits);
    if (!path || path.length < 2) return null;
    const ropeUses = allowRope ? ropeUsesOf(this.ropes, path) : [];
    const time = pathTime(path, ropeUses);
    if (!ropeUses.length) return { path, hasRope: false, ropeUses, time, walkTime: time, walkPath: null };
    const walkPath = this.queryPath(from, to, true, options.limits);
    return {
      path,
      hasRope: true,
      ropeUses,
      time,
      walkTime: walkPath ? pathTime(walkPath, []) : Infinity,
      walkPath,
    };
  }

  /** 原始路径查询（拐点含起终点）：walkingOnly = 排除绳索离网连接 */
  private queryPath(from: Vec3, to: Vec3, walkingOnly: boolean, limits?: PathLimits): Vec3[] | null {
    const a = this.snap(from, 4, walkingOnly),
      b = this.snap(to, 8, walkingOnly);
    if (!a || !b || (walkingOnly && Math.abs(a.y - from.y) > 1.25)) return null;
    const r = this.query.computePath(a, b, {
      filter: walkingOnly ? this.walkingFilter : this.filter,
      halfExtents: { x: 0.5, y: 2, z: 0.5 },
      maxPathPolys: limits?.maxPathPolys ?? 4096,
      maxStraightPathPoints: limits?.maxStraightPathPoints ?? 512,
    });
    if (!r.success || !r.path?.length) return null;
    const end = r.path[r.path.length - 1];
    if (Math.hypot(end.x - b.x, end.y - b.y, end.z - b.z) > .75) return null; // Detour可能只返回部分路径
    return r.path.map((p) => ({ x: p.x, y: p.y, z: p.z }));
  }

  /** 路径长度（米）；不可达 Infinity */
  distance(from: Vec3, to: Vec3): number {
    const p = this.path(from, to);
    if (!p) return Infinity;
    let L = 0;
    for (let i = 1; i < p.length; i++) L += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y, p[i].z - p[i - 1].z);
    return L;
  }

  /** 以 center 为圆心 radius 内的随机可达点 */
  randomAround(center: Vec3, radius: number, walkingOnly = false): Vec3 | null {
    const s = this.snap(center, 8, walkingOnly);
    if (!s) return null;
    const r = this.query.findRandomPointAroundCircle(s, radius, { filter: walkingOnly ? this.walkingFilter : this.filter });
    return r.success ? { x: r.randomPoint.x, y: r.randomPoint.y, z: r.randomPoint.z } : null;
  }

  randomPoint(walkingOnly = false): Vec3 | null {
    const r = this.query.findRandomPoint({ filter: walkingOnly ? this.walkingFilter : this.filter });
    return r.success ? { x: r.randomPoint.x, y: r.randomPoint.y, z: r.randomPoint.z } : null;
  }
}

const loaded = new Map<MapId, Promise<Nav>>();

/** 路径里哪些直线段是攀绳段（直线段端点与绳索上下端点在容差内重合） */
function ropeUsesOf(ropes: readonly RopeDef[], path: readonly Vec3[]): RopeSegmentUse[] {
  const uses: RopeSegmentUse[] = [];
  const near = (a: Vec3, b: readonly number[]) => Math.hypot(a.x - b[0], a.y - b[1], a.z - b[2]) <= ROPE_SEGMENT_TOLERANCE;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i], b = path[i + 1];
    for (let k = 0; k < ropes.length; k++) {
      const r = ropes[k];
      let up: boolean | null = null;
      if (near(a, r.bottom) && near(b, r.top)) up = true;
      else if (near(a, r.top) && near(b, r.bottom)) up = false;
      if (up === null) continue;
      uses.push({ rope: k, id: r.id, up, time: ropeLength(r) / ROPE_CLIMB_SPEED + ROPE_OVERHEAD, segment: i });
      break;
    }
  }
  return uses;
}

/** 路径总耗时（秒）：绳索段按攀爬速度 + 固定开销，其余按平地奔跑速度 */
function pathTime(path: readonly Vec3[], uses: readonly RopeSegmentUse[]): number {
  let walk = 0, ropeTime = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    const use = uses.find((u) => u.segment === i - 1);
    if (use) ropeTime += use.time;
    else walk += d;
  }
  return walk / WALK_SPEED + ropeTime;
}

/** 绳索的离网连接：烘焙时写进导航网格（userId = 绳索下标，便于排查） */
function offMeshLinks(ropes: readonly RopeDef[]) {
  return ropes.map((r, i) => ({
    startPosition: { x: r.bottom[0], y: r.bottom[1], z: r.bottom[2] },
    endPosition: { x: r.top[0], y: r.top[1], z: r.top[2] },
    radius: 0.5,
    bidirectional: true,
    flags: FLAG_WALK,
    area: 1,
    userId: i,
  }));
}

/** 某张地图的导航网格缓存文件路径（冷启动预烘焙检查用；文件名只在 nav.ts 里定义，别处不要写死） */
export function navCachePath(map: MapId): string {
  const version = map === 'ascent' ? BAKE_VERSION : 5;
  return path.join(CACHE, `${map}.v${version}.navmesh.bin`);
}

export function loadNav(world: ServerWorld): Promise<Nav> {
  let p = loaded.get(world.map);
  if (!p) {
    p = loadOrBake(world);
    loaded.set(world.map, p);
    p.catch(() => loaded.delete(world.map));
  }
  return p;
}

async function loadOrBake(world: ServerWorld): Promise<Nav> {
  await initRecast();
  const file = navCachePath(world.map);
  if (fs.existsSync(file)) {
    const { navMesh } = importNavMesh(new Uint8Array(fs.readFileSync(file)));
    return new Nav(navMesh, world.climbRopes);
  }
  const t0 = performance.now();
  const bin = bake(world);
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file + '.tmp', bin);
  fs.renameSync(file + '.tmp', file);
  console.log(`[nav] ${world.map}: 烘焙完成 ${(bin.length / 1024).toFixed(0)} KiB，${(performance.now() - t0).toFixed(0)} ms`);
  const { navMesh } = importNavMesh(bin);
  return new Nav(navMesh, world.climbRopes);
}

/** Use the authored collision bounds as the navigation bake region. */
function playBounds(world: ServerWorld): [number[], number[]] {
  const b = world.pawn.bounds;
  const lo = Array.from(b.subarray(0, 3));
  const hi = Array.from(b.subarray(3, 6));
  for (const p of allMarkerPoints(world.map)) {
    lo[0] = Math.min(lo[0], p.x);
    lo[1] = Math.min(lo[1], p.y);
    lo[2] = Math.min(lo[2], p.z);
    hi[0] = Math.max(hi[0], p.x);
    hi[1] = Math.max(hi[1], p.y);
    hi[2] = Math.max(hi[2], p.z);
  }
  return [
    [lo[0] - 8, lo[1] - 8, lo[2] - 8],
    [hi[0] + 8, hi[1] + 12, hi[2] + 8],
  ];
}

function allMarkerPoints(map: MapId): Vec3[] {
  const M = getMapData(map);
  return [
    ...M.tdm.BL,
    ...M.tdm.GR,
    ...M.snd.spawns.attack.spawns,
    ...M.snd.spawns.defend.spawns,
    ...Object.keys(M.snd.sites).map((k) => sitePoint(M, k)),
  ];
}

function allPolyRefs(navMesh: NavMesh): number[] {
  const refs: number[] = [];
  for (let i = 0; i < navMesh.getMaxTiles(); i++) {
    const tile = navMesh.getTile(i);
    const h = tile.header();
    if (!h) continue;
    const base = navMesh.getPolyRefBase(tile);
    for (let j = 0; j < h.polyCount(); j++) refs.push(base | j);
  }
  return refs;
}

function bake(world: ServerWorld): Uint8Array {
  const soup = new Float32Array(world.pawn.count * 9);
  for (let i = 0; i < world.pawn.count; i++) {
    const offset = world.pawn.order[i] * 9;
    soup.set(world.pawn.tris.subarray(offset, offset + 9), i * 9);
  }
  const idx = new Uint32Array(soup.length / 3);
  for (let i = 0; i < idx.length; i++) idx[i] = i;
  const bounds = playBounds(world);
  let gen = generateTiledNavMesh(soup, idx, { ...CONFIG, bounds: bounds as never });
  if (!gen.success || !gen.navMesh) throw new Error(`${world.map}: 导航网格生成失败 ${'error' in gen ? gen.error : '缺少 navMesh'}`);
  // 绳索：两遍法——端点贴墙，先吸附到第一遍的多边形上，再带 off-mesh 连接重建
  // Only validated climbable endpoints become navigation links. An airborne
  // lower end has no walkable departure and must not become a bot shortcut.
  const climb = world.climbRopes ?? [];
  if (climb.length) {
    const q0 = new NavMeshQuery(gen.navMesh);
    const he = { x: 1.5, y: 2.5, z: 1.5 };
    // 攀绳：直接拿绳索数据里的坐标（它们本来就在可走面上）；吸附只是兜底。
    const links: unknown[] = [];
    for (const [i, r] of climb.entries()) {
      if (r.bottomAirborne) continue;
      const a = q0.findClosestPoint({ x: r.bottom[0], y: r.bottom[1], z: r.bottom[2] }, { halfExtents: he });
      const b = q0.findClosestPoint({ x: r.top[0], y: r.top[1], z: r.top[2] }, { halfExtents: he });
      if (!a.success || !b.success) continue;
      const link = offMeshLinks([r])[0];
      link.startPosition = { x: a.point.x, y: a.point.y, z: a.point.z };
      link.endPosition = { x: b.point.x, y: b.point.y, z: b.point.z };
      link.userId = i;
      links.push(link);
    }
    q0.destroy();
    gen.navMesh.destroy();
    gen = generateTiledNavMesh(soup, idx, { ...CONFIG, bounds: bounds as never, offMeshConnections: links as never });
    if (!gen.success || !gen.navMesh) throw new Error(`${world.map}: 导航网格（含绳索）生成失败 ${'error' in gen ? gen.error : '缺少 navMesh'}`);
  }
  const navMesh = gen.navMesh;
  // 可达性修剪：从所有出生点洪泛，到不了的多边形（箱子顶、封闭空腔里的孤岛）关掉
  const query = new NavMeshQuery(navMesh);
  const M = getMapData(world.map);
  const seeds = [...M.tdm.BL, ...M.tdm.GR, ...M.snd.spawns.attack.spawns, ...M.snd.spawns.defend.spawns];
  const reach = new Set<number>();
  for (const s of seeds) {
    const n = query.findNearestPoly(s, { halfExtents: { x: 2, y: 4, z: 2 } });
    if (!n.success || !n.nearestRef || reach.has(n.nearestRef)) continue;
    const r = query.findPolysAroundCircle(n.nearestRef, n.nearestPoint, 1e6, { maxPolys: 65536 });
    for (let i = 0; i < r.resultCount; i++) reach.add(r.resultRefs[i]);
  }
  for (const ref of allPolyRefs(navMesh)) if (!reach.has(ref)) navMesh.setPolyFlags(ref, 0);
  const bin = exportNavMesh(navMesh);
  query.destroy();
  navMesh.destroy();
  return bin;
}
