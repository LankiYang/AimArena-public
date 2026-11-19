# 浏览器在线战术 FPS 技术调研与当前实现

调研日期：2026-11-17。编码：UTF-8。

## 已核实的官方资料

以下页面已在线读取核对。引擎能力不能代替实际内容制作、联网实测和素材许可。

| 方案 | 官网证据 | 本项目判断 |
| --- | --- | --- |
| Babylon.js | https://www.babylonjs.com/specifications/ | 提供 WebGPU / WebGL 2、PBR、glTF、骨骼动画、Havok。适合希望完整工具链的新项目。 |
| Three.js | https://threejs.org/docs/pages/WebGPURenderer.html | 新 WebGPURenderer 支持 WebGPU，并可回退 WebGL 2。本切片沿用熟悉的 Three.js WebGL 渲染路线；图形库不自带战术 FPS 规则或权威联网。 |
| PlayCanvas | https://developer.playcanvas.com/user-manual/graphics/ | 官方列出 PBR、WebGPU / WebGL 2、骨骼和 Morph、Basis 压缩、批处理、实例化和烘焙照明。WebGPU 当时仍标记 Beta。 |
| Colyseus 0.18 | https://docs.colyseus.io/netcode | 当前版本提供固定步长输入、客户端预测、校正、插值和回溯命中，适合后续替代自写协议。部分综合演示源码仅向赞助者开放。 |
| 客户端预测 | https://docs.colyseus.io/netcode/client-prediction | 本机响应、服务器确认后回退重放、其他玩家插值必须采用一致的状态与模拟规则。 |
| 命中补偿 | https://docs.colyseus.io/netcode/lag-compensation | 服务器回看目标在射击者看到的时刻的位置；回溯窗口须限制并与客户端插值延迟匹配。 |
| WebGPU 兼容性 | https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API | 仍非所有主流浏览器通用；要求安全上下文，不能只做 WebGPU。 |

## 当前切片的服务端结构

运行 `node server.cjs`，默认端口 3000，或通过 `PORT` 指定。HTTP 和 WebSocket 共用端口。服务器监听 `0.0.0.0`，相同局域网设备可访问主机 IP。最近一次临时公网入口及实测结果记录于 `artifacts/public-smoke.json`，依赖本机服务器与 tunnel 进程持续运行，非长期部署。

- Node.js + `ws`，每房间最多 10 人，每队最多 5 人。没有机器人，也没有用本地假人冒充其他玩家。
- 目标 60Hz 权威移动和规则模拟、20Hz 快照，实际频率受主机负载影响，尚未证明 10 人持续 60Hz。客户端 `dt` 不决定服务器速度；输入向量归一化，固定最大速度，碰撞和冲刺都由服务器约束。
- 服务端维护世界碰撞、视点射线、弹药、射速、装填、护甲、购买、技能冷却、回合、装拆包和胜负。客户端不提交位置或伤害结果。
- 命中回看其他玩家最多 200ms 的位置历史。当前是简化回溯，尚未与完整客户端插值时间线、射击起点回溯和反作弊系统结合，不能声称达到竞技商业产品的网络公平性。
- `GET /maps.json` 列出 13 张发布包地图；`GET /world.json?map=<地图 ID>` 返回对应地图描述，不带 map 时返回 `ascent-full`。
- 亚海悬城的十块渲染模型与 17,166 个碰撞体积分开加载，碰撞按 X/Z 网格索引，在客户端与服务器上运行同一套移动和地面查询。B 区节选和原创布局仅在隔离自测中使用。

## 客户端协议

所有消息都是 UTF-8 JSON。方向为 Y 向上；玩家 `y` 表示脚底，站姿视点 `y + 1.62`，蹲姿视点 `y + 1.05`。`yaw=0` 朝向世界 `-Z`，前方向 `(sin(yaw), -cos(yaw))`。`pitch>0` 向上。输入 `moveX`、`moveZ` 已是世界 X/Z 向量。

```js
// Client -> server
{ type: 'join', name, room, map: 'ascent-full', agent: 'jett'|'sage', team: 'attack'|'defend' } // map 可用 /maps.json 中任一 ID
{ type: 'input', seq, dt, moveX, moveZ, yaw, pitch, jump, walk, crouch }
{ type: 'fire', shotId, yaw, pitch, clientTime } // clientTime = Date.now() epoch milliseconds
{ type: 'reload' }
{ type: 'buy', weapon: 'phantom'|'armor' }
{ type: 'ability', skill: 'smoke'|'updraft'|'dash'|'wall'|'slow'|'heal', x?, z? }
{ type: 'interact', action: 'start'|'stop' } // hold F; release must send stop
{ type: 'ready' } // shortens current buy phase to at most 3 seconds
{ type: 'ping', clientTime }
```

```js
// Server -> client
{ type: 'welcome', selfId, room, map, mapId, world, serverTime, weapons }
{
  type: 'snapshot', serverTime, tick, selfId, ackSeq, room, mapId,
  phase: 'waiting'|'buy'|'live'|'end', phaseEndsAt, round,
  score: { attack, defend },
  players: [{
    id, name, team, agent, x, y, z, vy, grounded, speed, yaw, pitch, crouch, hp, armor, alive,
    weapon, ammo, reserve, credits, reloading, hasBomb, ackSeq,
    abilityCooldowns: { smoke, updraft, dash, wall, slow, heal }
  }],
  bomb: null|{
    state: 'carried'|'dropped'|'planting'|'planted'|'defusing'|'defused'|'exploded',
    carrierId, interactorId, x, y, z, site, progress, endsAt
  },
  smokes: [{ id, x, y, z, radius, endsAt, team }],
  barriers: [{ id, x, y, z, w, h, d, hp, endsAt, team }],
  slows: [{ id, x, y, z, radius, endsAt, team }],
  lastResult: null|{ winner, reason, round }
}
{ type: 'event', event, serverTime, ...eventData }
{ type: 'error', code, message }
{ type: 'pong', clientTime, serverTime }
```

