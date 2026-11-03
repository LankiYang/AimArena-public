import type { WeaponId } from '../combat.ts';

export interface SourceBurst { shotsPerEntry: number; internalRatePerSecond: number; recoverySeconds: number }
export interface SourceAds { fireRateMultiplier: number; levels: readonly { zoomMultiplier: number; fov1PDegrees: number }[]; movementRatio: number; transitionSeconds: number; zoomOutSeconds: number; zoomLockAfterShotSeconds: number; unscopeAfterShot: boolean; burst: SourceBurst | null }

type Profile = { runSpeed: number; stability: { ads: SourceAds; pelletErrorRetries: number } | null };
const gun = (runSpeed: number, zoom = 0, sniper = false): Profile => ({ runSpeed, stability: { pelletErrorRetries: 0, ads: {
  fireRateMultiplier: 1, levels: zoom ? [{ zoomMultiplier: zoom, fov1PDegrees: 65 / zoom }] : [], movementRatio: zoom ? 0.8 : 1,
  transitionSeconds: 0.2, zoomOutSeconds: 0.15, zoomLockAfterShotSeconds: sniper ? 0.6 : 0,
  unscopeAfterShot: sniper, burst: null,
} } });
/** Project-authored movement and aiming profiles. */
export const SOURCE_WEAPONS: Record<WeaponId, Profile> = {
  classic: gun(5.8), shorty: gun(5.6), frenzy: gun(5.8), ghost: gun(5.8), sheriff: gun(5.6),
  stinger: gun(5.7, 1.2), spectre: gun(5.6, 1.2), bucky: gun(5.4), judge: gun(5.3),
  bulldog: gun(5.3, 1.3), guardian: gun(5.3, 1.5), phantom: gun(5.3, 1.3), vandal: gun(5.3, 1.3),
  marshal: gun(5.2, 2.5, true), outlaw: gun(5.1, 2.5, true), operator: gun(4.9, 3, true),
  ares: gun(5, 1.2), odin: gun(4.8, 1.2), melee: { runSpeed: 6.75, stability: null },
};
