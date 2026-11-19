# 与 Popost 产品共用的本地画布

Skill 使用与 Popost 产品相同的自研画布编辑器（4.0.0）。源码权威位于仓库 `packages/canvas-editor/`；`npm run build` 把构建产物原子发布到 `skills/popost/assets/canvas/`（已提交）；popost.ai 网页版嵌入同一份产物（约定见 `packages/canvas-editor/EMBEDDING.md`）。`<skill>/assets/canvas/build-info.json` 记录文件指纹，`THIRD_PARTY_LICENSES.txt` 列出打包的第三方 npm 依赖（含 CodeMirror 5）的许可，不按作品另写界面。

通过 `present --dir P --host <当前宿主>` 启动或复用服务，再由宿主工具直接打开侧栏；手动前台服务仍可用 `serve --dir P`。只绑定 `127.0.0.1`，入口仍为 `/editor.html`。界面保留文本、区块、图层、代码四个面板、底部缩略图、图层移动与排序、图片替换与裁切、撤销/重做、页面复制/删除/重排、缩放和还原初始布局。它可独立运行，不要求网站登录或托管服务。宿主动作与能力检测见 [host-editor.md](host-editor.md)。

## 页面契约

每页独立 HTML、CSS 和本地资源。根 .post/.page 固定宽高；可移动语义单元唯一 data-layer-id，文字叶子用 data-slot；不要将可拖动图层彼此嵌套。使用 border-box。以 :root 声明颜色与字体角色。复杂位图可整层移动，图内像素不承诺逐对象编辑。

本地适配将独立页面装入同一画布，以 scoped CSS 隔离各页样式、变量和字体；保存按当前页序拆回独立 HTML，复制页分配新 id。字体注册放在作用域外，保存时去除重复注册，不反复嵌入整份字库 CSS。打开工程不会重写页面。编辑器使用同源 HTTP 预览，支持 Codex 内嵌浏览器与现代 Chrome/Chromium；PNG 导出需要本机 Chrome 或 Chromium。多窗口保存校验磁盘版本，冲突保留修改并显示处理界面。初始布局以首次在本地新版画布打开时的快照为准，不被后续保存覆盖，恢复操作可撤销。

优先直接写固定图层，避免编辑器接管时改变结构。确需固化时等待图片与字体，先测量全量再写；变换、上下文样式和层序不可丢失。编辑器缩放不改变画布真实尺寸，拖拽位移换算画布坐标。

## 保存与导出

PNG 和完整工程下载先等待保存；失败时保留修改并显示错误。服务器全量校验页面再写入，异常时恢复旧文件。磁盘 manifest 不含 html，页面文件是排版权威。修改后旧看图记录失效，不把用户修改自动写成 Agent 已审核。PNG 缓存校验当前 HTML、尺寸、本地依赖、图像字节和渲染版本；未变动的已审核图片直接导出，变化页批量共用浏览器渲染。

“下载全部”下载当前 PNG 图集 ZIP。顶部右侧的“导出”菜单提供单文件 HTML 导出（编辑器 4.0.0 起不再提供 PDF 导出），不显示工程 ZIP 操作。完整工程通过 `package` 命令交付。ZIP 里是 `social-studio-project.json`（只留可移植的元数据）、`pages/*.html`、页面引用到的图片/字体/CSS 及字体旁的原始许可、说明文件 `OPEN.txt`，以及 `runtime/assets/canvas/`（共同编辑器构建产物）；`runtime/assets/fonts/` 带 `palette.json`、NOTICE，以及本机已有 WOFF2 的系列的 CSS 和字体文件。ZIP 里没有可执行脚本，也没有 Python。重开：装好 popost CLI（Node 20.19 或更新），`popost unpack --file project.popost.zip --dir 新目录`，再 `popost present --dir 新目录`；PNG 导出需要本机 Chrome 或 Chromium（`popost doctor --dir 新目录` 检查）。

ZIP 不带密钥/账户配置、制作历史、原始提示和内部构图图像。测试恢复时移到新目录并让旧目录不可用，验证图片、字体和 CSS 不依赖绝对路径。导入后的当前工程成为该工程的初始布局。撤销/重做作用于共同画布的操作历史，重开依据已保存文件，未保存离开有提示。
