# AGENTS.md — 给接手本仓库的人和 Agent

这是 Popost 的**开源仓库**：Popost Skill（`skills/popost`，复刻 / 生成图文）和自研画布编辑器（`packages/canvas-editor`）。
你的任务是读懂、复跑、按需开发；不要重造架构、不要把 Mock 当真实服务。

## 范围（2026-11-01 起）

- 开源版只提供**复刻 / 生成 Skill 和可编辑画布**。账号、算力、订单、云端项目、Skill 社区、角色、灵感库等都属于 popost.ai 网页版（私有仓库 `popost-server`）。
- 网页版是开源版的**超集**：开源版有的能力，网页版必须对齐。因此本仓库是画布编辑器和 Skill 方法论的唯一源头，`popost-server` 同步本仓库的编辑器构建产物、字库和 Skill 文档，不在私有仓库里分叉修改。
- 不要在本仓库新增网页应用或网页版才有的功能（社区、账户、支付等）。

## 仓库结构

| 路径 | 内容 |
|---|---|
| `packages/canvas-editor/` | 画布编辑器源码、测试、`dev/` 调试页；`EMBEDDING.md` 是网页宿主嵌入编辑器的约定（参数、postMessage 消息、`store=host` 存储） |
| `skills/popost/` | Skill 与 `popost` 命令行（TypeScript，npm 包 `popost`）：`SKILL.md` 入口、`src/`（CLI 源码，构建到不提交的 `dist/`）、`references/`、`templates/`、`assets/`（字库清单、编辑器构建产物）、`tests/`（vitest）、`tools/`（仅维护者用的 Python 字库脚本，不属于 CLI） |
| `skills/popost/src/video/` | 视频引擎（开发中，分支 `feat/video-skill`，还没有进入已发布的版本），命令是 `popost video …`：工程文件 → 可显示任意帧的页面 → MP4，以及视频文件 → 测量结果 → 分数。Agent 的做法见 `skills/popost/references/video.md`；测试在 `skills/popost/tests/video/`，本机读取器和配音工具的示例在 `skills/popost/tools/video/`（不随 npm 包发布）；开发规范见 `docs/video/DEVELOPMENT.zh.md` |
| `scripts/` | 仓库级构建胶水：`publish-editor.mjs`；`scripts/release/`：Skill 发布检查（`npm run release:check`、`npm run release:smoke`），手册 `docs/release-skill.md` |
| `docs/editor-rewrite/` | 编辑器规格、契约、功能清单、对齐结果（历史记录，路径是重组前的旧路径） |

依赖统一在根目录 `package.json` / `package-lock.json`（单一 npm 包，所有 npm 脚本在仓库根目录执行）。

## 和 popost-server 的边界

- `popost-server` 是**私有**仓库，是网页版和付费能力的后端。本仓库只能通过公开的 HTTP 接口（`https://popost.ai/api/open/v1`，用户自己的 API Key）和它交互：Skill 的生图 provider（`skills/popost/src/providers/popost.ts`）、`inspiration import` 和 `link parse` 就是这样接的。密钥先读环境变量 `POPOST_API_KEY`，没有再读 `popost auth set` 写入的用户级文件 `~/.popost/credentials.json`（目录可用 `POPOST_HOME` 改；只有桌面运行时有这个文件，网页沙箱只用宿主传入的环境），地址同样先读 `POPOST_BASE_URL`；请求带 `x-popost-client: skill` 和 `x-popost-client-version`（`SKILL.md` 的版本），服务端据此拦截过旧的 Skill。接口行为（幂等、`maxCredits`、错误码）以 server 的 OpenAPI 为准，改动要两边同步。
- **云端保存**（2026-11-14 起）：Skill 可以把工程同步到用户的 popost.ai 账号，仍然只走公开 HTTP 接口（`POST /projects/sync`、`POST /uploads`，`skills/popost/src/cloud/`）。有 Key 时用 Key；没有 Key 时，编辑器的“保存到云端”按钮带用户到 popost.ai 登录，网站把一次性上传凭证（`pat_push_<code>.<verifier>`，只对这一个工程、15 分钟、成功即作废）通过 `http://127.0.0.1:<端口>/api/cloud/callback` 交回本机编辑器服务，凭证只留在服务内存里，不写盘、不打印。`--cloud off` 关闭整套功能；`serve` 的“不读密钥、不联网”仅指编辑器自己的路由，云端保存是唯一例外。改这部分行为要和 server 侧同步（协议见两边的 OpenAPI）。
- 编辑器嵌入约定（`packages/canvas-editor/EMBEDDING.md`）和 Skill 文档改动会被 server 同步过去；改了这两处的对外行为，要在提交说明里写清楚，并通知 server 侧。
- **禁止**在本仓库写入：任何密钥或 token、私有渠道/中转站/上游模型名、内部定价规则、私有服务地址、内部工具路径、真实用户数据。

## 硬性前提
- 运行需要本机 **Node `^20.19.0 || >=22.12.0`**（Vite 8.2.2 engines）与可联网的 npm。无任何内部登录态要求。
- 不要从别处复制 `node_modules`；在一个**干净目录**里 `npm ci` 重建。
- 依赖只从官方 npm 源（registry.npmjs.org）安装：仓库**不提交** `.npmrc` 的 registry 配置，`package-lock.json` 的 `resolved` 必须是官方地址。需要镜像加速的人在个人 `~/.npmrc` 里配置即可（npm 会把 lockfile 里的官方地址换成你配置的源），不要写进仓库。

