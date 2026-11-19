const TAU = Math.PI * 2;
const mix = (a, b, t) => a + (b - a) * t;
export const angleDelta = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

// Render one and a half server updates behind the estimated clock. This
// removes the 20 Hz catch-up pulses that otherwise feed the gait controller.
export class RemotePose {
  constructor() { this.samples = []; this.time = -Infinity; this.yaw = 0; }

  update(player, serverTime, now, dt) {
    const list = this.samples, last = list.at(-1);
    let reset = !last;
    if (last?.time !== serverTime) {
      reset ||= (player.alive && !last.alive) || Math.hypot(player.x - last.x, player.y - last.y, player.z - last.z) > 3.5;
      if (reset) {
        list.length = 0;
        this.time = -Infinity;
        this.yaw = player.yaw;
      }
      list.push({ x: player.x, y: player.y, z: player.z, yaw: player.yaw, pitch: player.pitch, grounded: player.grounded, crouch: player.crouch, alive: player.alive, time: serverTime });
      if (list.length > 8) list.shift();
    }
    this.time = Math.max(this.time, now - 75);
    while (list.length > 2 && list[1].time <= this.time) list.shift();
    const a = list[0], b = list[1] || a;
    const t = a === b ? 0 : Math.max(0, Math.min(1, (this.time - a.time) / (b.time - a.time)));
    const goal = a.yaw + angleDelta(a.yaw, b.yaw) * t;
    const turn = angleDelta(this.yaw, goal) * (1 - Math.exp(-(player.bot ? 14 : 24) * dt));
    const limit = (player.bot ? 11 : 24) * dt;
    this.yaw = (this.yaw + Math.max(-limit, Math.min(limit, turn))) % TAU;
    const discrete = t < .5 ? a : b;
    return { x: mix(a.x, b.x, t), y: mix(a.y, b.y, t), z: mix(a.z, b.z, t), yaw: this.yaw, pitch: mix(a.pitch, b.pitch, t), grounded: discrete.grounded, crouch: discrete.crouch, reset };
  }
}
