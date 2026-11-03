import { profile, saveProfile } from './profile.ts';
import { cloneTouchLayout, normalizeTouchLayout, type TouchLayout } from './touch-layout.ts';

export interface TouchLayoutLoad {
  layout: TouchLayout;
  source: 'local';
  message: string;
}

const listeners = new Set<(layout: TouchLayout) => void>();
export function subscribeTouchLayout(listener: (layout: TouchLayout) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function loadTouchLayout(): Promise<TouchLayoutLoad> {
  return { layout: cloneTouchLayout(profile.touchLayout), source: 'local', message: '使用本机布局' };
}

export async function saveTouchLayout(layout: TouchLayout): Promise<{ supported: boolean; cloud: boolean; message: string }> {
  const normalized = normalizeTouchLayout(layout);
  if (!normalized) throw new Error('触控布局数据无效');
  saveProfile({ touchLayout: normalized });
  for (const listener of listeners) listener(cloneTouchLayout(normalized));
  return { supported: false, cloud: false, message: '触控布局已保存在本机' };
}
