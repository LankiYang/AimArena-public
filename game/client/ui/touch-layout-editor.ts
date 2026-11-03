import { cloneTouchLayout, defaultTouchLayout, isDefaultTouchLayout, TOUCH_CONTROL_IDS, type TouchControlId, type TouchLayout } from '../touch-layout.ts';
import { loadTouchLayout, saveTouchLayout } from '../touch-layout-cloud.ts';
import { h } from './dom.ts';
import { modal, toast } from './overlay.ts';
import '../styles/touch-layout-editor.css';

const LABELS: Record<TouchControlId, string> = {
  stick: '移动摇杆', weapon1: '主武器', weapon2: '副武器', weapon3: '近战', fire: '开火', aim: '开镜',
  reload: '换弹', jump: '跳跃', crouch: '蹲', walk: '静步', use: '使用',
};

export function openTouchLayoutEditor(opener?: HTMLElement, onSave?: () => void) {
  let layout: TouchLayout = cloneTouchLayout(defaultTouchLayout());
  let active = true;
  let ready = false;
  const stage = h('div', { class: 'touch-layout-stage', 'data-testid': 'touch-layout-stage' });
  const status = h('div', { class: 'field-hint', role: 'status', 'data-testid': 'touch-layout-status' }, '读取玩家云存档…');
  const handles = new Map<TouchControlId, HTMLButtonElement>();
  for (const id of TOUCH_CONTROL_IDS) {
    const handle = h('button', {
      class: ['touch-layout-handle', `is-${id}`], type: 'button', 'data-testid': `touch-layout-handle-${id}`,
      'aria-label': `${LABELS[id]}，拖动调整位置`, disabled: true,
    }, id === 'stick' ? '摇杆' : id === 'weapon1' ? '1' : id === 'weapon2' ? '2' : id === 'weapon3' ? '3' : LABELS[id]);
    handles.set(id, handle);
    stage.append(handle);
  }
  const render = () => {
    for (const id of TOUCH_CONTROL_IDS) {
      const p = layout[id];
      const handle = handles.get(id)!;
      handle.style.left = `${p.x * 100}%`;
      handle.style.top = `${p.y * 100}%`;
    }
  };
  const reset = h('button', {
    class: 'btn ghost sm', type: 'button', 'data-testid': 'touch-layout-reset', disabled: true,
    onclick: () => { layout = defaultTouchLayout(); render(); },
  }, '恢复默认');
  for (const [id, handle] of handles) {
    let pointer: number | null = null;
    handle.addEventListener('pointerdown', (e: PointerEvent) => {
      if (!ready || pointer !== null) return;
      e.preventDefault();
      pointer = e.pointerId;
      handle.classList.add('dragging');
      try { handle.setPointerCapture(e.pointerId); } catch {}
    });
    handle.addEventListener('pointermove', (e: PointerEvent) => {
      if (pointer !== e.pointerId) return;
      e.preventDefault();
      const rect = stage.getBoundingClientRect();
      layout[id] = {
        x: Math.max(0.04, Math.min(0.96, (e.clientX - rect.left) / rect.width)),
        y: Math.max(0.08, Math.min(0.92, (e.clientY - rect.top) / rect.height)),
      };
      render();
    });
    const end = (e: PointerEvent) => {
      if (pointer !== e.pointerId) return;
      pointer = null;
      handle.classList.remove('dragging');
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('lostpointercapture', end);
  }
  const body = h('div', { class: 'touch-layout-editor' },
    h('p', { class: 'field-hint' }, '默认布局会适应屏幕尺寸，预览为参考位置；拖动后按屏幕比例保存。左半屏仅移动，右半屏拖动视角。爆破「使用」键只在爆破模式显示。'),
    h('div', { class: 'touch-layout-stage-wrap' }, stage),
    h('div', { class: 'touch-layout-tools' }, reset, status),
  );
  modal({
    title: '自定义触控布局', sub: 'B站 Toy 可云同步；普通网页保存到本机', body, wide: true,
    testid: 'touch-layout-editor', cancelText: '取消', okText: '保存布局', okTestid: 'touch-layout-save',
    onOk: async () => {
      const result = await saveTouchLayout(layout);
      onSave?.();
      status.textContent = result.message;
      if (result.supported && !result.cloud) {
        toast(result.message, 'err', 5000);
        return false;
      }
      toast(result.message, 'ok');
      return true;
    },
    onClose: () => { active = false; opener?.focus(); },
  });
  render();
  void loadTouchLayout().then((result) => {
    if (!active) return;
    layout = isDefaultTouchLayout(result.layout) ? defaultTouchLayout() : cloneTouchLayout(result.layout);
    status.textContent = result.message;
    ready = true;
    for (const handle of handles.values()) handle.disabled = false;
    reset.disabled = false;
    render();
  });
}
