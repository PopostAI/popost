# 图像提示与结果检查

模型负责摄影、插画、材质和真实视觉关系；活字排版与精确结构由 HTML 负责。生成前确定素材角色和实际需要的能力。

描述图像区域本身：位置、明暗、材质、细节密度与物体关系。例如“上部是一片连续、低细节的深蓝天空”，比“给标题留空间”更明确。正式素材不要求模型画标题、价格或按钮。内部构图联系表是唯一可以带计划排字的生成阶段。

优先使用模型真实尺寸、比例、透明输出参数；提示词比例只是意图。返回后检查真实尺寸（`popost image info --file a.png …` 一次读出格式、像素尺寸和是否带透明通道）、空白区域、主体尺度、错误文字、裁切和语义；几张素材先用 `sheet --files a.png b.png … --out P/exports/assets.jpg` 拼成一张总览看，不逐张打开，有细节疑问再单开一张。保留比例，用 object-fit/object-position 做有意识裁切，不拉伸图片。CSS 背景图只用 `background-size: cover`、`contain` 或单值缩放（如 `250% auto`）配 `background-position`；写两个独立百分比（如 `300% 206%`）会按元素宽和高分别缩放，把图拉变形。同一张图的不同裁切不能冒充不同款式、颜色或商品。透明素材验证 alpha 与空白角像素，棋盘格不等于透明通道；`image info` 的 `hasAlpha` 只说明文件带透明通道，背景是否真的透明要看它放在页面上的渲染。

多素材共用摄影/插画方向、相机、视角、光线、色板、主体尺度及真实风格锚点，提示只改变对应内容。每个需要独立编辑的复杂主体单独出文件；不能把一张多物体图当成多个独立透明素材。独立任务全部 `image prepare` 后，用 `image quote --id a,b,c`（或 `--all`）一起报价，授权后 `image run --quote-id q1,q2,q3 --confirm`（或 `--all-quoted`）一起生成，并发不超过 Provider 限额（见 [providers.md](providers.md)）；依赖另一个任务返回像素的任务，等它完成后再做。

**用户的商品照带着不合设计的背景时**（深色或复杂场景上的白底/纯色棚拍背景，带文字和图标的电商列表图），不要原样摆进页面。这在定计划时就要判断：看过商品照和参考就决定抠图还是做成相框卡片；要抠图，就把抠图任务和其他素材一起写进 `setup` spec 的 `images`（如 `{"id": "bottle", "promptFile": "prompts/bottle-cutout.md", "aspect": "1:1", "ref": ["identity"]}`，商品照登记为 identity 参考），同一批生成，不要等页面写完再补一轮。抠图只用图像任务做：编辑请求，商品照作为参考，提示词要求原样保留商品、只改周围，并要求完全透明的背景。单独建任务时是 `image prepare --dir P --purpose material --id bottle --prompt-file F --aspect 1:1 --ref <商品照文件>`，再 quote、run、`image complete`；提示词写成："Edit this product photograph. Keep the product EXACTLY as it is — same shape, cap, label, printed text. Change only the surroundings: remove the background and the props. Put the product on a fully TRANSPARENT background, no shadow, no new props, no text. Clean alpha channel."（按商品改动“shape, cap, label”等词）。返回后用 `image info --file RESULT` 确认 `hasAlpha` 为 true，再和原图对照标签、印字、形状有没有被改，没问题才放进页面；有改动就重新做，不要硬用。也可以不抠图，把照片有意做成相框卡片或贴纸（白边、圆角、投影）摆放，背景成为设计的一部分。不要用 CSS 混合模式（`mix-blend-mode`）、filter、mask 或 clip-path 去藏起、裁掉或融掉照片背景，也不要另建临时页面、渲染导出来做素材（抠图、拼背景板都不行；工程页只放作品页，没有删页命令）：效果不可控，只会多耗轮次。

## 处理已有图片：取一块、放大看、改尺寸、转格式

手里的图（用户给的、网页或仓库取来的、生成回来的）只需要其中一部分或换个尺寸时，不重新生成，也不搭临时页面、不找 ImageMagick / Pillow / sharp。两条路，按结果是否要成为独立文件来选：

