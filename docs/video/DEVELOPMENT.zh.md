# 视频引擎：开发规范

写给所有要改视频引擎的人和 Agent：引擎在 `skills/popost/src/video/`（下文写作 `src/`），测试在 `skills/popost/tests/video/`（下文写作 `tests/`）。英文版：`DEVELOPMENT.md`（内容相同）。
进度记录、评测工具和台账由维护者放在本仓库之外。

## 1. 这个包是什么

它是视频复刻和模板生成视频背后的引擎，分成两半，加一个把两半连起来的循环：

| 部分 | 做什么 | 目录 |
|---|---|---|
| 制作 | `video.json` -> 检查过的工程 -> 解析后的时间轴 -> 一个能显示任意一帧的 HTML 页面 -> MP4 | `src/project` `src/timeline` `src/presets` `src/page` `src/compile` `src/render` |
| 读取 | 任意视频文件 -> 一份测量结果（切点、转场、运镜、动效事件、颜色）-> 和另一份测量结果比出分数 | `src/media` `src/measure` `src/score` |
| 循环 | 带真值的随机工程、不用模型的草稿、评测运行及其台账 | `src/synth` `src/draft` `src/eval` `eval/` |

它需要 ffmpeg 和 Chromium（读 `video.json` 还用到 zod）。它属于 popost Skill：命令是 `popost video …`（`src/commands/`），Agent 按 `skills/popost/references/video.md` 使用它。它在 `feat/video` 分支上开发，还没有进入已发布的 `popost` 版本。

## 2. 约定

`src/types.ts` 是两半之间的约定：工程、解析后的时间轴、测量结果、分数。它的文件头规定了帧的约定。改任何东西之前先记住这五条：

1. 所有时间都是**整数帧**。只有比较两条帧率不同的视频时才出现秒。
2. 所有位置都是**画布的比例**（`[x, y, width, height]`，原点在左上角）。
3. 第 k 段从 S_k 开始，S_k 是它之前各段长度之和。**转场不改变视频的长度。** F 帧的转场在第 a 到 a+F-1 帧上混合两个画面，a = S_k - floor(F / 2)。
4. 测得的边界是 `{ start, end, frame }`：最后一个纯旧画面的帧、第一个纯新画面的帧、新镜头接管的位置。硬切是 `{ frame - 1, frame, frame }`。
5. 说出来的内容按**字词而不是帧**定位。字词文件给出一个音频素材的 token（与 `src/align` 写出的相同），帧数从文件开头算起；短语锚点把元素放在它那个短语的 token 上，所以措辞、配音或语言变了，它跟着字词一起移动。凡是属于所说内容的东西，都锚定到短语上。

改 `types.ts` 就是同时改两半。要在一次提交里连同两边的代码和测试一起改，并在提交说明里写明。

## 3. 代码规则

- **页面运行时是帧号的纯函数。** `applyFrame(n)` 只根据 `n` 设置所有样式：没有定时器，没有 `requestAnimationFrame`，没有 CSS transition 或 animation，不保留上一次调用的状态，没有不带种子的随机数。跳转到某一帧和播放到同一帧，结果必须逐字节相同。导出能并行、预览和导出能共用一个页面，靠的就是这一点。需要加载的图片（视频素材的帧）在 `applyFrame(n)` 之后、截取这一帧或报告它已显示之前，用 `settle()` 等待；`settle()` 只等待，从不改变显示的内容。
- **预设是数据加纯函数**，放在 `src/presets`。同一批函数既在 Node 里跑（测试、真值），也在页面里跑。预设从不碰 DOM。
- **测量是确定的。** 同一个文件得到同一份 `Measure`，序列化成 JSON 后逐字节相同。
- **没有"兜底类型"。** 没有任何转场模型拟合得上时，测量返回最可能的猜测并给低置信度，不默认成"叠化"。低置信度是信息，悄悄给一个默认值不是。
- **改编其他项目的代码**，只在许可证允许时进行，并在 `NOTICE` 和每个改编文件的开头写明项目、版权和许可证。
- **不加新依赖**，除非提交说明里写了理由；如果它会进入构建产物，还要在 `NOTICE` 里加一行。不允许：Remotion（许可证原因），以及在这个包里做任何模型推理。GSAP 只作为不打包的 npm 依赖使用：`popost video scene library` 把它未经修改的文件复制进工程，`NOTICE` 写明它的许可证。
- 代码、测试、样例和日志里**不出现密钥、供应商名字和私有地址**。外部服务通过接口访问，接口的实现放在服务端。
- **Runtime**：`src/` 下的代码不导入 `node:fs`、`node:child_process`、`node:http`、`node:net`、`node:os`，也不读 `process`；读写文件、运行程序、打开浏览器或读环境变量的函数，第一个参数是 `Runtime`（`skills/popost/src/runtime.ts`）。ESLint 会检查。命令只打印一份 JSON；可预期的失败是 `{ "ok": false, "error" }`，退出码 2。
- **Skill 的 TypeScript**：本地导入不写扩展名；不用 enum、namespace 和构造函数参数属性；只导入类型时用 `import type`。
- **风格**：严格类型，不用 `any`；用 `const` 箭头函数；文件最多约 400 行，函数约 50 行以内，嵌套最多 4 层。注释只写代码表达不了的东西：单位、约定、某个阈值为什么是这个值。
- **错误信息**要写明位置、允许的取值和一个修法（`Problem` 类型）。它们是写给弱模型看的，弱模型会读了再试。

