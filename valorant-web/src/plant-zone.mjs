export function isInPlantZone(player, site) {
  if (Math.abs(player.y - (site.y || 0)) >= (site.heightTolerance ?? 2.5)) return false;
  if (!site.area) return Math.hypot(player.x-site.x,player.z-site.z) <= site.radius;
  const [left,right,top,bottom] = site.area;
  return player.x>=left && player.x<=right && player.z>=top && player.z<=bottom;
}
