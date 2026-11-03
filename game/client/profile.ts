// profile.ts — 本地偏好（昵称、角色、灵敏度、音量、准星），存 localStorage
import type { AgentId } from '../shared/catalog.ts';
import { AGENTS, isAgentId } from '../shared/catalog.ts';

import { defaultTouchLayout, normalizeTouchLayout, type TouchLayout } from './touch-layout.ts';
export type ControlMode = 'auto' | 'touch' | 'mouse';

export interface Profile {
  name: string;
  agent: AgentId;
  /** 战术射击标准灵敏度数值（0.07 度/计数 × sens） */
  sensitivity: number;
  adsMultiplier: number;
  volume: number;
  crosshairColor: string;
  fov: number;
  /** 操作模式：自动识别 / 强制触屏 / 强制键鼠（设置里可手动切） */
  controlMode: ControlMode;
  /** 手机/平板控件中心点，按视口比例保存；Toy 云存档作为跨设备来源。 */
  touchLayout: TouchLayout;
}

const KEY = 'vpvp.profile.v1';
const DEFAULTS: Profile = {
  name: '',
  agent: AGENTS[0].id,
  sensitivity: 0.4,
  adsMultiplier: 1,
  volume: 0.7,
  crosshairColor: '#00ff9c',
  fov: 103,
  controlMode: 'auto',
  touchLayout: defaultTouchLayout(),
};

function load(): Profile {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    const p = { ...DEFAULTS, ...raw };
    if (!isAgentId(p.agent)) p.agent = DEFAULTS.agent;
    p.sensitivity = clamp(Number(p.sensitivity) || DEFAULTS.sensitivity, 0.01, 10);
    p.adsMultiplier = clamp(Number(p.adsMultiplier) || 1, 0.1, 3);
    p.volume = clamp(Number(p.volume), 0, 1);
    p.fov = clamp(Number(p.fov) || DEFAULTS.fov, 70, 110);
    p.touchLayout = normalizeTouchLayout(p.touchLayout) ?? defaultTouchLayout();
    if (p.controlMode !== 'touch' && p.controlMode !== 'mouse' && p.controlMode !== 'auto') p.controlMode = 'auto';
    return p;
  } catch {
    return { ...DEFAULTS };
  }
}
const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo);

export const profile: Profile = load();

export function saveProfile(patch: Partial<Profile>) {
  Object.assign(profile, patch);
  try {
    localStorage.setItem(KEY, JSON.stringify(profile));
  } catch {}
}