### CPU 预算

引擎里没有任何地方去问机器有多少个处理器。在共享主机上，或在有 CPU 配额限制的容器里，这个数是宿主机的，按它决定的
工作量会超出进程真正能用的处理器（一个文字识别库就是这样定线程数，两次把机器卡死）。改为由一个数，预算，来决定：

- **从哪里来**：设了 `POPOST_CPUS` 且是不小于 1 的整数时用它；否则取进程的处理器亲和性和它所在控制组的 CPU 配额
  （cgroup v2 `cpu.max`，v1 `cpu.cfs_quota_us` / `cpu.cfs_period_us`，本组及其所有上级组）中较小的一个，向上取整，
  至少为 1。规则在 `src/cpu-budget.ts`；`src/node-runtime.ts` 读一次这些文件，把预算报告为
  `LocalPrograms.parallelism`；引擎代码通过 `cpuBudgetOf(rt)`（`src/video/host.ts`）取用。Node 的
  `availableParallelism()` 只算亲和性；Node 24（libuv 1.52）也会套用 cgroup v2 配额，但向下取整（1.5 个处理器得 1）；
  Node 20 和 22 这里没有验证。所以运行时自己读这两样。`popost video doctor` 输出 `cpus: { budget, from }`。
- **由它决定的**：每个 ffmpeg 的 `-threads`（每个输入和输出）和 `-filter_threads` / `-filter_complex_threads`，都由
  `media/ffmpeg.ts` 的 `withThreads` 给出，ffmpeg 只从这一处启动。渲染时每四个处理器开一个 Chrome 页面（八个以下
  只开一个），最多四个，每个页面的 `--num-raster-threads` 也取自预算（1 到 4，Chrome 的范围；`src/render/browser.ts` 的
  `chromiumArgs`）。工具拿到 `POPOST_TOOL_THREADS`，等于预算但最多为四，用户自己设了就用用户的；
  `POPOST_OCR_JOBS` 份数乘以线程数不超过预算。describe 的三个部分和 readback 的两个部分，预算有四个处理器起并行，
  不到四个就依次运行（两种方式结果逐字节相同）。成批的 ffmpeg（draft 的图片、synth 的图片、素材探测、测量的两次解码）
  每两个处理器跑一个（`heavyJobs`、`mapLimit`）。
- **优先级**：在 Linux 和 macOS 上，ffmpeg 和工具通过 `nice -n 10` 启动（在 Linux 上，事后降低一个正在运行的进程
  只影响它的第一个线程）；在 Windows 上降为 BELOW_NORMAL（`os.setPriority`）。Chrome 由 Playwright 以 CLI 的
  优先级启动，所以消费它画面的编码器（render、capture）保持同一优先级：把编码器降到 Chrome 之下时，单处理器渲染
  showcase 用了 218 秒，而不是 50 秒。
- **新增的重活**从 `cpuBudgetOf(rt)` 取线程数或并行数，并有一个测试在预算为 1 时跑它。

