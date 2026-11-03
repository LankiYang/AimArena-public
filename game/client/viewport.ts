// 浏览器工具栏、软键盘和旋转都会改变可见视口；不要把手机当成固定 100vh。
export function installViewport(): () => void {
  const root = document.documentElement;
  const viewport = window.visualViewport;
  let frame = 0;
  const sync = () => {
    // 放大页面时保留浏览器原生缩放，不用视口同步反向抵消辅助缩放。
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
    const height = `${Math.round(viewport?.height ?? innerHeight)}px`, top = `${Math.round(viewport?.offsetTop ?? 0)}px`;
    if (root.style.getPropertyValue('--viewport-height') !== height) root.style.setProperty('--viewport-height', height);
    if (root.style.getPropertyValue('--viewport-top') !== top) root.style.setProperty('--viewport-top', top);
  };
  const schedule = () => {
    // WebGL 忙时下一帧可能很迟；旋转/工具栏改变后先同步，避免底部控件还停在旧屏幕之外。
    sync();
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; sync(); });
  };
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  viewport?.addEventListener('resize', schedule);
  viewport?.addEventListener('scroll', schedule);
  sync();
  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener('resize', schedule);
    window.removeEventListener('orientationchange', schedule);
    viewport?.removeEventListener('resize', schedule);
    viewport?.removeEventListener('scroll', schedule);
    root.style.removeProperty('--viewport-height');
    root.style.removeProperty('--viewport-top');
  };
}

/** 禁掉浏览器层面的长按菜单、双击缩放和 iOS 双指缩放；游戏内的多点触控仍走 Pointer Events */
export function installTouchGuards(): () => void {
  const stop = (e: Event) => e.preventDefault();
  const context = (e: Event) => {
    const t = e.target as Element | null;
    if (t?.closest('input, textarea, [contenteditable="true"]')) return;
    e.preventDefault();
  };
  const dbl = (e: MouseEvent) => {
    if (e.button === 0) e.preventDefault();
  };
  document.addEventListener('gesturestart', stop, { passive: false });
  document.addEventListener('gesturechange', stop, { passive: false });
  document.addEventListener('gestureend', stop, { passive: false });
  document.addEventListener('contextmenu', context);
  document.addEventListener('dblclick', dbl as EventListener, { passive: false });
  return () => {
    document.removeEventListener('gesturestart', stop);
    document.removeEventListener('gesturechange', stop);
    document.removeEventListener('gestureend', stop);
    document.removeEventListener('contextmenu', context);
    document.removeEventListener('dblclick', dbl as EventListener);
  };
}
