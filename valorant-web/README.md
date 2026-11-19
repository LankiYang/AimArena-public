# 无畏契约网页研究项目 · 在线开发切片

这是一个可以用真实浏览器客户端加入房间的战术 FPS 开发切片。当前包含两名可选角色、一把实际可用 Phantom、原版 B 区几何对战与原创双点 study 地图，以及由服务器裁定的移动、开火、技能、购买、装拆包和回合胜负。项目仍处于内容与联机体验验证阶段，**不是原作全量 1:1 网页成品**。

## 启动与进入

Windows 下双击 `启动游戏.cmd`。脚本优先寻找系统可用的 Node.js，其次尝试本机 Codex 的 bundled Node 路径：

```text
%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe
```

脚本只启动本项目服务并打开浏览器，不安装软件，不改系统配置、防火墙或路由器。首次克隆后，在本目录使用 Node.js 22+ 运行 `npm install` 或 `pnpm install` 安装依赖。

默认地址：[http://localhost:3000](http://localhost:3000)。启动脚本会识别现有本项目服务并直接打开。关闭浏览器不会停止服务器；关闭启动窗口或按 `Ctrl+C` 可停止由该窗口新启动的服务。

也可以在本目录手动运行：

```powershell
node server.cjs
```

如果 `node` 不在 PATH 中，本机可以直接使用：

```powershell
& "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" server.cjs
```

## 怎样测试真人联机

1. 输入昵称和房间码，选择角色与阵营，进入房间。单人时是等待与自由探索阶段，没有机器人。
2. 同一台电脑可开两个浏览器窗口，使用同一地图、同一个房间码并选择不同阵营，验证连接与回合流程；实际操作两名玩家建议使用两台设备。
3. 局域网第二台设备访问 `http://服务器电脑的局域网IP:3000`。双方地图和房间码必须相同，至少有一名进攻方与一名防守方才会开始回合。房间第一位玩家选定地图后锁定；选择另一地图进入同名房间会被拒绝。
4. `localhost` 只表示当前设备；第二台电脑访问自己的 `localhost` 不会连接到第一台电脑。

服务器监听 `0.0.0.0`，允许主机各网络接口接入。局域网是否可达仍取决于现有网络条件；本项目不自动更改网络权限。临时隧道依赖本机服务器与 tunnel 进程持续运行，进程关闭或临时隧道失效后不可用；这不是长期部署或正式公网运维。

## 操作

| 按键 | 操作 |
| --- | --- |
| WASD / 鼠标 | 移动 / 观察 |
| 鼠标左键 / 右键 | 射击 / 缩放瞄准 |
| Space / 左 Ctrl / 左 Shift | 跳跃 / 蹲下 / 慢走 |
| R / B | 换弹 / 购买界面 |
| Jett：C / Q / E | 烟雾 / 上升气流 / 冲刺 |
| Sage：C / Q / E | 可破坏冰墙 / 减速区域 / 自疗 |
| 按住 F | 进攻方携包在地图站点安装（原版节选仅 B 点）；防守方在爆能器旁拆除 |
| Enter / Tab / Esc | 准备 / 记分板 / 暂停与离开 |

进入房间后点击继续，允许浏览器锁定鼠标。购买阶段为 20 秒；点击准备或按 Enter 可缩短至约 3 秒。战斗阶段为 100 秒，回合结束停留 5 秒。初始 8000 资金是为了方便检查内容，经济和部分参数采用演示规则。

## 当前内容的实际状态

- **角色：** Jett、Sage 使用真实 GLB 模型、内嵌材质、骨骼及其现有持枪待机动画。第一人称手臂从原蒙皮顶点裁切，使用双骨 IK 对齐枪械；远端角色增加程序化跑走、侧移、蹲伏、跳落地、受击与施法过渡，并绑定真实 Phantom。骨长保持、蹲伏不压缩人物。以上过渡并非原作完整动画，换弹/技能手部动作仍需继续制作。
- **武器：** 当前实际加载的是 gkari 的 **Radiant Entertainment System Phantom** 三维模型。当前只开放 Phantom 与护甲购买，默认持有 Phantom；Classic、Spectre、Vandal 等配置仅保留供后续开发，未开放为可用武器。
- **环境：** 主游戏支持 **Ascent B 原版部分几何** 与原创地中海双点 **Ascent study** 两种地图。B 模式按真实 192,209 个源三角面进行玩家胶囊碰撞、射击射线和冲刺检测，地面高度由原几何决定，单个 B 站点支持真实玩家回合与装拆包；源缺口保留，坠落后重置。在不改变原始顶点的情况下重建墙面/铺地等 PBR 材质，增加天空、阳光阴影与远景；这些是重建材质，原版纹理缺失，仍不是完整 Ascent 的逐项还原。
- **地图研究：** `assets/maps/ascent-b.glb` 是原版 B 区部分几何的独立研究素材，缺少原作完整纹理和部分区域，现已接入独立的 B 区 PVP 地图选项，同时保留纯漫游页面。独立漫游页面为 [/ascent-preview.html](http://localhost:3000/ascent-preview.html)，临时公网也可在相同路径访问。它使用原几何的胶囊碰撞，保留原有缺口，坠落后重置；纯漫游页面不连接对战房间；主游戏的 B 模式与 study 模式分别锁定房间，不是整张 Ascent，也没有将缺失纹理伪装成已还原。其状态、来源和转换条件另有记录。
- **技能：** Jett 支持烟雾、上升气流、冲刺；Sage 支持四段各 400HP、持续 25 秒的可破坏冰墙，半径 4.5 米、持续 7 秒的减速区域及自疗。当前以冷却替代原作有限次数/购买，墙体采用分段包围盒，减速只作用于敌方，均为开发规则；终极技能未实现。
- **联网：** 房间内其他玩家来自实际连接，没有自动补位机器人。服务端目标模拟 60Hz、快照 20Hz，验证速度、碰撞、弹药、射速和技能冷却，并裁定射线命中及回合结果；实际频率受负载影响。目前仅验证本机 10 条真实 socket 的 3 秒有界检查，未证明持续 60Hz 或正式容量。当前采用简化的延迟补偿。

素材作者、源链接与许可记录见 [ASSETS.md](ASSETS.md)。技术依据、协议与测试边界见 [docs/TECH-RESEARCH.md](docs/TECH-RESEARCH.md)。

第一人称目前共用 Cransh 的 AK-74M 动画模型，包含持枪待机、走、跑、射击与换弹。武器栏与服务器规则保留原配置，第三人称仍使用原先的角色和 Phantom 资源。旧第一人称 IK 已退出游戏渲染，其历史实验由 `npm run test:legacy-arms` 单独运行。

尚未实现：原作全特工、全地图、全枪独立模型、所有终极技能、1:1 动画、完整反作弊、匹配、账户系统、128 tick、正式公网部署与长期运维。当前界面和内容旨在支撑后续开发评估，不代表这些项目已经完成。

## 自测

在本目录运行：

```powershell
node --test server.test.cjs
node --test research/character-motion.test.mjs research/third-person-weapon.test.mjs research/weapon-model.test.mjs research/view-arms.test.mjs
node research/ascent-environment.test.mjs
node research/ascent-collision.test.mjs
node research/verify-assets.cjs
```

或使用前述 bundled Node 的绝对路径替代 `node`。启动脚本定位与基本依赖可单独检查：

```powershell
.\启动游戏.cmd --check
```

服务端自测会启动临时端口和真实双 WebSocket 客户端，验证移动限速、购买、挡墙射线、技能限制、上升气流、减速、冰墙阻挡与射击破坏、击杀、装拆包与回合胜负；另有恶意武器键、无效消息和有界突发输入检查。射击和炸弹场景使用明确的位置 fixture 加速布置。

新增模型自测读取实际 GLB/glTF：检验骨长、蒙皮有限值、持枪握点与朝向，逐三角检查地图材质重建、枪械颜色合批均未改变源形状。Phantom 的 72 个源网格保留全部 29,516 个三角面，合并为 9 个绘制批次。可用 `node research/public-smoke.cjs --base https://当前隧道地址 --map ascent-b` 对当前公网入口进行一次双 socket 检查。

`node research/ascent-path-probe.mjs` 可重现双方出生点到 B 点的原始胶囊步行路径。默认进攻路线需要沿 BMain 向北后往东侧通道绕行，再向西进入站点，直接沿西墙走会遇到源建筑阻挡。路线与逐帧地面结果见 `research/ascent-path-results.json`。

这些检查不代替两台设备实操、高并发、目标设备帧率或全量原作一致性验收。当前交付状态为**可运行、已自测的开发切片**。