2026-11-21 在一台 16 处理器的 arm64 机器上测量，每次运行都绑定到与预算相同数量的处理器：对一段合成的 30 秒
960x720 视频（十行字幕和一个音调）做 describe，带 RapidOCR 文字识别和 faster-whisper 转写（`--language zh`）；
渲染 `references/video-examples/showcase`（1080x1920，330 帧）。内存：最大的单个进程，以及整个进程树含文件缓存的
峰值（cgroup `memory.peak`）。

| 预算 | describe | render |
|---|---|---|
| 1（`POPOST_CPUS=1`，1 个处理器） | 52.7 秒，96% CPU；656 MB，进程树 1.17 GB | 49.6 秒，每秒 6.7 帧，1 个页面；468 MB，进程树 875 MB |
| 2 | 37.1 秒，167%；654 MB，进程树 1.14 GB | 24.3 秒，每秒 13.8 帧，1 个页面；527 MB，进程树 885 MB |
| 4 | 27.1 秒，313%；651 MB，进程树 918 MB | 15.0 秒，每秒 22.4 帧，1 个页面；578 MB，进程树 941 MB |
| 配额给出的 1（`CPUQuota=100%`，8 个处理器） | 54.7 秒，96%；654 MB，进程树 1.17 GB | 74.7 秒，每秒 4.4 帧，1 个页面；484 MB，进程树 876 MB |

一个处理器时，describe 约是四个处理器时的两倍时间，渲染约是三倍；每种预算下 2 GB 内存都够。describe 的输出在每种
预算下逐字节相同，也和不设预算时相同。

在配额下，引擎自己只用一个处理器的量（doctor：`cgroup v2 cpu.max: 1 processor`），但有两样不按预算定：Chrome 自己的
线程池（它的一个进程里最多 29 个线程，按机器的处理器数定）和 ffmpeg 7 每个阶段的线程（一次运行约 10 个；`-threads`
只决定编解码器的线程）。它们分散在进程可用的 8 个处理器上，被配额节流：这次渲染 Chrome 用了 33 秒 CPU，绑定一个
处理器时是 22.5 秒。没有别的程序在跑时，配额下渲染用了 75 到 78 秒；旁边跑着一个小的采样循环时，四次都是 55 秒
（可能是空闲的虚拟处理器被唤醒得更快）。`--num-raster-threads` 取自预算（现在默认如此）后，Chrome 用 28.6 秒 CPU，渲染单独跑 61 秒，旁边有采样循环时
49.6 秒；绑定一个处理器时不变（51 秒）。

## 4. 测试

- 测试文件按部分命名：`tests/make-*.test.ts`、`tests/read-*.test.ts`、`tests/loop-*.test.ts`。
- 测试的 runtime 来自 `createDiskRuntime()`；需要 ffmpeg 或 Chrome 的测试，在缺少它们时自己跳过（`hasFfmpeg(rt)`；Chrome 通过 `POPOST_CHROME` / `PLAYWRIGHT_CHROMIUM` 或常见路径查找）。
- **git 里不放二进制文件。** 测试用的媒体在测试时生成（ffmpeg 的 lavfi 源、我们自己的渲染器），放在临时目录，用完删除。
- 又小又短：画布 180x320 左右，片段 1 到 4 秒。
- 准确率测试断言的是代码实际达到的阈值，并把表格打印出来，这样一次运行就能看到数字。
- 不为了通过而削弱失败的测试。要么改代码，要么把测试标成 `it.fails` / `it.skip` 并写明原因，同时在提交说明里写明。

命令，在仓库根目录执行：

```bash
npx tsc -p skills/popost/tsconfig.json                     # 整个 Skill 的类型检查
(cd skills/popost && npx vitest run --config vitest.config.ts tests/video --maxWorkers=2) # 视频部分的测试
(cd skills/popost && npx vitest run --config vitest.config.ts tests/video/loop-plan.test.ts) # 只跑一个文件
npx eslint skills/popost/src/video skills/popost/tests/video --max-warnings 0
npm run check:video -w popost                             # 页面包与源码一致（build:video 重新生成）
npx vite-node skills/popost/src/cli.ts video --help  # 从源码运行 popost video
```

