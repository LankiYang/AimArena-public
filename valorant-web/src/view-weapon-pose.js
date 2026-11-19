// Camera-relative weapon placement. Both real palm sockets follow this frame.
export const VIEW_WEAPON_POSE = Object.freeze({
  position: Object.freeze([.24, -.14, -.40]),
  rotation: Object.freeze([.03, .22, .32])
});

export function applyViewWeaponPose(root, {bob = 0, moving = false, recoil = 0, reloadRoll = 0} = {}) {
  const [x, y, z] = VIEW_WEAPON_POSE.position;
  const [pitch, yaw, roll] = VIEW_WEAPON_POSE.rotation;
  root.position.set(x + Math.sin(bob) * .006 * (moving ? 1 : .2), y + Math.abs(Math.cos(bob)) * .009 * (moving ? 1 : .15) - recoil * .35, z + recoil);
  root.rotation.set(pitch + recoil * 1.5, yaw, roll + reloadRoll, 'XYZ');
}
