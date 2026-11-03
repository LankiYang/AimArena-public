// session.ts — 标签页级的会话标识与「在不在房间里」标记
//   · 会话标识存在 sessionStorage：同一标签页刷新 / 短暂断网重连时沿用，服务器据此把座位还给同一个人；关掉标签页就失效
//   · 房间标记同样存在 sessionStorage：刷新后据此自动连回去认领座位，而不是落回首页

const SESSION_KEY = 'aim.session';
const ROOM_KEY = 'aim.inRoom';
const VALID = /^[A-Za-z0-9_-]{16,64}$/;

let memory: string | null = null;

function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 本标签页的会话标识（没有就生成一个） */
export function sessionToken(): string {
  try {
    const saved = sessionStorage.getItem(SESSION_KEY);
    if (saved && VALID.test(saved)) return saved;
    const fresh = randomToken();
    sessionStorage.setItem(SESSION_KEY, fresh);
    return fresh;
  } catch {
    // 拿不到 sessionStorage（隐私模式等）：本页面生命周期内沿用内存里的那一个
    if (!memory) memory = randomToken();
    return memory;
  }
}

/** 上一次（刷新前）是否在房间 / 对局里 */
export function wasInRoom(): boolean {
  try {
    return sessionStorage.getItem(ROOM_KEY) === '1';
  } catch {
    return false;
  }
}

export function setInRoom(on: boolean) {
  try {
    if (on) sessionStorage.setItem(ROOM_KEY, '1');
    else sessionStorage.removeItem(ROOM_KEY);
  } catch {
    // 拿不到就算了：最多是刷新后要重新点一次「进入」
  }
}
