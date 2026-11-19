# 公共字体库与画布字体菜单

`<skill>/assets/fonts/palette.json` 是唯一字库清单。Skill 本地画布、前端项目画布和导出的完整工程，都从这份清单生成字体菜单；禁止另维护固定菜单或请求 Google Fonts。当前 41 个系列：12 个中文、29 个英文，全部自托管。既有十个角色 ID 保持兼容。

## 覆盖与选用

- 中文：Noto Sans/Serif SC、TC（简繁黑体与宋体）、霞鹜文楷及 TC、马善政、站酷小薇、快乐、庆科黄油、刘建毛草、志莽行书。正文优先黑体、宋体、文楷；展示和手写字体适合短标题。
- 英文：Inter、Inter Tight、Roboto、Open Sans、Montserrat、Poppins、Lexend、Manrope、DM Sans、Be Vietnam Pro、Instrument Sans、Space Grotesk；衬线含 Fraunces、Bodoni Moda、Playfair Display、Lora、Libre Baskerville、Cormorant Garamond、Source Serif 4；窄体/展示含 Roboto Condensed、Unbounded、Oswald、Anton、Bebas Neue；等宽含 JetBrains Mono、IBM Plex Mono；手写含 Caveat、Pacifico、Dancing Script。
- 这是常见排版风格覆盖，不等于收录市售全部字体。每个系列的 `coverage` 来自实际 WOFF2 cmap：全部包含 95 个基本拉丁字符；当前 Noto SC 的网页子集覆盖 GB2312 汉字 6730/6763，文楷覆盖 6763/6763。繁体字体按其真实字形使用，不把繁体库当作完整简体库。生僻字、人名、符号、拼音、其他语言需检查实际字形。
- 只安装文案实际用到的字体：纯英文文案不要装 `cjk-*` 角色，导出会把每页链接的字体 CSS 带进每一页，而中文 CSS 很大。
- 按内容、语言和参考选择字体，不每篇用满。中英混排选择英文字体时，编辑器自动安装中文 Noto 后备。修改后等待 `document.fonts.ready`，核查真实加载、换行和布局；缺字时选覆盖更广的字体并重看渲染。

## 加载、保存与离线编辑

`font install --roles ...` 将所选 WOFF2、CSS 和完整原始许可复制到项目 `fonts/`、`css/`，合并 `fonts-manifest.json`，并在每页 `<head>` 里加上每个角色的 `<link rel="stylesheet" href="../css/<角色>.css">`（`font install` 输出的 `links` 给出原文，`fontLinks.linked` 列出改动的页；`setup` 的 fonts / pages 步骤同样带 `fontLinks`）。这些 link 由 CLI 维护，不要自己写、改或删，更不要自造 `css/fonts.css` 之类的路径，也不要用 `sed` 去补：`setup`、`font install`、`render` 都会补齐。整页重写后没有 `<head>` 或漏了 link 的页面，下一次 `render`（输出 `fontLinksRestored`）或 `font install` 会把它们加回（没有 `</head>` 的片段页，link 加在文档最前面，浏览器会放进 head）；已经把同名字体 `@font-face` 内嵌进页面的，不再加 link。`--dir` 必须是 `setup` / `init` 建的工程目录，空目录会报“不是 v2 工程”。WOFF2 本体不随 npm 包分发：`<skill>/assets/fonts/` 里没有该文件时，按 `palette.json` 里的哈希从公共字库下载（默认 `https://popost.ai/fonts/popost`，可用 `POPOST_FONT_BASE_URL` 改，缓存在 `POPOST_CACHE_DIR` 或 `~/.cache/popost`），哈希不符即报错。编辑器选择新字体时自动安装，保留已有字体和未保存文字；版本冲突时保留本地编辑并提示重载。

产品画布只从本站公共字库按需读取所选系列，保存时内嵌所选字体字节和原始许可，重开旧作品不依赖外部字体服务。本地画布使用工程内字体文件。已导入作品的库外字体会显示“文档现用，未在公共库”，不冒充可分发的公共字体。

本机 `<skill>/assets/fonts/` 里有字库文件时，完整工程 ZIP 携带这些系列的字库和许可（41 个系列齐全时约 69.4 MiB），解压后可离线继续选择同一菜单；没有时 ZIP 只带页面用到的字体，其余系列要用时再 `font install`。WOFF2 原本已压缩，ZIP 对其直接存储以减少打包耗时。作品 HTML/PNG 只使用所选字体，不为显示菜单预载全部字库。字体从 skill 自身定位，工程字体从清单定位，不依赖旧开发目录。

## 授权规则

这 41 个系列随包附有原始 **SIL Open Font License 1.1**、版权信息、固定 Fontsource 包版本及字体/许可 SHA-256。保留原始字体二进制，不擅自改名或修改字体。OFL 允许商业作品、嵌入与随软件分发；分发字体文件必须保留版权和许可，字体不能单独售卖，修改字体需遵守 Reserved Font Name 等条件。图文作品本身不因此受 OFL 约束。依据：[OFL 1.1 原文](https://openfontlicense.org/open-font-license-official-text/)、[官方 FAQ](https://openfontlicense.org/ofl-faq/)。其他来源字体必须另行核查授权，不沿用公共字库结论。

## 维护

网页版嵌入编辑器时从此字库拷贝 `fonts/popost/`（见 `packages/canvas-editor/EMBEDDING.md`），构建不联网；修改共享编辑器后运行 `npm run build`。不要只修改生成副本。新增字体必须有明确可分发授权、原始许可及来源版本，更新清单后核对字体菜单、字形、保存重开、PNG 和 ZIP。

仅维护者使用：仓库里的 `skills/popost/tools/update_font_library.py` 是一个独立的 Python 3 脚本（需要 `fonttools[woff]`），不属于 `popost` CLI，也不随 npm 包分发；Skill 的运行不需要 Python。它按清单中的固定包版本获取原始 WOFF2 并重算授权哈希、实际字形覆盖和 NOTICE。日常创作与构建无需此步骤。
