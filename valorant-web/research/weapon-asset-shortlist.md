# 《无畏契约》枪械 3D 素材候选

核实日期：2026-11-19。按 [Valorant-API 枪械清单](https://valorant-api.com/v1/weapons?language=zh-CN) 检索 20 种枪械，不含近战。该接口提供图标、皮肤和游戏内资产路径，没有可直接下载的 3D 模型。公开检索没有找到一套来源清楚、覆盖全部默认枪型、带贴图和第一人称动画的完整包。

| 优先验收的默认枪型 | 作者 | 平台面数 | 平台贴图数 | 页面许可 | 备注 |
| --- | --- | ---: | ---: | --- | --- |
| [狂徒 Vandal](https://sketchfab.com/3d-models/vandal-0dd5c4e5342a42d9b6969b7f4e6ac69e) | xxchelxx | 8,893 | 4 | CC BY | 作者标为默认狂徒，未注明网格来源。 |
| [冥驹 Operator](https://sketchfab.com/3d-models/operator-c9c8dc47bb094d9fa5870c50f7e34358) | TheWalkingMEss | 9,710 | 33 | CC BY | 作者明确说明模型和贴图由自己制作。 |
| [獠犬 Bulldog](https://sketchfab.com/3d-models/valorant-bulldog-f8cb49fd08f842cc9ee4ba13bc75871e) | Servaretur | 5,747 | 4 | CC BY | 作者称是简化复刻，需要对照原作检查细节。 |
| [幻影 Phantom](https://sketchfab.com/3d-models/standard-phantom-valorant-4c75d2afe8964b739434447801c9b4c2) | esmurz | 16,838 | 0 | CC BY | 默认外观草稿。另有 [woop5r 的带贴图版](https://sketchfab.com/3d-models/valorant-phantom-fan-art-7e25bc972db74cd1b95a90d01c794192)，平台显示 16,215 面、4 张贴图，许可为 CC BY-NC。 |
| [标配 Classic](https://sketchfab.com/3d-models/classic-valorant-461511e2161c4eeea44415a6724381e7) | pastordavidromerorepetto | 6,404 | 0 | CC BY-SA | 平台显示 9 个材质。 |

其他线索：

- [Recon 骇灵](https://sketchfab.com/3d-models/valorant-recon-specter-smg-6a7eaf4b58734ec0b247cb39537389ff) 和 [Recon 幻影](https://sketchfab.com/3d-models/valorant-recon-phantom-rifle-85af07c2d05c4298a3a497ed091805b0)：jordanstasak 的皮肤复刻，均为 CC BY，分别 14,339 / 19,437 面，各 4 张贴图。
- [默认正义](https://sketchfab.com/3d-models/valorant-sheriff-a9d26172689e407eb43726ab9a0e4d68) 有约 148 万面且无贴图，不适合直接导入。带贴图的版本是 [Wasteland 皮肤复刻](https://sketchfab.com/3d-models/valorant-wasteland-sheriff-6ed145441f0d45b2915b3be831b41dbc) 或 [Medusa 同人款](https://sketchfab.com/3d-models/revolver-sheriff-medusa-valorant-fanart-8554868c881b435cb592d163a9b316b0)，两者页面均标为 CC BY。
- 鬼魅、狂怒、雄鹿和飞将也有皮肤候选，分别为 [Hush Ghost](https://sketchfab.com/3d-models/hush-ghost-valorant-83057f92de2d4de4b5336cffa6e7b622)、[Glitch Pop Frenzy](https://sketchfab.com/3d-models/glitch-pop-frenzy-valorant-97ed3f185548407db5e4caf18084b2a4)、[Oni Bucky](https://sketchfab.com/3d-models/bucky-oni-valorant-07a2108e29534737a25f99c262db45db)、[Kuronami Marshal](https://sketchfab.com/3d-models/marshal-kuronami-valorant-df20cb436eb24f229e82aca15d731ba5)。Hush Ghost 标为 CC BY-NC；后两项由上传者注明是 Riot 资产的移植。
- 奥丁、战神、悍狼、判官、短炮、戍卫、莽侠、蜂刺，本轮没找到同时符合画质和下载要求的候选。追猎有一条皮肤线索，但页面标题和作者说明写的是两把不同的枪，未纳入候选。

表中数据来自 Sketchfab 公开模型详情，贴图数和面数是页面元数据。五个优先候选均标为可下载，且动画数为 0。对狂徒、冥驹、幻影、标配等模型请求下载端点时，未登录返回 HTTP 401；本次未取得网格压缩包，弹匣、枪机、坐标和贴图分辨率均待验。页面 CC 许可与 Riot 原作授权分别核对，CC BY-NC 仅限非商业使用，CC BY-SA 需注意改作的同许可分发条件。

下一步优先验收狂徒和冥驹：下载后核查 glTF 或 FBX、贴图和独立零件，再在现有特种兵双臂上验证握持、瞄准和换弹。若要统一还原全部默认枪械，优先通过已有授权渠道索取原始网格、贴图和第一人称动画。
