// main.ts — 前端入口
import './styles/base.css';
import './styles/screens.css';
import { app } from './app.ts';
import { landingScreen } from './ui/landing.ts';
import { lobbyScreen } from './ui/lobby.ts';
import { roomScreen } from './ui/room.ts';
import { matchScreen } from './match-screen.ts';
import { installViewport, installTouchGuards } from './viewport.ts';
// 最后加载，覆盖桌面尺寸，不改变桌面的布局规则。
import './styles/mobile.css';

installViewport();
installTouchGuards();

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
