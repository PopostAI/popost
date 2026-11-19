# 在当前 Agent 的侧栏交付画布

`present --dir P --host codex|claude-code|workbuddy|doubao|generic` 输出 `popost-editor-handoff.v1` 并保存 `editor-handoff.json`。同步成功时地址指向 Popost 网页工作台（`transport: web-http`）。使用本地画布时，命令启动或复用本机服务并返回回环地址（`transport: loopback-http`）。宿主拿到 `open.url` 后打开侧栏。宿主运行在远端时，访问回环地址需要使用该宿主的端口转发能力。

## Codex

读取 `hostAction`，调用实际可用的 `mcp__codex_app__open_in_codex`：

```json
{"target":{"type":"browser","url":"<返回的 url>"},"placement":"right"}
```

工具名若在宿主中带不同命名空间，按描述发现对应工具。随后用内嵌浏览器读取当前页，确认六类证据中适用者：当前作品文字/图片、画布、图层或文本入口、保存入口、页序、无持续加载遮罩。工具返回成功仅证明侧栏打开，不能替代画布已加载的核实。

## Claude Code、WorkBuddy、豆包工作及其他宿主

交付前必须先搜索当前宿主的可用工具（按 browser、preview、panel、artifact、open URL 等能力描述发现），不能因工具名字与 Codex 不同就直接交付浏览器链接。发现工具后实际调用并读取页面确认加载；若工具是延迟加载的，先完成工具发现。它们共用同一套交付协议；不为每家复制编辑器，也不猜测不存在的私有 API。查找当前环境提供的“打开 URL 到预览/侧栏/内嵌浏览器”工具并传 `open.url`，优先 `open.preferredPlacement`。接入方可以只读取以下字段：

```json
{
  "schema":"popost-editor-handoff.v1",
  "url":"http://127.0.0.1:<实际端口>/editor.html",
  "transport":"loopback-http",
  "projectId":"<作品标识>",
  "open":{"kind":"web-url","url":"<同一地址>","preferredPlacement":"side-panel"},
  "requiresHostAction":true,
  "opened":false
}
```

`host` 是路由提示，不代表已检测到该产品的工具。纯 CLI 或不提供侧栏能力的宿主无法由 skill 强行增加侧栏；说明这一具体限制并给可点击链接与工程。不要把外部浏览器启动冒充内嵌，也不要为了嵌入而公开托管作品、放宽网络绑定或修改宿主安全设置。

## 云端保存（保存到 popost.ai 账号）

`present --cloud auto|off`（默认 `auto`）控制交付和云端保存。`present` 返回的 `transport` 表示打开哪种画布，`cloud` 描述云端结果。

- 配置了 Popost API Key 的用户会在「我的资产 → 我的项目」看到同步后的作品。复刻作品带有本地排版参考时，`open.url` 保留本地画布以展示复刻对比，`cloud.webUrl` 仍可查看已同步资产；其他作品直接打开 `open.url`。如果侧栏出现登录页，用户用 Key 所属的账号登录后会回到这个作品。网页编辑保存在该账号的项目中。
- 没有 Key 时，打开本地画布。`cloud.mode` 是 `anonymous`。右上角「保存到云端」的悬停提示为「在popost网页端管理你的所有资产」。点击后先保存当前编辑，再打开 popost.ai。用户登录并确认后，网站将一次性上传凭证通过回调交给本地服务，上传完成后可打开云端项目。弹窗被拦截时，按钮旁会提供可复制的登录链接。
- Key 校验或同步失败时，打开本地画布。`cloud.error` 提供失败原因。默认通过本地画布的「保存到云端」重新登录并上传。网页上有更新且本地也有新改动时，先确认要保留哪一版。只有用户明确选择覆盖网页修改时，才运行 `popost cloud push --dir P --force`。
- `--cloud off` 只打开本地画布。`serve` 是显式启动本地服务的命令，默认按原有 Key 或登录方式保存到云端，也可用 `--cloud login` 只启用浏览器登录。

同一个 `projectId` 在同一个账号下复用云端项目。网页修改后再次打开时，已在同一账号同步过、且本地导出内容未变的作品会直接打开网页版本。网页保存会更新云端项目；本地工程和离线导出仍基于本地文件。不要在聊天里向用户索要 Key、拼接登录地址或转发上传凭证。`.popost-editor/cloud.json` 仅记录同步结果、账号标识的哈希、内容指纹及上传索引，不进入工程 ZIP。网页版 Agent 沙箱使用宿主自带的画布。本机浏览器才能接收本地授权回调。远程宿主可用配置 Key 的方式打开和同步项目。

## 编辑器兼容与恢复

本地画布通过同源 HTTP `/_preview/<临时标识>.html` 加载，不依赖 Blob iframe 导航。临时预览只保存在服务内存中，限制数量和有效期；保留 CSP、来源校验和原始文稿脚本隔离。窄侧栏默认收起图层面板，工具按需覆盖展开，作品尺寸不变。

`GET /api/editor-info` 用于验证作品身份、版本和编辑能力；其中 `version` 是画布编辑器版本（当前 4.1.2，与 `packages/canvas-editor/src/version.ts` 同步，不是 Skill 版本），版本不一致的旧服务视为失效。`/_editor/` 提供的静态文件来自 `<skill>/assets/canvas/`。服务状态位于 `.popost-editor/`，ZIP 不携带进程信息或本机地址。恢复 ZIP 用 `popost unpack --file project.popost.zip --dir 新目录`，再 `popost present --dir 新目录 --host <宿主>` 获得同一交付协议。同一工程的失效旧服务不会被当成另一个作品复用。

### Local canvas tools

The installed Skill uses the same editing canvas and export panel as the web workbench. Export selected pages as PNG, JPG, SVG, PSD, HTML, or PDF, with a file name and resolution of your choice. Standard PNG, JPG and HTML export runs locally. Premium formats and higher resolutions show the same entitlement icon and upgrade prompt as the web workbench; signed-in paid accounts are checked through the public account endpoint. The CLI `export --final` still uses the reviewed PNGs.

For side-by-side comparison, register the original post images as layout references in page order (`reference --role layout` or `setup.references`). If you assign a reference to a page ID, it follows that page when reordered. Images that are only product, style or concept inputs are not used as comparison pages. The local asset tab reads images from the current project.