## 标准复跑（每次改动后都应跑通）
```bash
npm ci                 # 严格按 lockfile
npm run check          # = 编辑器与 Skill 的 typecheck + eslint + 测试，期望退出 0
npm run build          # 构建编辑器并发布到 skills/popost/assets/canvas/（已提交）
npm run build:skill    # 构建 skills/popost/dist/（CLI，不提交）；npm run pack:skill 再打成 tgz
npm run test:skill     # 改了 skills/ 时跑（vitest；已包含在 npm run check 里）
```
- `npm run lint` 允许既有的 5 个 `react-hooks/exhaustive-deps` warning，不要为清 warning 改编辑器逻辑。
- Skill 的 PNG 渲染测试需要本机 Chrome / Chromium（自动探测，也可用 `POPOST_CHROME=<路径>` 或 `PLAYWRIGHT_CHROMIUM=<路径>` 指定），找不到时这些用例跳过。
- Skill 测试里的平台调用都打到内存里的 popost.ai 接口模拟（`skills/popost/tests/image-helpers.ts` 等夹具），不联网、不需要 `POPOST_API_KEY`。

## 不要做
- 不要把本地 Mock 说成真 AI / 真支付 / 真平台解析。
- 不要为消除 lint warning 去改业务逻辑；不要关掉 eslint 规则或掩盖 typecheck 失败。
- 画布编辑器源码只在 `packages/canvas-editor/`（TypeScript，自研）；`skills/popost/assets/canvas/`（已提交）是它的构建产物，只通过 `npm run build` 生成，不要手改产物。改编辑器后跑 `npm run check`，并更新 `skills/popost/SOURCE-MANIFEST.sha256`。
- 改了 `skills/popost/` 下的文件（README 除外）要同步更新 `SOURCE-MANIFEST.sha256`（格式 `<sha256>  <相对路径>`，按路径字节序排序，范围是 `skills/popost/` 下 git 已跟踪的全部文件，不含 `README.md` 和清单自身；`cd skills/popost && sha256sum -c --quiet SOURCE-MANIFEST.sha256` 校验；增删文件后先 `git add -A .`，再在 `skills/popost/` 下用 `git ls-files -z | grep -zvE '^(README\.md|SOURCE-MANIFEST\.sha256)$' | LC_ALL=C sort -z | xargs -0 sha256sum > SOURCE-MANIFEST.sha256` 重新生成）。
- 不要删除 `THIRD_PARTY_LICENSES.txt`（`publish:editor` 生成，列出编辑器打包的 npm 依赖——React、parse5、CodeMirror 5 等——的许可）和 `skills/popost/THIRD_PARTY_NOTICES`；不要重新引入已移除的第三方编辑器代码。
- 不要在仓库/文档里写入任何内部工具路径、私有配置或真实密钥。
- 版权方是 CLIPCAT AI LTD（Popost / popost.ai 是产品和品牌名，不是法律主体）。新增会进入构建产物的第三方依赖、字体、图片或改编代码时，同步更新根目录 `NOTICE`；贡献者条款见 `CONTRIBUTING.md`。
- 不要提交图片、动图、视频等二进制素材，见下一节。

## 图片与媒体不进 git（2026-11-10 起）

模板预览图、示例图、GIF / 视频、截图等二进制素材**一律不提交**，放公共桶，仓库里只写完整的 HTTPS 地址。
git 历史会永久保留每个版本，克隆、npm 包和网页版 Agent 的沙箱都会被撑大：2026-11-06 为此重写过一次历史清掉字库，
2026-11-10 又把一个分支上 330 MB 的模板预览图移出了 git。

- **地址**：`https://static.popost.ai/<前缀>/…`（公共桶 + CDN，所有环境共用这一份）。模板预览图在 `templates/<模板 ID>/`，
  文件名带内容哈希（`page-01-<sha256 前 12 位>.webp`），内容变了就是新地址，已发布的地址不覆盖、不删除。
- **格式**：静图用 WebP，宽度不超过 1080；动图用动图 WebP，不用 GIF；不提交原图。
- **新增模板预览图**：图片放在 `skills/popost/templates/community/<模板>/previews/`（已被 `.gitignore` 忽略，只当输入），
  由有上传权限的维护者在 popost-server 运行 `pnpm templates:previews --src <community 目录> --base https://static.popost.ai --upload`：
  转码、上传、逐个校验公共地址，并把 `template.json`、`SKILL.md`、`README.md` 里的本地路径换成公共地址。
  没有权限就把图片交给维护者，不要提交图片。
- **展示**：README 和文档里用公共地址的 `<img>` 或 `![]()`，GitHub 能直接显示。
- **例外**：只有构建、测试或 Mock 必须读取的小文件，目前是 `skills/popost/` 下的 4 个（共 0.17 MB）：
  `assets/fonts/editorial-serif/` 的测试字体、`assets/fonts/screenshots/sample.png`、`assets/mock/mock_result.png`、
  `tests/fixtures/sample-asset.png`。新增例外要在提交说明里写明原因。
- **提交前自查**：`git diff --cached --numstat | awk '$1 == "-"'` 应该没有输出（有输出就是二进制文件）。
