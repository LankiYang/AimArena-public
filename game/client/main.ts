// main.ts — 前端入口
import './styles/base.css';
import './styles/screens.css';
import { app } from './app.ts';
import { landingScreen } from './ui/landing.ts';
import { lobbyScreen } from './ui/lobby.ts';
import { roomScreen } from './ui/room.ts';
import { matchScreen } from './match-screen.ts';
import { installViewport, installTouchGuards } from './viewport.ts';
import { installKillLeaderboard } from './toy-leaderboard.ts';
import { watchAgentUnlock } from './toy-unlock.ts';
import { loadTouchLayout } from './touch-layout-cloud.ts';
// 最后加载，覆盖桌面尺寸，不改变桌面的布局规则。
import './styles/mobile.css';

installViewport();
installTouchGuards();
installKillLeaderboard();
// Toy 用户的触控布局异步从玩家云存档预载；普通网页立即使用本机设置。
void loadTouchLayout();
// Toy 内提前校验角色解锁；从 B站 视频页切回来会自动复查。
watchAgentUnlock();

const sandbox = /^#sandbox\/?(\w*)/.exec(location.hash);
if (sandbox) {
  void import('./game/sandbox.ts').then((m) => m.runSandbox(document.getElementById('app')!, sandbox[1]));
} else {
  app.register('landing', landingScreen);
  app.register('lobby', lobbyScreen);
  app.register('room', roomScreen);
  app.register('match', matchScreen);
  app.start(document.getElementById('app')!);
}

declare global {
  interface Window {
    __APP: typeof app;
  }
}
window.__APP = app;
