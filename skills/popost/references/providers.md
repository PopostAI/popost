# 图像通道与真实执行

项目 settings 保存 channel=official|host|custom 和可选 model，不保存密钥。`image` 命令统一管理任务；每个正式素材有自己的 id，唯一整组构图任务 id 固定 composition、count=1。

## 官方（popost.ai）

official 通道由 popost CLI 自身直接调用 popost.ai 平台 OpenAPI（HTTPS，不依赖外部 CLI）。

- **Credentials:** use browser sign-in with `popost auth login` for the selected Agent. Keep the process running and show its device code. Developer environments may use a private `POPOST_API_KEY` or `auth set --prompt`. Never request a raw key in chat.
- **地址**：默认 `https://popost.ai/api/open/v1`；私有配置 `popost.baseUrl`、环境变量 `POPOST_BASE_URL` 或 `popost auth set --base-url` 保存的值覆盖（优先级依次从高到低为配置、环境变量、已保存的值），只接受 https。
- **模型**：不写死。私有配置 `popost.defaultModel` 优先；否则用平台 `GET /models` 标记的默认模型；都没有时不传 model，由平台选择并绑定进报价。默认已知时，换成其他模型须在 `providerOverrides` 显式加入 `{"provider": "popost", "model": "…"}`，报价与提交同一规则。模型声明的画幅（aspectRatios）、参考图上限（maxReferenceImages）与单次张数（maxImagesPerRequest）在发请求前校验；平台单次 1–8 张、参考图 ≤10 张。
- **报价**：`POST /images/quote` 免费，返回单价、合计与余额；余额不足在报价阶段即停止。单请求默认最高 200 积分，`maxCreditsPerRequest` 只能调小。
- **提交**：确认后先用实时报价复核（模型、单价、合计任一变化即停止），再 `POST /images/generations`，携带由 quote 派生的幂等键 `idempotencyKey` 和已确认总价 `maxCredits`；平台计价超过 maxCredits 返回 CREDIT_LIMIT_EXCEEDED，不多扣。接口同步返回图片（base64 或 https 地址），结果与元数据写入本地任务记录：报价目录同级的 `tasks/`（image job 为 `production/tasks/`），可用 `--task-dir` 或 `POPOST_TASK_DIR` 指定；`status`/`download` 只读该记录，不重新生成。
- **参考图**：本地文件以 base64 内联发送（仅 PNG/JPEG/WebP/GIF，单张 ≤10 MiB、合计 ≤30 MiB；更大的先压缩），`--ref-url` 只接受 https 并按 URL 发送。本地路径不会发给平台。
- **等待**：生成请求同步等结果，默认最长等 660 秒（`generationTimeoutSec`）。平台一次生图可能先排队再出图，最坏约 10 分钟，所以不要在几分钟时就放弃；放弃得太早，平台仍会出图并扣费，用户却没拿到图。
- **结果不确定**：超时、连接中断、响应无法解析、网关 5xx、平台 TIMEOUT/INTERNAL_ERROR 都记 ambiguous，错误信息附幂等键，绝不自动重试：先在 popost.ai 核对生成记录（可能已出图、已扣费，只是没等到）。确需重试时重新 quote，再用**原来的幂等键**提交，平台对同一幂等键不重复扣费、只重放或补做一次：`image run --quote-id 新Q --confirm`（image 任务自动沿用 ambiguous 那次的键；也可加 `--idempotency-key 原键`，换成别的键会被拒绝，从不为同一任务换新键），或低层 `generate --quote-id 新Q --confirm --idempotency-key 原键`。被明确拒绝（内容审核、价格变动、参数错误）的提交不是 ambiguous，不走这条路。它们和提交前就被拒的运行（报价过期、价格变动、积分不足）都没扣费，不会关闭任务：重新 `image quote`，再 `image run` 新 quote（用新键）；只有已扣费或结果不确定的任务不再重新提交。
- **dry-run**：quote 与 generate 的 `--dry-run` 不联网、不需要密钥、不预占账本，只展示将发送的请求（Authorization 仅显示变量名）。

平台错误以信封 `error.code` 为准：

| error.code | 处理 |
|---|---|
| UNAUTHORIZED / FORBIDDEN | Resolve the invalid Key or missing permission privately; do not treat it as insufficient credits. Use the key page for the current origin; never request a Key in chat. |
| INVALID_REQUEST | 参数不合法，逐条列出 issues；修正后重新报价 |
| INSUFFICIENT_CREDITS | Show required/balance when known and the purchase options returned by `account`. A quote the balance does not cover still exits 1 with its price in `billing` (`creditsPerImage`, `totalCredits`, `balance`); a batch quote lists each job's `credits` and the sum as `requiredCredits`. No quote id is recorded, so quote again after a top-up; retain local references and user-selected custom / host generation. No automatic billing fallback. |
| CREDIT_LIMIT_EXCEEDED | 实际计价超过已确认上限，平台拒绝且未扣费：重新报价并确认 |
| RATE_LIMITED | 限流：按 retryAfterSeconds 等待后再操作 |
| CLI_VERSION_TOO_OLD | Skill 版本低于平台要求：请用户更新 popost Skill |
| CONTENT_REJECTED | 内容审核未通过：调整提示词或参考图 |
| UPSTREAM_ERROR / SERVICE_UNAVAILABLE / NOT_IMPLEMENTED | 平台明确失败，按未扣费处理，稍后重新报价 |
| TIMEOUT / INTERNAL_ERROR | 生图请求按 ambiguous 处理（见上） |

