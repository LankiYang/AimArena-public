# 无畏契约网页研究项目 · 在线开发切片

这是一个可以用真实浏览器客户端加入房间的战术 FPS 开发版本。当前提供 CA-VAL-AIM 发布包中的 13 张《无畏契约》地图，支持大厅选图、真人联机，以及服务端裁定的移动、技能、购买、装拆包和回合胜负。

## 启动与进入

Windows 下双击 `启动游戏.cmd`。脚本优先寻找系统可用的 Node.js，其次尝试本机 Codex 的 bundled Node 路径：

```text
%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe
```

脚本会复用已启动的人机版服务。默认端口为 3000，若被旧服务占用则依次尝试 3001 至 3005。首次克隆后，在本目录使用 Node.js 22.12 或更新版本，运行 `pnpm install --frozen-lockfile`。

关闭浏览器不会停止服务器；关闭启动窗口或按 `Ctrl+C` 可停止由该窗口新启动的服务。

也可以在本目录手动运行：

```powershell
node server.cjs
```

如果 `node` 不在 PATH 中，本机可以直接使用：

```powershell
& "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" server.cjs
```

## 怎样测试真人联机

1. 输入昵称和房间码，选择角色与阵营，进入房间。真人对战下单人可以自由探索。人机训练下单人也能开局。
2. 同一台电脑可开两个浏览器窗口，使用同一地图、同一个房间码并选择不同阵营，验证连接与回合流程；实际操作两名玩家建议使用两台设备。
3. 局域网第二台设备使用主机的局域网 IP 和同一个服务端口（例如 3005）。房间由首位玩家选定地图与模式，双方应使用同一份房间链接。真人对战需要攻守双方各有一人才能开局。
4. `localhost` 只表示当前设备；第二台电脑访问自己的 `localhost` 不会连接到第一台电脑。

服务器监听 `0.0.0.0`，允许主机各网络接口接入。局域网是否可达仍取决于现有网络条件；本项目不自动更改网络权限。临时公网隧道依赖本机服务器和隧道进程持续运行。

## 人机训练

在对局模式中选简单、标准或困难。服务器补满 5 对 5，真人加入会替换本队人机。对局进行中加入的真人从下一回合开始行动。房间链接包含难度，记分板会标出人机。难度调节反应时间、瞄准误差、感知距离和射击间隔。

