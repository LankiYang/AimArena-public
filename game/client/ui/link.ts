// link.ts — 连接状态提示（房间 / 对局共用）：断线时让玩家知道「座位还在、正在重连」，而不是卡住不动

import { app } from '../app.ts';

/** 连接不在线时返回提示文字；在线 / 正在建立连接 / 还没连时返回 null */
export function linkNotice(): string | null {
  const s = app.conn?.status;
  // connecting 是正常握手期（跨境链路可能要 200–800 ms），以前被当成「网络断开」报给玩家，
  // 让人以为连不上。这里不提示，交给右上角的状态灯显示「连接中」。
  if (!s) return null;
  if (s === 'open') return null;
  if (s === 'replaced') return '这局已在另一个标签页继续，此页面已断开';
  if (s === 'connecting') return app.conn?.retrying ? '正在切换线路重连…（座位会保留一段时间）' : null;
  return app.conn && app.conn.endpointCount > 1
    ? '网络断开，正在切换备用线路…（座位会保留一段时间）'
    : '网络断开，正在重连…（座位会保留一段时间）';
}