- 在 `skills/popost` 里带上 `--config vitest.config.ts` 运行 vitest（`npm run test:skill` 跑 Skill 的全部测试）。不带配置时超时只有 5 秒，机器忙的时候所有要启动 Chrome 的测试都会失败。
- 能不能提交，看检查命令的**退出码**。不要在同一条会提交的命令里把检查接到 `tail` 或 `grep` 后面：管道会把失败盖住。（第一晚就有两次这样把失败的测试提交了上去。）
- 引擎、测试和本机读取器都把临时文件写在 `TMPDIR` 下。如果 `/tmp` 是很小的内存盘（有的机器上只有 2 GB），把它指到磁盘上的目录：`export TMPDIR=<仓库>/.video-work/tmp`。

机器和别的工作共用时，重任务一次只跑一个，并降低优先级，例如
`flock <锁文件> nice -n 10 npm run test:skill`。

连接 popost.ai 账户（`popost auth login`）后，配音和转写默认在平台上完成，也可以在平台上生成背景音乐（`popost video music`，`src/video/music/`），像图片一样按积分计费：付费命令先报价，没有 `--confirm --max-credits N`（这条视频唯一预算的剩余额度）就以退出码 3 停下、不扣费，完成后输出 `chargedCredits`；不在已同意清单里的生成视频片段要 `--approve-unplanned <key>`（`production/approved-clips.json`）。在工程里发出的每个 Open API 请求都带上工程的任务（`x-popost-task`、`x-popost-task-title`、`x-popost-agent-session`；`src/providers/task.ts`），`popost usage --dir P` 读出平台记在它名下的费用（`--title TEXT` 先给任务起名）。环境变量，全部可选：`POPOST_FFMPEG`、`POPOST_CHROME`；`POPOST_OCR_CMD`、`POPOST_ASR_CMD`、`POPOST_TTS_CMD`、`POPOST_TTS_MODEL`（本机读取器和自己的合成器，见 `tools/`；设置后，转写器和合成器优先于账户）；`POPOST_LLM_URL`、`POPOST_LLM_MODEL`、`POPOST_LLM_KEY`、`POPOST_LLM_JSON`（模型环节用的模型，见 `src/plan/model.ts`；密钥不写进任何文件、日志或测试）；`POPOST_RENDER_PAGES`；`POPOST_VIDEO_DATA`、`POPOST_VIDEO_WORK`。

## 5. 评测循环

有这个循环，是为了让一处改动因为数字变了才被留下，而不是因为看起来更好。

| 运行 | 命令 | 回答什么 |
|---|---|---|
| 往返测试 | `popost video eval roundtrip --seeds 1-20` | 测量能把渲染器画出来的东西读对多少？真值就是工程本身 |
| 下限 | `popost video eval floor <视频> …` | 在真实参考视频上，不用模型、只靠测量能走多远？ |
| 真实集上的下限 | `popost video eval floor --set dev` | 同上，跑 `POPOST_VIDEO_DATA` 所指数据集的开发部分；`--set heldout` 只打印平均值 |
| 预览 | `popost video preview <工程目录> --reference <视频>` | 工程在每一帧显示什么，和测量结果怎样对应？只读 |

规则（设计方案 13.6 节）：

1. 每轮一个假设、一处改动、一行台账。用 `--note "…"` 写明假设。失败的实验也要记录。
2. 先把基线跑三次，它的波动范围就是噪声带。改动只有超出噪声带才算数。
3. 接受条件：开发集的提升超出噪声，留出集不下降，耗时和成本不超限。
4. **受保护的路径**：`src/score/`、数据集和这些规则。对它们的改动不属于任何一轮迭代，要单独提交、由人来审，并且重置基线。
5. 每个失败案例都从固定清单里贴一个标签（读错、映射到错误的预设、版式、时间、素材、渲染），先处理最大的一类。
6. 循环里默认关闭付费生成，除非这次运行设了花费上限。

东西放在哪里：

