<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://static.popost.ai/readme/brand/logo-horizontal-dark-0f45507673d3.svg">
    <img src="https://static.popost.ai/readme/brand/logo-horizontal-light-1d5f84bd6682.svg" alt="Popost" width="400">
  </picture>
</p>

<h3 align="center">粘贴社媒链接，用 AI Agent 复刻任何爆款图文，生成后可以继续修改</h3>

<p align="center"><strong>把已经验证过的爆款，换成你的内容</strong></p>

<p align="center">支持 ins、TikTok、X、小红书、抖音等平台的爆款帖子链接复刻，一键做同款爆款。</p>

<p align="center">
  <a href="https://popost.ai"><strong>在线体验</strong></a>
  &nbsp;·&nbsp;
  <a href="#快速开始"><strong>快速开始</strong></a>
  &nbsp;·&nbsp;
  <a href="#四组真实案例"><strong>看作品</strong></a>
  &nbsp;·&nbsp;
  <a href="./README.md"><strong>English</strong></a>
</p>

<p align="center">
  <a href="https://github.com/PopostAI/popost/stargazers"><img alt="GitHub Stars" src="https://img.shields.io/github/stars/PopostAI/popost?style=flat-square&logo=github&label=Stars"></a>
  <a href="https://www.npmjs.com/package/popost"><img alt="npm 版本" src="https://img.shields.io/npm/v/popost?style=flat-square&logo=npm&label=npm"></a>
  <a href="./skills/popost/templates/community/"><img alt="200+ 爆款图文模板" src="https://img.shields.io/badge/爆款图文模板-200%2B-ef476f?style=flat-square"></a>
  <a href="./LICENSE"><img alt="含附加条件的许可证" src="https://img.shields.io/badge/许可-含附加条件-e3b341?style=flat-square"></a>
</p>

<p align="center"><code>TikTok</code> <code>Instagram</code> <code>X</code> <code>小红书</code> <code>抖音</code> <code>本地图片</code></p>

## Popost 是什么

Popost 是面向社媒爆款内容的创作 Skill，也是面向社媒图文的开源 Canva / 美图设计室替代方案。

- **链接复刻：** 支持 Instagram（ins）、TikTok、X、小红书、抖音等平台的图文帖子。
- **模板创作：** 选择 200+ 爆款模板 `SKILL.md`，换上你的主题、文案和素材。
- **Agent 创作：** 可在 Codex、Claude Code、WorkBuddy、DeepSeek、豆包工作等 10+ AI Agent 中使用。
- **画布修改：** Agent 制作初稿后，文字、图片、版式和图层都能在同一工程里继续修改。