私有配置示例见 `<skill>/assets/provider-profiles.example.json`；`popost` 分节可写 `baseUrl`、`defaultModel`、`providerOverrides`、`auth.envVar`、`timeoutSec`（默认 60）、`generationTimeoutSec`（默认 660，须大于平台单次生图的最长耗时）。顶层扁平写法只合并 defaultModel/providerOverrides，自带 Key 的 baseUrl/auth 不会套用到官方通道。

`image quote` 调用真实报价，未获费用授权不提交。展示阶段合计与每项用途；多个素材是多个不同任务，不把不同提示合成 count。获得明确确认或已生效授权后 `image run --quote-id Q --confirm`，复用绑定参数、校验本地参考哈希、重查价格与账本。状态不确定（ambiguous）不自动重提，先核查任务状态与账户记录，确需重试只用原幂等键（见上）；成功结果复用。CLI 不会自动选择或扩大预算。

整个项目的 prepare 与 quote 可以交给 `popost setup`（一份 spec 一次完成，见 SKILL.md“工程命令”）；它只报价，用户确认后仍是 `image run --all-quoted --confirm`。

图片任务可通过 `image prepare --purpose material --id hero ... --aspect 9:16` 创建。所选模型必须确实支持该比例；最终画幅由 HTML 裁切排版，不伪报支持。

**多个任务一起走。** 互不依赖的素材先全部 `image prepare`，再一起报价、一起生成，不要逐个来：`image quote --dir P --id a,b,c`（或 `--all`：所有尚无结果、未提交的任务）列出每个 quote id 和总积分，总价超过余额会直接说明；用户授权后 `image run --dir P --quote-id q1,q2,q3 --confirm`（或 `--all-quoted`：所有尚未运行的 quote）同时提交，最多并发 4 个（`--concurrency N`，与平台每用户同时生图数一致），等全部结束后逐任务返回 `ok` / `failed` / `ambiguous`（字段同单个 run，另有 `charged`），任一任务没成功则退出码非 0。每个任务仍有自己的幂等键、账本和 ambiguous 规则，一个失败不取消、不重试其他任务；ambiguous 的任务按上面的办法单独重新 quote 再 run。依赖另一张图返回像素的任务等它完成后再做。quote 10 分钟有效，过期的 quote 无论单个还是批量 run 都报失败而不占用任务，重新 quote 即可。`image run` 提交后马上去写页面 HTML：图在生成，页面同时在写；等任务结果只在第一次 `render` 之前，不要在 run 上干等。

**构图参考的默认值。** `image prepare --purpose composition` 不必手写画幅和参考图：画幅按页面尺寸、`series prompt` 写进提示词的栅格（三页 9:16 排一行三格，整张约 16:9）和模型支持的比例自动定，模型不支持就取最接近的，并写进输出的 `notes`（要换栅格：`series prompt --aspect W:H` 重写提示词再 prepare）；不写 `--ref` 时带上工程登记的 layout 与 identity 参考（不超过模型的参考图上限）。`--ref` 也可写 `layout`、`identity`、`style`、`content`、`all` 代替带哈希的文件名；路径不存在时错误会列出已登记的参考。从未 quote、未运行的任务可直接重新 `prepare` 覆盖（输出 `replaced`），不要为此删 job 文件；已 quote 或已运行的不会被覆盖，报错里写明下一步。

## 宿主

settings 选择 host，prepare 输出 executor=agent-host-tool 与完整 job。Agent 发现并读取当前宿主真实工具的规则，实际调用工具，将 job.prompt 原文用于生成；composition 恰好一张输出，正式素材按其任务分别制作。返回后检查图，再 `image complete --file REAL_RESULT --tool ACTUAL_TOOL --note 观察`。该步骤验证本地文件并记来源，不冒称已检验宿主账户或远程服务。

## 自带 Key

选择 custom，用 --config 指向用户私有 JSON；模板见 `<skill>/assets/provider-profiles.example.json`。支持当前 JSON 图像生成适配与显式 HTTP 模板。不同供应商的参考图协议不同：配置 capabilities.referenceImages 与 referenceTransport=data-uri 才向支持该协议的接口发送图片内容；本地路径不会直接发送给远程。需要其他上传/多段表单协议的服务须新增对应适配，当前不能声称通用兼容。

文生图可用性与单价已知是两回事。无模型列表的服务可显式配置 model + skipModelDiscovery。BYOK 价格单位由 billing.unit 指定；未知价格不伪装免费。用户明确接受供应商未知费用时，quote 和 run 均加 --accept-unknown-cost，报价标 unknown；此时不能承诺绝对总价。可配置 maxAmountPerRequest，仅限制该供应商单位，不沿用平台积分上限。

凭据只用环境变量、`popost auth set` 保存的用户级文件与私有配置里的变量名；配置路径不进入公开作品，密钥不进入生成提示、日志或工程 ZIP。执行前确认实际能力：文生图、参考图/编辑、尺寸、透明输出和引用上限。CLI 不会因为一个图像接口能返回图片就声明支持所有这些功能。

`popost provider quote --prompt ... [--provider popost|custom] [--model M] [--config FILE]` 是保留的低层入口；低层两段式 CLI 是 `popost provider cli [--provider popost|custom] [--config FILE] quote|generate|status|download|models|check|inventory`（`--provider`、`--config` 写在 `cli` 与子命令之间，其余选项写在子命令之后），其中 `models|check|status|download` 可查看实时模型、连通性与已有任务。正常制作优先 image job，保持一次构图参考和逐素材记录。未实际生成的 mock/测试素材不能交付成品。