`phaseEndsAt`、`reloading`、`abilityCooldowns` 和烟雾/炸弹 `endsAt` 均为服务器 epoch 毫秒时间戳。`0` 表示没有计时。`ackSeq` 表示服务器已经采纳的最新输入；当前服务器保留最新输入，不是每个输入独立积累客户端 `dt` 的模拟。

事件包括 `joined`、`left`、`purchase`、`shot`（包含真实服务器 `origin`、`end`）、`hit`、`kill`、`reload`、`ability`、`roundStart`、`live`、`roundEnd`、`plantStart`、`plant`、`defuseStart`、`defuse`、`pickup`。

默认购买 20 秒、战斗 100 秒、回合结束 5 秒。必须存在双方玩家才开始。等待阶段允许单人走动、开枪和技能以检查内容，伤害最低保留 1HP。初始 8000 资金便于评估购买和护甲，这是演示规则，不是原作经济的逐项还原。默认及唯一开放的武器为 Phantom，另可购买护甲。Jett 的 C/Q/E 是烟雾、上升气流、冲刺，Sage 的 C/Q/E 是冰墙、减速区域、自疗；装拆包为 F。上升气流设置服务端 vy=7.5，四段冰墙各 400HP、持续 25 秒，可被射击破坏，并参与玩家与射线碰撞；墙段使用包围盒近似斜向旋转。减速半径 4.5 米、持续 7 秒，仅敌方地面速度乘 0.45。冷却替代原作有限次数/技能购买，没有终极技能。

## 自测与验收边界

执行 `node --test server.test.cjs`。真实启动 HTTP/WebSocket 服务器和两条实际客户端连接，检查：

1. 同一地图的门洞可通行、建筑和外墙阻挡、双方出生位置不嵌墙。
2. 加房、两队启动、购买、服务器限制输入速度和拒绝旧输入序列。
3. 实体建筑阻挡射击、冲刺撞墙、烟雾、自疗冷却、击杀、记分与下一回合。
4. 上升气流、减速区、冰墙放置校验、移动阻挡、挡枪与射击破坏。
5. 安装保持和取消、成功安装、拆除获胜、另一回合爆炸获胜。
6. HTTP 地图、健康接口和服务端源码禁止访问。
7. 恶意武器键 `__proto__` / `constructor` 等不能破坏资金和武器状态；坏 JSON、非数值移动被拒绝；Sage 不能使用 Jett 烟雾。一次有界的 400 消息突发期间，另一客户端仍能收到 pong，模拟 tick 持续推进。此检查不是高并发压力基准。

命中和炸弹场景采用明确的服务器位置 fixture 加速布置，操作消息仍通过真实 WebSocket。它验证服务端和协议，不能冒充两台设备的完整实机游戏、公网延迟、画面帧率或高并发压力测试。

精致可玩切片还需针对目标设备验收：例如约定 1080p 中档电脑平均 60FPS、1% low ≥45FPS、冷启动下载包 30～60MB，并实际记录。需要一致资产风格、完整 PBR 贴图、武器第一人称绑定动画、角色运动混合、LOD、KTX2、meshopt/Draco、烘焙光照和加载分包。免费模型不自动保证这些制作步骤已经完成。

在现成授权资产、单张图、两角色、三把枪的假设下，2～4 人完成经过打磨的完整联机切片可以先按 6～12 周估算；这不是当前会话的交付承诺。全地图、全角色、全武器和全部技能的 1:1 成品需要长周期团队、美术生产及权利许可，不能把原型称为该成品。

## 退役地图入口

`/ascent-preview.html` 跳转到亚海悬城全图。旧版分享链接中的 `ascent-b` 和 `ascent-study` 会替换为 `ascent-full` 并保留房间码。直接向游戏服务请求旧地图会收到 `MAP_UNAVAILABLE`。

## 地图房间与初始化

`createGameServer()` 保持同步，地图由调用方显式传入。主入口加载 13 张发布包地图，再传入 `createGameServer({releaseWorlds})`。Windows 启动脚本使用同一入口。房间首位玩家锁定 `mapId`，选择另一张可用地图会收到 `MAP_MISMATCH`；省略地图时采用现有房间地图，新房间默认亚海悬城全图。welcome.world 是房间地图描述，后续每个快照带 mapId。

玩家 y 仍为脚底；快照新增 vy、grounded、speed，供精确预测与减速校正。B 模式没有地面盒子回退；掉出原模型边界后发 `sourceGapReset` 并回到本方安全点。购买期 B 模式限制在出生点 4 米范围内，属于单站点开发规则。源几何射线保留双面命中，玩家移动按真实胶囊分步求解；冰墙仍是动态可破坏包围盒。

新增双实际 socket Ascent 测试检查地图锁定、实际地面行走、源墙胶囊阻挡、射线命中相同三角面、上升气流/冲刺、真实 B 点安装/拆除、脚底高度和新增快照字段。仍不代表完整 Ascent、原版纹理或正式高并发验证。
