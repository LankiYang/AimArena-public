'use strict';

// Units are metres. Y points up, X east, Z south. Every box is also a server collider.
const boxes = [];
function box(id, x, z, w, d, h = 3, material = 'plaster', extra = {}) {
  boxes.push({ id, x, y: h / 2, z, w, h, d, material, color: ({ plaster: '#d8bb98', terracotta: '#b76c4b', stone: '#a5aaa8', wood: '#77624c', metal: '#637d7d', trim: '#eee0c4' })[material] || '#d8bb98', kind: extra.building ? 'building' : (h < 2.5 || material === 'metal' || material === 'wood' ? 'crate' : 'wall'), ...extra });
}
// A three-lane Mediterranean courtyard study: A garden, mid market, B workshop.
box('boundary-west', -42, 0, 1, 69, 7, 'stone');
box('boundary-east', 42, 0, 1, 69, 7, 'stone');
box('boundary-north', 0, -34, 85, 1, 7, 'stone');
box('boundary-south', 0, 34, 85, 1, 7, 'stone');
// Spawn courtyard buildings leave three genuinely traversable routes.
box('attacker-house-west', -22, 29, 17, 8, 8, 'plaster', { building: true, roof: 'tile' });
box('attacker-house-east', 22, 29, 17, 8, 7, 'terracotta', { building: true, roof: 'tile' });
box('spawn-fountain', 0, 24, 3, 3, 0.7, 'stone');
box('a-wine-shop', -24, 12, 12, 13, 7, 'terracotta', { building: true, roof: 'tile' });
box('a-garden-wall', -37, 6, 9, 1, 2.3, 'plaster');
box('a-main-west-wall', -34, -3, 1.1, 10, 5, 'plaster');
box('a-main-east-wall', -15, -4, 1.2, 11, 5, 'plaster');
box('a-gate-west', -32, -7, 4, 1.2, 5, 'plaster');
box('a-gate-east', -18, -7, 5, 1.2, 5, 'plaster');
box('a-gate-lintel', -25, -7, 10, 1.2, 1.4, 'trim', { y: 4.3 });
box('a-site-well', -24, -17, 4.5, 4.5, 1.35, 'stone');
box('a-site-generator', -19, -14, 2.4, 2.8, 2.3, 'metal');
box('a-site-wine-crates', -31, -13, 3, 3, 1.6, 'wood');
box('a-terrace-west', -37, -23, 8, 14, 7, 'plaster', { building: true, roof: 'tile' });
box('a-terrace-north', -26, -29, 16, 6, 6.5, 'terracotta', { building: true, roof: 'tile' });
// Market buildings divide mid without creating an empty arena.
box('market-left', -9, 5, 7, 13, 7.5, 'plaster', { building: true, roof: 'tile' });
box('market-right', 9, 5, 7, 13, 8, 'terracotta', { building: true, roof: 'tile' });
box('mid-market-counter', -4.4, -5, 2, 4, 1.15, 'wood');
box('mid-market-stall', 5.2, -9, 4, 2.5, 1.4, 'wood');
box('mid-arch-left', -6, -16, 4, 1.2, 5, 'plaster');
box('mid-arch-right', 6, -16, 4, 1.2, 5, 'plaster');
box('mid-arch-lintel', 0, -16, 8, 1.2, 1.4, 'trim', { y: 4.3 });
box('defender-house', 0, -29, 15, 8, 9, 'plaster', { building: true, roof: 'tile' });
// B workshop approach, boathouse and the plant courtyard.
box('b-workshop', 25, 12, 13, 13, 8, 'plaster', { building: true, roof: 'tile' });
box('b-main-east-wall', 37, 0, 1.1, 15, 5, 'terracotta');
box('b-main-west-wall', 15, -4, 1.2, 11, 5, 'plaster');
box('b-gate-west', 18, -7, 5, 1.2, 5, 'plaster');
box('b-gate-east', 33, -7, 7, 1.2, 5, 'plaster');
box('b-gate-lintel', 25, -7, 10, 1.2, 1.4, 'trim', { y: 4.3 });
box('b-site-cargo', 24, -17, 4, 4, 2.3, 'metal');
box('b-site-box-stack', 31, -12, 3, 3, 1.4, 'wood');
box('b-boathouse', 37, -24, 8, 16, 7.5, 'terracotta', { building: true, roof: 'tile' });
box('b-defender-store', 25, -29, 15, 6, 6, 'plaster', { building: true, roof: 'tile' });
// Low cover at route decisions; no invisible collision meshes.
box('attack-a-cover', -11, 20, 3, 1.2, 1.1, 'stone');
box('attack-b-cover', 12, 20, 3, 1.2, 1.1, 'stone');
box('a-link-cover', -10, -20, 2.8, 1.6, 1.2, 'wood');
box('b-link-cover', 11, -21, 2.8, 1.6, 1.2, 'wood');

const MAP = {
  id: 'ascent-study', name: 'Ascent study', description: 'Original Mediterranean two-site tactical layout; not an extracted Riot map.',
  bounds: { minX: -41, maxX: 41, minZ: -33, maxZ: 33 },
  boxes,
  sites: [{ id: 'A', x: -25, y: 0, z: -13, radius: 7 }, { id: 'B', x: 25, y: 0, z: -13, radius: 7 }],
  spawns: {
    attack: [-8, -4, 0, 4, 8].map(x => ({ x, y: 0, z: 29, yaw: 0 })),
    defend: [-30, -20, -11, 11, 29].map(x => ({ x, y: 0, z: -24, yaw: Math.PI }))
  }
};
module.exports = { MAP };