**只是在页面里露出图的一部分：在页面 HTML 里用视窗裁切**，不产生新文件，图层保持可替换、可再调：

```html
<div data-layer-id="logo" style="position:absolute;left:340px;top:32px;width:57px;height:57px;overflow:hidden;border-radius:50%">
  <img src="../assets/screenshot.webp" style="position:absolute;width:2240px;max-width:none;left:-42px;top:-31px">
</div>
```

`width` 是整张图放大后的宽（原宽 × 倍数），`left`/`top` 是负的偏移（区域在原图的坐标 × 倍数）。普通照片的取景用 `object-fit: cover` + `object-position` 即可。

**要一张新文件，或要放大看清细节：`popost image edit`**（不需要工程，原图不会被改）：

```text
popost image edit --file F --out G [--crop x,y,w,h] [--rotate 90|180|270] [--flip h|v] [--width N] [--height N] [--fit cover|contain] [--scale F] [--background '#fff'] [--quality 90] [--grid]
```

步骤固定按 裁切 → 旋转 → 翻转 → 缩放 执行。`--crop` 用原图像素（`image info` 读尺寸），或用百分比（`60%,10%,30%,40%`）：看图工具把图缩小显示过时，像素坐标对不上，用百分比。输出格式由 `--out` 的扩展名决定（`.png` `.jpg` `.webp`），PNG / WebP 保留透明，JPEG 垫白底或 `--background`。输出里的 `source` 是原图实际尺寸，`steps` 是实际执行的步骤。

**定裁切框不靠目测。** 先带 `--grid` 看一眼：`--crop 大致区域 --scale 3 --grid --out /tmp/grid.jpg`，输出图上画着坐标线，数字是**原图像素**；照着线读出主体的左、上、右、下，四周各留一点边（主体尺寸的 5–10%），再对**原图**裁一次（不带 `--grid`）。不要在放大过的图上再裁：坐标对不上，画质也掉。裁完看一眼结果：主体完整、四边没被切、没有带进旁边的文字或多余白边；圆形 Logo 要是完整的圆。带 `--grid` 的图只用来看，不放进工程。

常见用途：

- **从截图或海报里取出一块当素材**：产品界面截图左上角的品牌 Logo、海报里的一张商品图、长图里的一屏。先看过原图、确认那块内容确实在那里，再裁；不要从没有该内容的图里“裁”出 Logo 或商品。
- **放大核对细节**：`--crop 区域 --scale 3 --out /tmp/zoom.jpg`，只看小字、Logo、商品细节那一块，比打开整张大图省，也看得清。放大不增加细节，只为看清；正式素材不靠放大凑尺寸。
- **裁成版位的比例**：`--width 1080 --height 1440`（默认 `--fit cover`，居中裁掉多余部分）；主体不在中间时先 `--crop` 框住主体再定尺寸；要完整保留画面用 `--fit contain`（PNG/WebP 四周透明，或 `--background` 垫色）。
- **纠正方向**：手机拍的横倒照片 `--rotate 90`；需要镜像构图 `--flip h`（带文字、Logo 的图不要镜像）。
- **缩小过大的图**：几千像素宽的截图、照片按版位实际尺寸的 1–2 倍缩小（`--width 1600`），工程更小、渲染更快。
- **转格式**：SVG 图标转 PNG（`--file icon.svg --width 512 --out icon.png`，按目标尺寸矢量渲染）；GIF 取第一帧；要透明就出 PNG / WebP。

裁出来的图是什么就标什么：界面截图不标成“实拍”“原视频”。找不到版式需要的素材（Logo、对比图）时告诉用户缺什么，或改用文字处理，不拿别的图冒充。

不要把某个模型的提示语言、负向词或少量测试观察当成所有模型的定律。按照所选能力调整，真实结果才是判断依据。失败先定位是素材拆分、提示含义、能力还是返回结果问题；保留成功素材。提交状态不确定时不能自动重复付费。
