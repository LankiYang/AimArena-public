// spectate.ts — 观战规则（阶段11，仅爆破 SND）：死亡后跟随队友第一人称
//
//   产品决策：团队死斗（TDM）不做观战，阵亡镜头留在死亡点，1.5 秒后复活；只有爆破启用本规则。
//     · 只观看队友，不看敌人；默认第一人称跟随，不做第三人称 / 自由飞行。
//     · 自动选目标 = 离死者最近的存活队友（死者到队友的欧氏距离）；没有存活队友 → 回落死亡点自由转头。
//     · [ / ]（触屏左右按钮）= 在存活队友列表里循环切换；列表顺序 = 传入顺序（服务端用玩家表顺序，稳定可复现）。
//     · 不告知被观战者：本模块不产生任何发给被观战者的消息。
//
//   这里是**纯函数**：服务端（server/match.ts）与验收脚本（tools/spectate-check.mjs）共用同一份实现，
//   测试不会另写一套规则。观战的坐标一律用脚底坐标，距离口径与快照实体一致。
export interface SpectateMate {
  id: number;
  team: number;
  alive: boolean;
  /** 脚底坐标 */
  x: number;
  y: number;
  z: number;
}

/** 观战候选：本队**存活**队友，顺序 = 传入顺序（`[ / ]` 循环切换按它走） */
export function spectateOrder(mates: readonly SpectateMate[], myId: number, myTeam: number): number[] {
  const out: number[] = [];
  for (const m of mates) if (m.id !== myId && m.team === myTeam && m.alive) out.push(m.id);
  return out;
}

/** 自动选目标（产品决策 4）：死者到存活队友的欧氏距离最小者；同样距离取玩家表里靠前的那个；没有则 null */
export function nearestSpectateTarget(
  me: { x: number; y: number; z: number },
  mates: readonly SpectateMate[],
  myId: number,
  myTeam: number,
): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  for (const m of mates) {
    if (m.id === myId || m.team !== myTeam || !m.alive) continue;
    const d = Math.hypot(m.x - me.x, m.y - me.y, m.z - me.z);
    if (d < bestD) {
      bestD = d;
      best = m.id;
    }
  }
  return best;
}

/**
 * 循环切换（产品决策 10）：dir = +1 下一个 / -1 上一个，绕过队尾回到队首。
 * 当前目标不在候选里（已阵亡 / 已离场 / 还没选过）时从对应端点重新开始：+1 取第一个，-1 取最后一个。
 * 没有存活队友 → null（回落自由视角）。
 */
export function cycleSpectateTarget(order: readonly number[], current: number | null, dir: number): number | null {
  if (order.length === 0) return null;
  const at = current === null ? -1 : order.indexOf(current);
  if (at < 0) return dir < 0 ? order[order.length - 1] : order[0];
  const step = dir < 0 ? -1 : 1;
  return order[(at + step + order.length) % order.length];
}

/** 观战 HUD 主文案（客户端直接显示；验收脚本用它校验收到的数据能拼出中文提示） */
export const spectateLabel = (name: string) => `正在观战：${name}`;
/** 没有存活队友时的观战提示（回落死亡点自由转头，产品决策 8） */
export const SPECTATE_FREE_LOOK = '队友全部阵亡 · 自由视角';
/** 切换目标的按键提示（桌面 / 触屏两套文案） */
export const SPECTATE_KEYS_DESKTOP = '按 [ / ] 切换队友';
export const SPECTATE_KEYS_TOUCH = '点按左右按钮切换队友';