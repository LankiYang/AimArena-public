# 素材来源与署名

核实日期：2026-11-19。文件以 UTF-8 记录。用户声明拥有本项目所需授权；Riot 原作权利与下列作者的具体素材许可分别保留。`valorant-api.com` 是社区接口，不能视为 Riot 官方授权或官方 3D 资源库。

| 本地文件 | 作品 / 作者 | 原始来源 | 许可及实际状态 |
| --- | --- | --- | --- |
| `assets/agents/jett.glb` | Jett (Fighting Stance) / BojanV06 | https://sketchfab.com/3d-models/jett-fighting-stance-69f7b293673a4e418d22133fd50a0857 | 文件元数据 CC-BY-4.0；保留作者与源链接。191 关节，1 个持枪待机动画 `wsh_kamae`，7 张内嵌纹理。 |
| `assets/agents/sage.glb` | Sage (Fighting Stance) / BojanV06 | https://sketchfab.com/3d-models/sage-fighting-stance-bd892217cebc457ba79b95d301704a43 | 文件元数据 CC-BY-4.0；204 关节，1 个持枪待机动画 `trn_kamae`，7 张内嵌纹理。 |
| `assets/agents/phoenix.glb` | Phoenix (Fighting Stance) / BojanV06 | https://sketchfab.com/3d-models/phoenix-fighting-stance-bcc9e29d2a044802bf0bcc8e9d68880d | 文件元数据 CC-BY-4.0；186 关节，1 个待机动画 `phx_kamae`，7 张内嵌纹理。 |
| `assets/weapons/res-phantom/scene.gltf` + `scene.bin` | Radiant Entertainment System Valorant Phantom / gkari | https://sketchfab.com/3d-models/radiant-entertainment-system-valorant-phantom-bb334fb114fa4db084c6666e2e09d071 | 文件元数据 CC-BY-4.0；72 个网格，无动画、无外部纹理，保留原材质和几何。此款是电玩皮肤，并非默认黑枪。 |
| `assets/animations/fps-ak74m/` | FPS AK-74m animations / Cransh | https://sketchfab.com/3d-models/fps-ak-74m-animations-94be8385c402474cacd39bc096c6ca14 | 文件元数据 CC-BY-4.0。提供第一人称双臂、AK-74M 与弹匣骨架，含待机、拔枪、走路、跑步、射击及三种换弹动画。保留原始许可文件和七张纹理；在游戏中调整了相机挂点、动作过渡和换弹播放时长。 |
| `assets/animations/bot-locomotion.json` | Third Person Shooter Demo / Juan Linietsky、Fernando Miguel Calabró | [官方示例（固定提交）](https://github.com/godotengine/tps-demo/tree/a82f15448e9b015440d3bbdf5e10801b260c4e9f)，`player/model/player.glb` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)。从持枪走、跑、后退、左右横移五条剪辑采样；去掉根位移，调整步幅、抬脚和相位，再重定向到现有角色。只分发动作数据，附 `bot-locomotion-LICENSE.md`。 |
| `assets/ui/jett-portrait.png`、`jett-icon.png` | Jett 原作图像 / Riot Games | https://media.valorant-api.com/agents/add6443a-41bd-e414-f6ad-e58d267f4e95/fullportrait.png 与同目录 `displayicon.png` | Riot 视觉素材，经社区 CDN 获取，用于用户声明授权的项目；不是 CC0。 |
| `assets/ui/sage-portrait.png`、`sage-icon.png` | Sage 原作图像 / Riot Games | https://media.valorant-api.com/agents/569fdd95-4d10-43ab-ca70-79becc718b46/fullportrait.png 与同目录 `displayicon.png` | 同上。 |
| `assets/ui/ascent-splash.png`、`ascent-minimap.png` | Ascent 场景图 / Riot Games | https://media.valorant-api.com/maps/7eaecc1b-4337-bbf6-6ab9-04b8f06b3319/splash.png 与同目录 `displayicon.png` | 同上。2D 图像不能代替完整地图模型。 |
| `assets/textures/plaster-{color,normal,roughness}.jpg` | Plaster001 / ambientCG | https://ambientcg.com/a/Plaster001 | CC0；使用官方表面贴图预览文件，原始 2048²，缩至 1024²，JPEG 90。 |
| `assets/textures/bricks-{color,normal,roughness}.jpg` | Bricks097 / ambientCG | https://ambientcg.com/a/Bricks097 | CC0；原始 2048×1024，缩至 1024×512，JPEG 90。 |
| `assets/maps/ascent-b.glb` | Ascent B 部分几何 / Riot Games；公开二进制转换项目 Vansh Negi | https://github.com/vanshnegi4444-sys/aimlab/tree/961d8cb363155f1fa704256bc90c15bce471d5ce/assets/maps | 原作地图权利归 Riot。上游程序代码 MIT；本项目从公开 VMAP 文件转换，未提取本机游戏客户端。仅 B 区节选，无原作纹理；上游说明存在楼板缺口及未导出的 Market 走廊，不能声称完整 Ascent。 |
| `assets/maps/ascent-full/` | Ascent 全图几何、材质色和游戏碰撞 / Riot Games；公开发布包 Pyromesis | https://github.com/Pyromesis/CA-VAL-AIM/releases/tag/maps | 来自 `maps.zip` 的 `maps/ascent/`，核对 ZIP 条目 CRC；原作地图权利归 Riot。公开下载不等于资产采用代码许可。原贴图并未随包提供。 |
| `assets/maps/<地图 ID>/` | Abyss、Bind、Breeze、Corrode、Fracture、Haven、Icebox、Lotus、Pearl、Split、Summit、Sunset / Riot Games；公开发布包 Pyromesis | https://github.com/Pyromesis/CA-VAL-AIM/releases/tag/maps | 与 Ascent 同一地图包。原始纹理未随包提供；各图使用保留的材质色、重建纹理、独立碰撞。逐图记录导出及输入 GLB 的 SHA-256。 |
| `assets/maps/<地图 ID>/{splash,minimap}.png` | 各地图封面、小地图与报点 / Riot Games，经社区接口获取 | https://valorant-api.com/v1/maps | 各图的 `map.json` 记录对应的接口条目和本地路径。 |

角色的下载镜像为 https://github.com/abdullah-nadeem-lodhi/Valorant-3D-Immersive-Guide ，固定提交 `0813765657a56d5722760dd0db3a47ac22dc6876` 的 `public/{jett,sage,phoenix}/*_animated.glb`。武器下载镜像为 https://github.com/AvikshitChanda/Valorant-ThreeJs ，固定提交 `1c6381698b47a1e605d6b9d60c9642807567187f` 的 `public/scene.gltf` 与 `public/scene.bin`。只下载素材文件，未复制这些站点的业务代码。

CC-BY-4.0： https://creativecommons.org/licenses/by/4.0/ 。CC0： https://creativecommons.org/publicdomain/zero/1.0/ 。ambientCG 许可核实页：https://docs.ambientcg.com/license/ 。第三方 CC 标签与 Riot 的原作授权是不同层级的许可。

第一人称模型下载镜像： https://github.com/Ayush-Mohanty/FPS-Arms-3D/tree/c80a452e680c5a27c9e936176eb17e446869529a/Models/fps_ak-74m_animations 。

当前第一人称使用 Cransh 动作包内的原始黑色 AK-74M、特种兵手臂和手套，并沿用同一套待机、行走、跑步、射击和换弹动作。备用弹匣仅在换弹时显示。捷风和贤者的手臂不进入第一人称；项目 Phantom 仍用于第三人称武器。

## 导入要点

- 角色 GLB 坐标并非米制；用加载后包围盒归一到约 1.8 m，再将脚底置于地面。保留骨骼及材质，克隆角色须使用 `SkeletonUtils.clone`。
- 捷风和贤者从角色 GLB 自带动画取首帧双手持枪姿势。走跑和横移采用 Godot 示例的腿部动作，跳跃、施法和受击仍使用本项目的过渡，均非 Riot 原作动作剪辑。
- ambientCG 法线为 DirectX 方向；Three.js 使用时将 `normalScale.y` 设为负值。只有颜色纹理设为 sRGB，法线与粗糙度使用线性空间。
- `assets/maps/ascent-b.metadata.json` 记录 B 区模型完整坐标、面数、颜色范围及转换条件。
- 全图的 10 块模型用 `node research/import-ascent-full.cjs <解压后的 maps/ascent 目录>` 转为站点服务器直接提供的 gzip GLB。导入按上游 manifest 旋转和平移模型，保留可见几何位置和源材质色，滤掉无法还原的贴花及部分非渲染面。输出含 2,335,335 个三角面，`levels.json` 记录源和导入结果的 SHA-256。上游坐标定义见 [RealMap.cs](https://github.com/Pyromesis/CA-VAL-AIM/blob/58223735ab0dd9fda3d43d38dce53777a94fc6ca/CaValAim/src/World/RealMap.cs)。
- 发布包 `maps.zip` 的 SHA-256 为 `87e4432174ec8ee997172c102ab9418cc06395358ee1f6779146045d6361ea7e`。`research/setup-release-maps.mjs` 依据社区地图报点和发布包碰撞地面配置双方出生点及 A/B/C 下包区。Fracture 排除两个上游废弃分区 `Canyon_APathNoMid` 和 `Canyon_ASidePath`。静态地图未复刻传送门、滑索与活动门。
- `research/verify-assets.cjs` 检查 GLB 头、块长、缓冲区范围、PNG/JPEG 文件格式、13 张图的封面与小地图，以及 165 个地图分区与各图清单的 SHA-256、文件大小和对应关系。
- `src/ascent-environment.js` 在完整原几何上重建灰泥、石砖与陶瓦材质；环境及路标不是原版贴图。沿用已署名 ambientCG PBR，并添加项目自制平铺纹理。精确三角区域与上游 flag 证据见 `research/ascent-surface-evidence.md`；几何保真自测见 `research/ascent-environment.test.mjs`。