- 台账是评测仓库的 `video/eval/ledger.jsonl`：每次运行一行，包含假设、提交号、数据、分数和决定。只追加，不修改。`popost video eval` 写入 `POPOST_VIDEO_LEDGER` 指定的文件；没有设置时写入检出目录里的 `docs/video/eval/ledger.jsonl`，git 会忽略它。
- 命令运行目录下的 `.popost/video/`（不在 git 里）：渲染结果、测量结果、每个案例的文件、测出的语速。可以用 `POPOST_VIDEO_WORK` 改位置。
- `popost video` 是 Skill 的命令行；在仓库里用 `npx vite-node skills/popost/src/cli.ts video …` 运行（或先 `npm run build:skill`，再 `node skills/popost/dist/cli.js video …`）。`eval` 只能在仓库的检出目录里运行。
- 真实集的参考视频从不提交，它们的文件名也不写进台账。数据集放在仓库之外，由 `POPOST_VIDEO_DATA` 指向（`cases.json`、`split.json`，见 `src/eval/dataset.ts`）。划分是固定的，谁也不在留出案例上调参。
- 工程旁边的测量文件用固定的名字，预览会按这些名字查找：渲染结果用 `measure.json` 或 `replica.measure.json`，参考视频用 `reference.measure.json` 或 `truth.json`。

## 6. 怎样添加东西

| 要加什么 | 改哪里 | 然后 |
|---|---|---|
| 一种转场 | `types.ts` 的 `TRANSITION_KINDS`；`src/presets/transition.ts` 及其默认值（如果它只改变一个画面并且有强度：`ONE_SIDED_TRANSITIONS` 和 `EFFECTS` 里它的单侧样子）；`src/measure` 里的一种拟合；`src/score` 里的混淆表；`src/synth/generate.ts` | 预设测试（`make-presets`，单侧的种类再加 `make-transition-sides`）、确定性测试、带新类型的往返测试；记录召回率和类型准确率 |
| 一个动效预设 | `MOTION_PRESETS`；`src/presets/motion.ts`；`src/synth/truth.ts` 和 `src/draft/build.ts` 里的 `how` 映射 | 同上 |
| 一个循环预设 | `types.ts` 的 `LOOP_PRESETS`；`src/presets/loop.ts` 里的 `loopState`、`LOOP_DEFAULTS` 和 `LOOP_AMOUNT_RANGE`（j = 0 时必须是恒等状态，这样开始时不跳） | 在 `tests/make-loop.test.ts` 里加一个状态测试和一个确定性帧 |
| 元素的一种外观（如旋转、描边框、阴影） | `types.ts` 的 `ItemLook` 和 `ResolvedItem` 上对应的字段；`src/project/schema.ts` 的 `itemCommon`（以及 `issues.ts` 的 `KeyTable`）；`src/timeline/items.ts` 的 `lookOf`；`src/page/dom.ts` 里的静态 CSS，或经由 `src/timeline/frame.ts` 的 `itemStateAt` 逐帧设置 | 一个解码画面、检查可见结果的渲染测试 |
| 一项测量 | `src/measure` 里一个作用于解码缩略图的纯函数；`Measure` 里的一个字段 | 带真值的合成测试；在 `src/measure/README.md` 里加一条并写明准确率 |
| 一个评分维度 | `DIMENSIONS`；`src/score`（受保护的路径） | 设计方案 13.2 节的验证测试：自比、重新编码、逐级损坏、无关视频 |
| 一种轨道类型 | `types.ts`；schema、它在 `KeyTable` 里的一项和一个 `src/project/check-*.ts`；`src/timeline/items.ts`（一条轨道可以展开成多个元素，字幕轨道就是这样）；运行时；如果能测量，还有草稿生成器 | schema、时间轴和渲染测试 |

## 7. Git

- 分支 `feat/video-skill`。小步提交，每步都要通过类型检查、eslint 和视频部分的测试；每到一个里程碑就推送，方便别人接着做。
- 提交说明沿用仓库的写法：`feat(video): …`、`fix(video): …`、`test(video): …`、`docs(video): …`，用英文，写明改了什么、为什么改。
- 到里程碑时，在提交说明里写明：哪些能用以及对应的数字、哪些不能用、下一步做什么。
- 提交前，`git diff --cached --numstat | awk '$1 == "-"'` 必须没有输出（没有二进制文件）。
- 改了 `skills/popost/` 下的文件，要重新生成 `skills/popost/SOURCE-MANIFEST.sha256`（见 `AGENTS.md`）。