**视频复刻正在路上。** 当前版本支持社媒图文的爆款复刻；视频能力正在开发，很快开源。[⭐ Star Popost](https://github.com/PopostAI/popost) 关注后续更新。

<p align="center"><img src="https://static.popost.ai/readme/four-cases-20261121/gift/edit-current-dec4e5928a5a.webp" width="680" alt="在 Popost 画布中对照参考图，继续编辑标题和版式"><br><sub>真实画布编辑录屏：参考与作品并排，标题可以继续修改。</sub></p>

### 三种起点，同一个可编辑画布

| 你提供 | Popost 帮你完成 |
| --- | --- |
| TikTok、Instagram、X、小红书或抖音的可访问帖子链接 | 提取可用的图文参考，借鉴结构与节奏，制作属于你的新内容 |
| 本地图片或截图 | 参考画面风格、版式和信息组织方式，制作新图或多页图文 |
| 一个创作需求，或一套 [图文模板](./skills/popost/templates/community/) | 从主题、产品和目标平台出发，生成完整图文 |

这三条路径都可以进入同一套画布：继续改字、换图、调整位置，保存可编辑工程，再按需导出成品。

## 快速开始

在 Codex 或 Claude Code 中安装 Popost Skill：

<!-- install:start -->
```bash
npm install -g popost
popost install
```
<!-- install:end -->

需要 Node.js `^20.19.0 || >=22.12.0`。其他支持 Skill 的 Agent 可以通过 <code>popost install --dir &lt;skills 目录&gt;</code> 指定安装位置。也可以直接使用 [popost.ai](https://popost.ai) 网页版。

安装后，把参考和要求一起告诉 Agent：

```text
/popost 参考这篇两页 TikTok 图文的“情绪钩子 → 商品揭晓”结构：
https://www.tiktok.com/@veyla_gift/photo/7699494320675507469
给我的手链写一篇新的送礼故事，只使用我上传的商品照片。
完成后打开画布，我还要修改标题和第二页的排版。
```

没有链接时，上传参考图片或直接描述要做的图文也可以。完整流程见 [Skill 说明](./skills/popost/SKILL.md)。

## 四组真实案例

**保留结构，重写内容。** 找出开场钩子、页序、版式和收尾，再换上自己的主题、文案与素材。把链接和改写要求交给 Popost，一条指令生成可编辑初稿，之后在画布继续改。

四组案例均展示 **原帖前两页 → Popost 新作前两页 → 画布编辑过程**，并附完整成品与可编辑工程。

### 01 / TikTok · 从情绪钩子到手链揭晓

**原帖：15,280 赞 · 1,929,266 播放。** 保留「情绪钩子 → 实物揭晓」的两页节奏，用 Popost 改写成手链故事；封面头像、标题和互动栏可继续调整。

<table width="100%">
  <tr>
    <th align="center" width="33%">参考原帖 · 前两页</th>
    <th align="center" width="33%">Popost 新作 · 前两页</th>
    <th align="center" width="34%">画布编辑·持续修改</th>
  </tr>
  <tr>
    <td align="center" width="33%"><img src="https://static.popost.ai/readme/four-cases-20261120/gift/source-01-b4cab31b3b21.webp" width="65%" alt="手链送礼故事 source-01"><br><img src="https://static.popost.ai/readme/four-cases-20261120/gift/source-02-983274cf66e4.webp" width="65%" alt="手链送礼故事 source-02"></td>
    <td align="center" width="33%"><img src="https://static.popost.ai/readme/four-cases-20261121/gift/remake-01-f6a5f09ca0b9.webp" width="65%" alt="手链送礼故事 remake-01"><br><img src="https://static.popost.ai/readme/four-cases-20261120/gift/remake-02-878f89f14e9e.webp" width="65%" alt="手链送礼故事 remake-02"></td>
    <td align="center" width="34%"><img src="https://static.popost.ai/readme/four-cases-20261121/gift/edit-current-dec4e5928a5a.webp" width="96%" alt="Popost 画布中编辑 手链送礼故事"></td>
  </tr>
</table>

[查看原帖](https://www.tiktok.com/@veyla_gift/photo/7699494320675507469) · [下载完整 2 页 PNG](https://static.popost.ai/readme/four-cases-20261121/gift/images-19aba70855f1.zip) · [下载可编辑工程](https://static.popost.ai/readme/four-cases-20261121/gift/project-7c4e3423a959.popost.zip) · [观看画布编辑 MP4](https://static.popost.ai/readme/four-cases-20261121/gift/edit-current-22a9b0a16abd.mp4)

### 02 / TikTok · 六页讲清滑板车卖点

**原帖：8 赞 · 519 播放。** 这是结构参考：保留「问题分屏 → 功能对照 → 产品收尾」的六页顺序，用 Popost 换成 Segway MAX G3 的新文案与插画。

<table width="100%">
  <tr>
    <th align="center" width="33%">参考原帖 · 前两页</th>
    <th align="center" width="33%">Popost 新作 · 前两页</th>
    <th align="center" width="34%">画布编辑·持续修改</th>
  </tr>
  <tr>
    <td align="center" width="33%"><img src="https://static.popost.ai/readme/four-cases-20261120/scooter/source-01-78898fd6acf8.webp" width="65%" alt="滑板车功能对比 source-01"><br><img src="https://static.popost.ai/readme/four-cases-20261120/scooter/source-02-5fed6c293b05.webp" width="65%" alt="滑板车功能对比 source-02"></td>
    <td align="center" width="33%"><img src="https://static.popost.ai/readme/four-cases-20261120/scooter/remake-01-eb1dfbda5aa5.webp" width="65%" alt="滑板车功能对比 remake-01"><br><img src="https://static.popost.ai/readme/four-cases-20261120/scooter/remake-02-5a44e434a7c5.webp" width="65%" alt="滑板车功能对比 remake-02"></td>
    <td align="center" width="34%"><img src="https://static.popost.ai/readme/four-cases-20261120/scooter/edit-10s-30c3fbd95890.webp" width="96%" alt="Popost 画布中编辑 滑板车功能对比"></td>
  </tr>
</table>

[查看原帖](https://www.tiktok.com/@gobuygobike/photo/7674850905254055182) · [下载完整 6 页 PNG](https://static.popost.ai/readme/four-cases-20261120/scooter/images-44d6fd335ca9.zip) · [下载可编辑工程](https://static.popost.ai/readme/four-cases-20261120/scooter/project-82bcf23f28ac.popost.zip) · [观看画布编辑 MP4](https://static.popost.ai/readme/four-cases-20261120/scooter/edit-10s-acc7cfd5fc6e.mp4)

### 03 / Instagram · 把目的地清单改成周末慢旅行

**原帖：159,796 赞。** 保留十一页照片叙事与固定信息栏，用 Popost 改写为九座城市的周末慢旅行。

<table width="100%">
  <tr>
    <th align="center" width="33%">参考原帖 · 前两页</th>
    <th align="center" width="33%">Popost 新作 · 前两页</th>
    <th align="center" width="34%">画布编辑·持续修改</th>
  </tr>
  <tr>
    <td align="center" width="33%"><img src="https://static.popost.ai/readme/four-cases-20261120/travel/source-01-823f07ab8719.webp" width="65%" alt="周末城市旅行清单 source-01"><br><img src="https://static.popost.ai/readme/four-cases-20261120/travel/source-02-a5b9a9cb6a2a.webp" width="65%" alt="周末城市旅行清单 source-02"></td>
    <td align="center" width="33%"><img src="https://static.popost.ai/readme/four-cases-20261120/travel/remake-01-18ea8965735e.webp" width="65%" alt="周末城市旅行清单 remake-01"><br><img src="https://static.popost.ai/readme/four-cases-20261120/travel/remake-02-919deac40551.webp" width="65%" alt="周末城市旅行清单 remake-02"></td>
    <td align="center" width="34%"><img src="https://static.popost.ai/readme/four-cases-20261120/travel/edit-10s-e5661ca8dd1e.webp" width="96%" alt="Popost 画布中编辑 周末城市旅行清单"></td>
  </tr>
</table>

[查看原帖](https://www.instagram.com/p/DcgaornE46r/) · [下载完整 11 页 WebP](https://static.popost.ai/readme/four-cases-20261120/travel/images-0a9c251267bc.webp.zip) · [下载可编辑工程](https://static.popost.ai/readme/four-cases-20261120/travel/project-4cbb25213817.popost.zip) · [观看画布编辑 MP4](https://static.popost.ai/readme/four-cases-20261120/travel/edit-10s-02e8a7400242.mp4)

### 04 / Instagram · 用分类清单组织创作流程

**原帖：1,920 赞。** 保留封面加分组表格的六页结构，用 Popost 改写为内容创作的十二个环节；分类、例子与行动建议均为新内容。

<table width="100%">
  <tr>
    <th align="center" width="33%">参考原帖 · 前两页</th>
    <th align="center" width="33%">Popost 新作 · 前两页</th>
    <th align="center" width="34%">画布编辑·持续修改</th>
  </tr>
  <tr>
    <td align="center" width="33%"><img src="https://static.popost.ai/readme/four-cases-20261120/creator/source-01-5695ce336177.webp" width="65%" alt="创作者内容系统清单 source-01"><br><img src="https://static.popost.ai/readme/four-cases-20261120/creator/source-02-84972ce394d6.webp" width="65%" alt="创作者内容系统清单 source-02"></td>
    <td align="center" width="33%"><img src="https://static.popost.ai/readme/four-cases-20261120/creator/remake-01-bb0293971928.webp" width="65%" alt="创作者内容系统清单 remake-01"><br><img src="https://static.popost.ai/readme/four-cases-20261120/creator/remake-02-4393db3128c1.webp" width="65%" alt="创作者内容系统清单 remake-02"></td>
    <td align="center" width="34%"><img src="https://static.popost.ai/readme/four-cases-20261120/creator/edit-10s-99de8f64105e.webp" width="96%" alt="Popost 画布中编辑 创作者内容系统清单"></td>
  </tr>
</table>

[查看原帖](https://www.instagram.com/p/DZiXsfvjP3Z/) · [下载完整 6 页 PNG](https://static.popost.ai/readme/four-cases-20261120/creator/images-f84c72887a12.zip) · [下载可编辑工程](https://static.popost.ai/readme/four-cases-20261120/creator/project-88da8553c33d.popost.zip) · [观看画布编辑 MP4](https://static.popost.ai/readme/four-cases-20261120/creator/edit-10s-e465af0adc27.mp4)

## 200+ 爆款图文模板，给创作一个具体起点

Popost 提供 **200+ 爆款图文模板 `SKILL.md`**，覆盖 TikTok 电商、Instagram 轮播、杂志与极简版式。每套模板说明适用场景、信息节奏和页面组织方式。你可以直接指定模板，也可以让 Agent 根据主题挑选。

[浏览全部模板](./skills/popost/templates/community/) · [查看模板目录](./skills/popost/templates/community/README.md)

## 画布编辑·持续修改

生成的图文会保留为可编辑工程。你可以在画布中：

- 改文字、字体、颜色、对齐、位置与图层；
- 替换、裁切、旋转图片，继续增删或调整页面；
- 保存工程，过几天再打开接着改；
- 从画布导出 **PNG、JPG、SVG、HTML、PDF**，也可以导出 PSD。

页面中的文字和独立图层可以继续编辑。照片里的脸、包装上的印字等属于图片像素，修改这些细节需要图片编辑或重新制作素材。

Agent 侧边栏与 [popost.ai](https://popost.ai) 使用同一套画布。连接账户后可以同步工程；不连接账户也能先在本地完成编辑与导出。

## 支持哪些平台与 Agent？

| 能力 | 当前公开版本 |
| --- | --- |
| 链接参考 | TikTok、Instagram、X、小红书、抖音的可访问图文帖子 |
| 无链接参考 | 本地图片与截图 |
| Agent 安装 | 可以在 Codex、Claude Code、WorkBuddy、DeepSeek、豆包工作等 10+ AI Agent 中使用。 |
| 导出 | 画布支持 PNG、JPG、SVG、HTML、PDF、PSD；命令行标准渲染导出 PNG |

链接解析取决于帖子是否公开、平台是否可访问。你也可以改用截图或本地图片继续创作。

## 费用如何计算？

| 操作 | Popost 算力 |
| --- | --- |
| 解析帖子链接，或将帖子保存到「我的灵感」 | 使用；运行前查看实时报价 |
| 使用 Popost 模型生成图片 | 使用；运行前查看报价 |
| 本地排版、渲染、画布编辑与基础导出 | 不使用 |

使用站内服务前可通过 `popost auth login` 连接账号。`popost link quote` 和 `popost inspiration quote` 会显示当前链接费用。本地 Agent 也可使用自己的图片模型或宿主提供的生图能力；Agent 和模型服务的费用另计。[查看模型接入说明](./skills/popost/references/providers.md)。

## 接下来：社媒视频复刻

我们本次上线的版本支持社媒图文的爆款复刻。我们正在支持社媒视频的爆款复刻，正在路上，很快开源。

## 源码与贡献

仓库包含 [Popost Skill 与命令行](./skills/popost/) 和 [画布编辑器源码](./packages/canvas-editor/)。网站、账号、算力与云端工程由 [popost.ai](https://popost.ai) 提供。源码采用[含附加条件的许可证](./LICENSE)，复用前请阅读条款。

欢迎提交问题、改进文档或贡献模板。开发与提交方式见 [CONTRIBUTING.md](./CONTRIBUTING.md)。[图片来源与署名](./docs/readme-showcase-credits.md)。

<details>
<summary>开发者：从源码构建</summary>

```bash
npm ci
npm run check
npm run build
npm run build:skill
```

`npm run check` 包含 Skill 与画布的类型检查、Lint 和测试。嵌入方式见[画布文档](./packages/canvas-editor/EMBEDDING.md)，第三方许可见 [NOTICE](./NOTICE)。

</details>

<p align="center"><strong>刷到想借鉴的图文？把链接交给 Popost。</strong><br><a href="https://popost.ai">在线体验</a> · <a href="https://github.com/PopostAI/popost">⭐ Star Popost</a></p>
