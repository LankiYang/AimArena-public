export const TOUCH_CONTROL_IDS = [
  'stick', 'weapon1', 'weapon2', 'weapon3', 'fire', 'aim', 'reload', 'jump', 'crouch', 'walk', 'use',
] as const;
export type TouchControlId = (typeof TOUCH_CONTROL_IDS)[number];
export interface TouchPoint { x: number; y: number }
export type TouchLayout = Record<TouchControlId, TouchPoint>;

const DEFAULT_POINTS: TouchLayout = {
  stick: { x: 0.081, y: 0.824 },
  weapon1: { x: 0.19, y: 0.09 },
  weapon2: { x: 0.252, y: 0.09 },
  weapon3: { x: 0.314, y: 0.09 },
  fire: { x: 0.92, y: 0.826 },
  aim: { x: 0.822, y: 0.896 },
  reload: { x: 0.887, y: 0.616 },
  jump: { x: 0.952, y: 0.616 },
  crouch: { x: 0.822, y: 0.756 },
  walk: { x: 0.822, y: 0.616 },
  use: { x: 0.18, y: 0.824 },
};

// Older installations may have persisted the original untouched defaults.
// Only an exact match is treated as defaults; any edited layout remains unchanged.
const LEGACY_DEFAULT_POINTS: TouchLayout = {
  stick: { x: 0.15, y: 0.86 }, weapon1: { x: 0.08, y: 0.17 },
  weapon2: { x: 0.22, y: 0.17 }, weapon3: { x: 0.36, y: 0.17 },
  fire: { x: 0.84, y: 0.78 }, aim: { x: 0.7, y: 0.91 },
  reload: { x: 0.77, y: 0.58 }, jump: { x: 0.92, y: 0.58 },
  crouch: { x: 0.62, y: 0.78 }, walk: { x: 0.62, y: 0.58 },
  use: { x: 0.4, y: 0.79 },
};

export function isDefaultTouchLayout(layout: TouchLayout): boolean {
  return [DEFAULT_POINTS, LEGACY_DEFAULT_POINTS].some((defaults) =>
    TOUCH_CONTROL_IDS.every((id) => layout[id].x === defaults[id].x && layout[id].y === defaults[id].y));
}

export function defaultTouchLayout(): TouchLayout {
  return Object.fromEntries(TOUCH_CONTROL_IDS.map((id) => [id, { ...DEFAULT_POINTS[id] }])) as TouchLayout;
}

/** Reject incomplete/invalid persisted layouts; clamp valid coordinates away from the exact viewport edges. */
export function normalizeTouchLayout(value: unknown): TouchLayout | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const result = {} as TouchLayout;
  for (const id of TOUCH_CONTROL_IDS) {
    const point = input[id];
    if (!point || typeof point !== 'object' || Array.isArray(point)) return null;
    const { x, y } = point as Record<string, unknown>;
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 1 ||
        typeof y !== 'number' || !Number.isFinite(y) || y < 0 || y > 1) return null;
    result[id] = { x: Math.max(0.04, Math.min(0.96, x)), y: Math.max(0.08, Math.min(0.92, y)) };
  }
  return result;
}

export function cloneTouchLayout(layout: TouchLayout): TouchLayout {
  return Object.fromEntries(TOUCH_CONTROL_IDS.map((id) => [id, { ...layout[id] }])) as TouchLayout;
}
