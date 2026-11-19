# First use, service choice and fees

## Start from useful work

After installation, introduce the three core actions and offer concrete first messages in the user's language. For Chinese users:

“怎么用，例如：
- 复刻图文：用 popost 复刻这个图文链接 XX，我的内容是 XX。
- 创作图文：用 popost 给我创作一个 TikTok 带货图文，我的产品图是 XX。

复刻图文如果没有社媒链接，可以上传参考图做参考。创作图文可以说出创作要求和风格，也可以让 Popost 自动检索模板库，或指定模板风格去生成。”

Use equivalent concise examples in the user's language. If the user already supplied a brief, begin it immediately instead of repeating the welcome or asking for a first query. Explain the editable canvas, image ZIP and editable project ZIP delivered locally; the web host supplies its canvas only.

 Explain once that local layout, editing and export use no Popost parsing/image credits; the Agent itself may have separate charges. Do not make registration, a purchase, a full environment wizard or a model interview a prerequisite for local work.

Locate the executable and inspect its version before installing. Preserve a supplied archive/test build and its companion CLI; do not substitute the global command or the latest registry release. Only prepare tools required by the next step. A new Agent conversation reloads the Skill but does not isolate machine-wide keys/configuration.

## Reference and generation are separate choices

- Local pictures/screenshots and supplied text are immediately usable. They do not pay for parsing and do not reveal text or pages that were not supplied.
- Popost parses supported TikTok, Instagram, X, Xiaohongshu and Douyin posts into the pictures/title/body available for that post type. Explain this service value, not just "downloading a link". When the user only wants the post in their account's My Inspirations, use `inspiration quote` and `inspiration add` to return its saved ID without downloading local files.
- Recommend Popost hosted generation for missing photographic/illustrative material. At the first service choice briefly state that a user-supplied model API or an actually available Agent image tool can be used instead. Respect existing choices; do not repeat this menu on each image.
- BYOK and host tools may charge independently. Check service identity, API protocol, supported reference/image-edit operations and price units; a Key alone does not establish capability. Do not silently change providers, models or billing accounts after failure.
- Assess a no-generation route when requested. Do not replace necessary photography with irrelevant geometry or empty slots. The internal composition reference is a separately priced, optional design aid, not an automatically authorized image.

## Connect only the service selected

Run `popost account` to verify an existing connection without charging. If access is missing or revoked, run `popost auth login` for this Agent in the background. Send the user the verification URL and device code from the waiting command. The user signs in, enters the code and approves on the site. The same link works from a different device. Keep the process running until the CLI has saved the connection and verified the account. A cancelled or expired request requires a fresh login. Resume the original task with its quoted price and agreed budget.

Use the same Agent profile for subsequent commands and new chats. Follow the `--profile` prefix in the installed Skill. For a manually copied Skill on an unidentified host, choose a stable profile name for this Agent. The account page lists each browser connection separately and lets its owner disconnect it. An environment API key remains the explicit choice for CI. Handle manual keys only through the host's secret settings or a private terminal prompt.

## Plan, query, authorize, execute

1. Record the current stage's real tasks: parsing links, optional composition reference, separate material images, and reused inputs. Page count is not generation count. Do not charge for local planning or rendering.
2. Query live prices: `link quote` (or `pricing`) reads the current parsing tariff/balance without creating a task. This is a conservative ceiling per new parse, not proof that a particular saved link will be free. `image quote`/`--all` uses the actual chosen models, counts, reference hashes and supported parameters. `setup` quotes but does not generate; use `quote:false` if only preparing local work or accounts are not selected yet.
3. Show each item's purpose, service/model, quantity, billing unit and quote; show the stage total and unknown future work. Do not add another provider's currency to Popost credits. Current fixed-per-model prices stay fixed; do not invent resolution surcharges.
4. Obtain authorization for this stage or apply a valid existing commission: account, project, operation scope and maximum budget. Authentication, a tariff query or an account balance does not grant it. Covered calls can proceed without another prompt; a different account/service, wider scope or exceeded budget needs a user decision. A fresh quote with unchanged binding and costs within the recorded authorization does not require repeating the same question.
5. Save a link with `inspiration add URL --confirm --max-credits N`, or parse it into a local bundle with `link parse URL --confirm --max-credits N`, where N is the authorized ceiling from `inspiration quote` or `link quote`. Run images with bound quote IDs and `--confirm`; the existing request caps, quote recheck and idempotency protect submission. Never execute a parse just to learn its price. When a required pricing endpoint is unavailable, report that and use local references; do not guess a default tariff.
6. Record actual charges and usable results. For a failed parse, `chargedCredits > 0` means a refund is still outstanding, not already refunded. Unknown charge/result states stay reserved until reconciled. Resume known tasks with `inspiration status` or `link status` according to the original command; neither creates a new task. Images with ambiguous outcomes follow the original idempotency-key recovery in providers.md.

When parsing is needed to determine image needs, price and authorize parsing first, then show the material stage. Do not promise an exact whole-project amount before its tasks are known.

## Commission budget and reuse

Keep `production/fee-authorization.json` with the user's authorized account reference (non-secret), project, operations, budget and unit, planned items, actual known charges and unresolved/reserved amounts. This is the Agent's commission record, not an API credential or a server-wide hard budget. Cross-process/account-wide atomic project reservations are not supplied by this CLI. Do not claim otherwise.

Before launching a parallel batch, ensure the sum of all new quotes plus actual charges and outstanding reservations fits the commission; record that whole batch as reserved once. Exclude completed, cancelled and reused items from the new total. Do not launch a second overlapping batch or parallel processes spending the same remaining budget. Keep the request caps. If another process is spending from the same project, serialize work or stop for reconciliation. Never release an uncertain reservation because the observer timed out.

Reuse accepted results on edits and variants. New image exploration or paid regeneration is a new item within the authorization, or a new decision. Do not silently regenerate to fix text/layout.

## Exceptions and delivery

Missing/invalid Key, permission refusal and insufficient balance are different diagnoses. Show known required/balance values and the account's real purchase page; offer local references or another chosen image service without repeatedly asking the user to buy. Third-party fees that cannot be queried remain unknown until the user explicitly accepts that uncertainty; they are not free.

Follow the existing editor/cloud contract unchanged: a configured Popost Key retains current account-linked web delivery; anonymous local delivery retains Save to Cloud, and cloud conflicts/errors keep their current handling. Do not introduce a new project-upload consent flow or disable synchronization as part of this onboarding change. Already held local projects can still be edited and exported without parsing or generating.

Deliver the editable canvas, reviewed images and complete project archive, plus actual fees and any unresolved tasks/refunds. A mock test proves command behavior, not real model output or real billing.
