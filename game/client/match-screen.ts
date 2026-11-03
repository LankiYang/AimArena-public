// match-screen.ts — 对局界面：加载画面 → 对局运行时（game/match.ts）
//   界面被销毁（切走 / 断线退回）时先 abort 再 dispose：加载中的 startMatch 会在每个 await 后看到 signal 已中止，
//   直接清掉已经建出来的资源并返回空运行时——不会随后再注册 handler、再挂画布。
import { app, type Screen } from './app.ts';
import { startMatch, type MatchRuntime } from './game/match.ts';
import { h } from './ui/dom.ts';
import { linkNotice } from './ui/link.ts';
import { loadingView } from './ui/loading.ts';
import { toast } from './ui/overlay.ts';

export function matchScreen(): Screen {
  const m = app.match!;
  const members = app.room?.members ?? [];
  const lv = loadingView(m.settings, members);
  // 断线提示：对局画面不会自己停下，但玩家要知道现在收不到数据、座位还在等他
  const net = h('div', { class: 'net-banner', role: 'status', 'data-testid': 'match-link', hidden: true });
  const el = h('div', null, lv.el, net);
  const ac = new AbortController();
  let rt: MatchRuntime | null = null;
  let disposed = false;

  const leave = () => {
    app.conn?.send({ t: 'leaveMatch' });
    app.match = null;
    app.route();
  };

  startMatch({
    root: el,
    conn: app.conn!,
    settings: m.settings,
    members,
    getMembers: () => app.room?.members ?? members,
    myId: m.you,
    myTeam: m.team,
    resumeView: m.resumeView,
    onProgress: (p, t) => lv.progress(p, t),
    onFirstSnapshot: () => lv.el.remove(),
    onLeave: leave,
    signal: ac.signal,
  })
    .then((r) => {
      // 加载期间就被销毁：运行时不认领，直接丢掉它建的东西
      if (disposed || ac.signal.aborted) return r.dispose();
      rt = r;
    })
    .catch((e) => {
      if (disposed || ac.signal.aborted) return;
      console.error('[match]', e);
      toast('进入对局失败：' + (e?.message ?? e));
      leave();
    });

  return {
    el,
    update() {
      lv.setQueue(app.match?.queue ?? null);
      const notice = linkNotice();
      net.textContent = notice ?? '';
      net.hidden = !notice;
    },
    dispose() {
      if (disposed) return; // 幂等：路由可能因为断线连调两次
      disposed = true;
      if (rt) m.resumeView = rt.captureView();
      ac.abort();
      rt?.dispose();
      rt = null;
    },
  };
}