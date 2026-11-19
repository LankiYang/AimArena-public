# AimArena · 公开调试版

本分支的 **13 张地图与人机版**位于 [`valorant-web/`](./valorant-web/)。大厅支持选图、真人联机及 5 对 5 人机训练。第一人称沿用 Cransh 的 AK-74M、原配特种兵双臂和原始动作。

```bash
cd valorant-web
pnpm install --frozen-lockfile
pnpm start
```

启动后访问 <http://localhost:3000>。需要 Node.js 22.12 或更新版本。详见 [启动与自测](./valorant-web/README.md)、[素材来源](./valorant-web/ASSETS.md) 和 [枪械模型调研](./valorant-web/research/weapon-asset-shortlist.md)。下面是根目录中 AimArena 调试版的说明。

浏览器里的 5v5 射击原型（Node 权威服务器 + Three.js 客户端 + 确定性模拟）。

此公开版使用**自制方块盒模型与程序化竞技场**代替未授权资源，不依赖外部素材与私密配置，克隆后可直接在本地一键运行和调试完整对局逻辑。

## 运行与调试

环境要求：Node.js >= 22.18

```bash
# 1. 安装依赖
npm install

# 2. 启动服务（自动构建前端并监听）
npm start
```

启动后打开浏览器访问：<http://localhost:5173>

- **首页 / 大厅**：输入代号后可进入大厅，支持「快速开始」或「创建房间」。
- **支持模式**：
  - **团队对抗 (TDM)**：双方拼抢击杀，阵亡后 1.5 秒复活。
  - **攻防 (SND)**：爆破回合制，带开局买枪/换装。
  - **经典生化 (Infection)**：准备期后随机选出感染者母体，人类使用枪械求生，感染者近战抓人，全员感染或倒计时归零判定胜负。
- **操作方式**：
  - `W / A / S / D` 移动
  - `鼠标左键` 射击 / 挥爪，`右键` 开镜 / 重击
  - `R` 换弹
  - `1 / 2 / 3` 切枪（主武器 / 副武器 / 近战）
  - `B` 装备菜单，`Esc` 菜单与鼠标锁定切换

## 模型与资源说明

- 地图与场景：采用自制纯几何方块竞技场（`game/shared/public-map.ts`），自动生成碰撞 BVH 与导航网格。
- 武器与角色：客户端使用低多边形方块盒模型与骨架挂点。
- 生化模型：包含程序化生成的感染者第三人称模型（`game/data/infected_thirdperson.glb`）与第一人称双臂模型（`game/data/infected_firstperson_arms.glb`）。
- 第一人称步枪：使用 AK-74M 与原配特种兵双臂模型及待机、移动、射击、换弹动作。素材来源为 FPS AK-74m animations by Cransh，授权 CC-BY-4.0。
  This work is based on "FPS AK-74m animations" (https://sketchfab.com/3d-models/fps-ak-74m-animations-94be8385c402474cacd39bc096c6ca14) by Cransh (https://sketchfab.com/ccransh), licensed under CC-BY-4.0.
- 绝无私密信息、证书私钥、服务器远程 IP 或未授权镜像资源。

## 独立规则测试

```bash
npm run check:infection
```