服务端使用 ngraph.path 的有向 A*，沿用游戏的碰撞盒、胶囊移动、射击和爆能器规则。导航由 `node research/bake-bot-nav.mjs` 烘焙。人机会推进、守点、回防和装拆包，目前的决策以站点和可见对手为主。[ngraph.path（MIT）](https://github.com/anvaka/ngraph.path)

## 操作

| 按键 | 操作 |
| --- | --- |
| WASD / 鼠标 | 移动 / 观察 |
| 鼠标左键 / 右键 | 射击 / 缩放瞄准 |
| Space / 左 Ctrl / 左 Shift | 跳跃 / 蹲下 / 慢走 |
| R / B | 换弹 / 购买界面 |
| Jett：C / Q / E | 烟雾 / 上升气流 / 冲刺 |
| Sage：C / Q / E | 可破坏冰墙 / 减速区域 / 自疗 |
| 按住 F | 进攻方携包在地图站点安装；防守方在爆能器旁拆除 |
| Enter / Tab / Esc | 准备 / 记分板 / 暂停与离开 |

进入房间后点击继续，允许浏览器锁定鼠标。购买阶段为 20 秒；点击准备或按 Enter 可缩短至约 3 秒。战斗阶段为 100 秒，回合结束停留 5 秒。初始 8000 资金是为了方便检查内容，经济和部分参数采用演示规则。

## 当前内容的实际状态

- **角色：** 第三人称 Jett、Sage 保留现有 GLB 模型、骨骼和持枪姿态，走跑、横移和后退使用 Godot 官方射击示例的动作重定向，并按游戏中的位移匹配脚步。蹲伏、跳落地、受击与施法使用项目内过渡。第一人称使用 Cransh 动作包原配的 AK-74M、特种兵双臂及动画。
- **武器：** 当前实际加载的是 gkari 的 **Radiant Entertainment System Phantom** 三维模型。当前只开放 Phantom 与护甲购买，默认持有 Phantom；Classic、Spectre、Vandal 等配置仅保留供后续开发，未开放为可用武器。
- **环境：** [CA-VAL-AIM 发布包](https://github.com/Pyromesis/CA-VAL-AIM/releases/tag/maps)的 13 张地图均可在大厅选用：Ascent、Abyss、Bind、Breeze、Corrode、Fracture、Haven、Icebox、Lotus、Pearl、Split、Summit、Sunset。默认亚海悬城。客户端和服务器共用碰撞数据。每张地图有独立封面、小地图与光照色调，高画质启用法线、粗糙度和更细的近景阴影。
- **地图限制：** 发布包未提供原版贴图，现用源颜色与重建材质。下包区依据报点和有效地面配置；传送门、滑索、活动门等地图机关暂未实现。天枢云阙（Summit）和深海明珠（Pearl）的进攻方使用碰撞可连通的临时出生区。
- **技能：** Jett 支持烟雾、上升气流、冲刺；Sage 支持四段各 400HP、持续 25 秒的可破坏冰墙，半径 4.5 米、持续 7 秒的减速区域及自疗。当前以冷却替代原作有限次数/购买，墙体采用分段包围盒，减速只作用于敌方，均为开发规则；终极技能未实现。
- **联网：** 服务端目标模拟 60Hz、快照 20Hz，验证速度、碰撞、弹药、射速和技能冷却，并裁定射线命中及回合结果。实际频率受负载影响。当前采用简化的延迟补偿。

素材作者、源链接与许可记录见 [ASSETS.md](ASSETS.md)。技术依据、协议与测试边界见 [docs/TECH-RESEARCH.md](docs/TECH-RESEARCH.md)。

第一人称目前共用 Cransh 的 AK-74M 动画模型，包含持枪待机、走、跑、射击与换弹。武器栏与服务器规则保留原配置，第三人称仍使用原先的角色和 Phantom 资源。旧第一人称 IK 已退出游戏渲染，其历史实验由 `npm run test:legacy-arms` 单独运行。

尚未实现：人机技能决策、原作全特工与全枪、所有终极技能、原作完整动画、完整反作弊、匹配、账户系统、128 tick、正式公网部署与长期运维。

## 自测

在本目录运行：

```powershell
pnpm test
pnpm verify-assets
```

或使用前述 bundled Node 的绝对路径替代 `node`。启动脚本定位与基本依赖可单独检查：

```powershell
.\启动游戏.cmd --check
```

服务端自测使用临时端口和真实双 WebSocket 客户端，核对 13 张地图的资源接口、房间地图锁、出生点稳定性、出生区可步行离开，以及各图 A/B/C 点的装包、拆包和回合结算。装拆包自测把玩家放到站点，验证通过不代表双方到所有站点的路线都已验完。浏览器检查使用 Edge 和 Playwright：`node research/map-browser-smoke.cjs`，默认测试 3003 端口；`VW_QA_URL` 可指定入口，`VW_QA_MODULES` 可指定 Playwright 和 sharp 所在的 node_modules 目录。

模型自测读取实际 GLB/glTF：检验骨长、蒙皮有限值、持枪握点与朝向，逐三角检查地图材质重建、枪械颜色合批均未改变源形状。Phantom 的 72 个源网格保留全部 29,516 个三角面，合并为 9 个绘制批次。

`node research/ascent-path-probe.mjs` 可重现双方出生点到 B 点的原始胶囊步行路径。默认进攻路线需要沿 BMain 向北后往东侧通道绕行，再向西进入站点，直接沿西墙走会遇到源建筑阻挡。路线与逐帧地面结果见 `research/ascent-path-results.json`。

`node --test research/ascent-full-path.test.mjs` 使用浏览器与服务端共用的移动控制器，步行验证全图双方出生区、A Main、B Main、中路、Market、A 高台和两个下包区之间的主要路线。

`node research/release-route-probe.mjs` 使用同一移动控制器检查各队首个出生点到各下包区的路线。探测允许跳跃和落差；距离为搜索找到的路线长度。

这些检查不代替两台设备实操、高并发、目标设备帧率或全量原作一致性验收。当前交付状态为**可运行、已自测的开发切片**。
