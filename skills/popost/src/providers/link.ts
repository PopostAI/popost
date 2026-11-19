/**
 * `popost link parse|status`: asks the popost.ai platform to parse a social post link (X, Instagram, TikTok, Douyin,
 * Xiaohongshu) into pictures and text, waits for the result, downloads the pictures and writes a PostBundle.
 *
 * - `parse`: `POST /links/parse` creates the task (this is the call that can charge credits; the amount is the
 *   platform's and is only ever shown as `task.chargedCredits` from its answer). Its outcome may be unknown (timeout,
 *   dropped connection): then nothing is retried. Running the same command again is safe by the platform's rules: a task
 *   still running for the link is joined without a second charge, and a link already saved comes back at once for free.
 * - both: `GET /links/parse?id=` every ~2 s until the task succeeded or failed, `--timeout` passes, or too many polls in
 *   a row failed; the last two leave the task running on the platform and say how to resume with `link status`, which
 *   never creates or charges anything.
 * - on success the pictures go to `--out` (default `inputs/link-<task id start>/`) as `01.jpg`, `02.webp`, ... beside a
 *   `postbundle.json` that `validate`, `import`, `attach-bundle` read. `--no-download` prints the post with its
 *   short-lived picture URLs instead.
 *
 * Credentials and base URL are those of the popost channel (the key from `POPOST_API_KEY` or the one `popost auth set`
 * saved, `popost.baseUrl` / `POPOST_BASE_URL`);
 * the key is read when a request is sent and is scrubbed from everything printed. `--dry-run` needs neither network nor key.
 */
import { printJson, writeJson } from '../core/util';
import { msg } from '../i18n';
import type { Runtime } from '../runtime';
import { validateBundle } from '../workflow/post-bundle';
import { DEFAULT_KEY_ENV, PopostClient } from './api';
import { isRecord, type JsonRecord } from './base';
import { loadConfig, providerConfig } from './cli-config';
import { AmbiguousSubmitError, CliReject, ImageProviderError, LOCAL_ERROR_CODES, PopostApiError } from './errors';
import { badResponse, buildBundle, downloadPictures, planPost, remoteView } from './link-bundle';
import { MAX_POLL_FAILURES, TASK_ID, taskOf, waitForTask, type LinkTask } from './link-task';
import { resolvePath } from './paths';
import { scrub, secretValues } from './secrets';

export const NOTE_MAX = 2000;
export const TIMEOUT_MAX_SEC = 3600;
/** Local problems (no request was made): exit 2 instead of 1. */
const LOCAL_CODES = [...LOCAL_ERROR_CODES, 'BAD_ARGS'];

export interface LinkOptions {
  readonly out?: string;
  readonly timeoutSec: number;
  readonly noDownload: boolean;
  readonly libraryOnly?: boolean;
  readonly config?: string;
}

export interface ParseCall extends LinkOptions {
  readonly url: string;
  readonly note?: string;
  readonly dryRun: boolean;
  readonly confirm?: boolean;
  readonly maxCredits?: number;
}

export interface StatusCall extends LinkOptions {
  readonly taskId: string;
}

interface Outcome {
  readonly body: JsonRecord;
  readonly exit: number;
}

/** What is known of the task so far, for the report of a failure. */
interface State {
  id: string | null;
  task: LinkTask | null;
}

const shellArg = (text: string): string => (/^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`);

const resumeCommand = (id: string, call: LinkOptions): string => call.libraryOnly
  ? `popost inspiration status ${id}`
  : `popost link status ${id}${call.out ? ` --out ${shellArg(call.out)}` : ''}`;

const briefOf = (state: State): JsonRecord => ({ id: state.id, ...(state.task ? { status: state.task.status, chargedCredits: state.task.chargedCredits } : {}) });

const badArgs = (message: string): PopostApiError => new PopostApiError(message, { code: 'BAD_ARGS' });

const checkOptions = async (rt: Runtime, call: LinkOptions): Promise<void> => {
  if (!Number.isInteger(call.timeoutSec) || call.timeoutSec < 1 || call.timeoutSec > TIMEOUT_MAX_SEC) throw badArgs(msg(`--timeout must be a whole number of seconds from 1 to ${TIMEOUT_MAX_SEC}`, `--timeout 须为 1–${TIMEOUT_MAX_SEC} 的整数秒`));
  if (call.out && (await rt.fs.stat(resolvePath(rt, call.out)))?.isFile) throw badArgs(msg('--out is a file; it must be a folder', '--out 是一个文件，需要目录'));
};

/** The body of `POST /links/parse`; a link or note the platform would refuse is refused here, before anything is sent. */
const parseBody = (call: ParseCall): JsonRecord => {
  const url = call.url.trim();
  let protocol = '';
  try {
    protocol = new URL(url).protocol;
  } catch {
    protocol = '';
  }
  if (protocol !== 'http:' && protocol !== 'https:') throw badArgs(msg('the link must be a post address starting with http:// or https://', '链接必须是 http:// 或 https:// 开头的帖子地址'));
  const note = (call.note ?? '').trim();
  const length = [...note].length;
  if (length > NOTE_MAX) throw badArgs(msg(`--note is longer than the ${NOTE_MAX}-character limit (it has ${length})`, `--note 超过上限 ${NOTE_MAX} 字（当前 ${length}）`));
  return { url, ...(note ? { note } : {}), ...(call.maxCredits !== undefined ? { maxCredits: call.maxCredits } : {}) };
};

const outDirOf = (rt: Runtime, out: string | undefined, id: string): string => (out ? resolvePath(rt, out) : rt.path.join(rt.cwd, 'inputs', `link-${id.slice(0, 8)}`));

const makeClient = (rt: Runtime, cfg: JsonRecord): PopostClient => {
  const pcfg = providerConfig(cfg, 'popost');
  const auth = isRecord(pcfg.auth) ? pcfg.auth : {};
  return new PopostClient(rt, { baseUrl: pcfg.baseUrl as string | undefined, keyEnv: (auth.envVar as string | undefined) || DEFAULT_KEY_ENV, timeoutSec: Number(pcfg.timeoutSec || 60) });
};

/** What would be sent, with the key shown as `$ENV_NAME`; nothing is sent. */
const dryRunOf = (rt: Runtime, client: PopostClient, body: JsonRecord, call: ParseCall): JsonRecord => ({
  ok: true,
  dryRun: true,
  request: client.describeRequest('POST', '/links/parse', body),
  then: { ...client.describeRequest('GET', '/links/parse'), url: `${client.url('/links/parse')}?id=<task id>`, note: msg('polled every 2 seconds until the task succeeds, fails or --timeout passes', '每 2 秒查询一次，直到任务成功、失败或超过 --timeout') },
  download:
    call.noDownload || call.libraryOnly
      ? null
      : { dir: call.out ? resolvePath(rt, call.out) : rt.path.join(rt.cwd, 'inputs', msg('link-<first 8 characters of the task id>', 'link-<task id 前 8 位>')) },
  ...(call.libraryOnly ? { saveTo: 'My Inspirations' } : {}),
  message: msg('dry run: nothing was sent, no task was created, no credits will be charged', 'dry-run：未联网、未建任务、不会扣积分'),
});

const createTask = async (client: PopostClient, body: JsonRecord): Promise<LinkTask> => {
  const hint = msg(
    'Running the same command again is safe: while a task for the same link is still running it is joined without a second charge, and a link already saved comes back at once without a charge',
    '重新运行同一条命令是安全的：同一链接的任务仍在进行时会并入同一任务、不重复扣积分；已保存的链接会直接返回、也不再扣积分',
  );
  const task = taskOf(await client.request('POST', '/links/parse', { body, ambiguous: true, hint }));
  if (!task)
    throw new AmbiguousSubmitError(
      msg(
        `The POST /links/parse answer has no task.id or status, so the outcome is unknown: a task may have been created and charged. ${hint}`,
        `POST /links/parse 响应缺少 task.id 或 status，结果不确定，可能已建任务并扣积分。${hint}`,
      ),
    );
  return task;
};

const codeText = (code: string): string | undefined =>
  ({
    LINK_POST_NOT_FOUND: msg('the post was not found (the link is broken, the post was deleted, or it is not public)', '没有找到这条帖子（链接失效、已删除，或不是公开帖子）'),
    LINK_PARSE_FAILED: msg('parsing the post failed', '帖子解析失败'),
    LINK_IMAGES_FAILED: msg('fetching the pictures of the post failed', '帖子的图片获取失败'),
    LINK_PARSE_UNAVAILABLE: msg('the parsing service is temporarily unavailable; try again later', '解析服务暂时不可用，请稍后重试'),
  })[code];

/** A task the platform finished as failed: its own code and message; the platform refunds failed tasks by itself. */
const failedOutcome = (task: LinkTask): Outcome => {
  const code = task.error?.code ?? 'LINK_PARSE_FAILED';
  const message = (task.error?.message ?? '').trim().slice(0, 300) || codeText(code) || msg('parsing failed', '解析失败');
  return { exit: 1, body: { ok: false, code, error: message, task: { id: task.id, status: task.status, chargedCredits: task.chargedCredits } } };
};

/** Waiting ended with the task still unfinished: it may complete on the platform; `link status` picks it up. */
const unfinishedOutcome = (code: string, what: string, id: string, task: LinkTask | null, call: LinkOptions): Outcome => {
  const resume = resumeCommand(id, call);
  const error = call.libraryOnly
    ? msg(
        `${what} The parsing may still finish on the platform: run ${resume} to keep waiting for the saved result (no new task is created and nothing is charged again)`,
        `${what}解析可能仍会在平台完成：运行 ${resume} 继续等待保存结果（不会新建任务，也不会再次扣积分）`,
      )
    : msg(
        `${what} The parsing may still finish on the platform: run ${resume} to keep waiting and download it (no new task is created and nothing is charged again)`,
        `${what}解析可能仍会在平台完成：运行 ${resume} 继续等待并下载（不会新建任务，也不会再次扣积分）`,
      );
  return { exit: 1, body: { ok: false, code, error, task: { id, status: task?.status ?? null, chargedCredits: task?.chargedCredits ?? null }, resume } };
};

const succeededOutcome = async (rt: Runtime, task: LinkTask, call: LinkOptions, fallback: { url?: string; note?: string }): Promise<Outcome> => {
  if (!task.post) throw badResponse(msg('the task succeeded but the answer has no post', '任务已成功，但响应里没有 post'));
  const plan = planPost(task.post, fallback.url, fallback.note);
  const info = { id: task.id, status: task.status, created: task.created, chargedCredits: task.chargedCredits };
  if (call.libraryOnly) {
    if (!plan.inspirationId)
      throw badResponse(msg('the task succeeded but the answer has no inspiration id, so the saved result cannot be confirmed', '任务已成功，但响应里没有灵感 id，无法确认保存结果'));
    const inspiration = { id: plan.inspirationId, platform: plan.platform, title: plan.title, sourceUrl: plan.sourceUrl, imageCount: plan.images.length };
    return { exit: 0, body: { ok: true, task: info, inspiration, note: msg('saved to My Inspirations of the current account', '已保存到当前账号的「我的灵感」') } };
  }
  if (call.noDownload) {
    const command = resumeCommand(task.id, call);
    const note = msg(
      `the picture addresses are short-lived signed links that expire soon; to save the pictures locally, run ${command} (without --no-download)`,
      `图片地址是短期签名链接，很快失效；要保存到本地，运行 ${command}（不带 --no-download）`,
    );
    return { exit: 0, body: { ok: true, task: info, post: remoteView(plan), note } };
  }
  const outDir = outDirOf(rt, call.out, task.id);
  const command = resumeCommand(task.id, call);
  const retry = msg(
    `run ${command} again to download again (the picture addresses are signed anew on every query)`,
    `重新运行 ${command} 即可重新下载（图片地址每次查询都会重新签发）`,
  );
  const { saved, failure } = await downloadPictures(rt, plan.images, outDir, retry);
  const images = saved.map((s) => s.path);
  if (failure) return { exit: 1, body: { ok: false, code: 'DOWNLOAD_FAILED', error: failure, task: { id: task.id, status: task.status, chargedCredits: task.chargedCredits }, images, resume: resumeCommand(task.id, call) } };
  const bundle = buildBundle(rt, plan, saved);
  const [valid, errors] = validateBundle(bundle);
  if (!valid) throw badResponse(msg(`the parsed result does not make a valid PostBundle: ${errors.join('; ')}`, `解析结果无法组成合法的 PostBundle：${errors.join('；')}`));
  const bundlePath = rt.path.join(outDir, 'postbundle.json');
  await writeJson(rt, bundlePath, bundle);
  const file = shellArg(bundlePath);
  const note = saved.length
    ? msg('the platform saved this post to My Inspirations; do not save it again with inspiration import', '平台已把这条帖子存入「我的灵感」；不要再用 inspiration import 重复保存')
    : msg(
        'the post has no pictures: the bundle is marked missing_resources and cannot be built directly; the platform saved this post to My Inspirations',
        '帖子里没有图片：bundle 标为 missing_resources，不能直接 build；平台已把这条帖子存入「我的灵感」',
      );
  const post = { platform: plan.platform, title: plan.title, sourceUrl: plan.sourceUrl, imageCount: saved.length, ...(plan.inspirationId ? { inspirationId: plan.inspirationId } : {}) };
  return { exit: 0, body: { ok: true, task: info, bundle: bundlePath, images, post, next: `popost validate --file ${file} && popost import --file ${file}`, note } };
};

/** Waits for the task, then delivers it. `first` is the task the POST returned, if there was one. */
const finish = async (rt: Runtime, client: PopostClient, state: State, first: LinkTask | null, call: LinkOptions, fallback: { url?: string; note?: string }): Promise<Outcome> => {
  const id = state.id as string;
  const waited = await waitForTask(rt, client, id, first, call.timeoutSec);
  if (waited.task) state.task = waited.task;
  if (waited.kind === 'timeout')
    return unfinishedOutcome('WAIT_TIMEOUT', msg(`The task had not finished after ${call.timeoutSec} seconds.`, `等待 ${call.timeoutSec} 秒后任务仍未结束。`), id, waited.task, call);
  if (waited.kind === 'gave-up') {
    const what = msg(
      `Checking the task status failed ${MAX_POLL_FAILURES} times in a row (${waited.error.message}); stopped waiting.`,
      `连续 ${MAX_POLL_FAILURES} 次查询任务状态失败（${waited.error.message}），已停止等待。`,
    );
    return unfinishedOutcome('POLL_FAILED', what, id, waited.task, call);
  }
  return waited.task.status === 'failed' ? failedOutcome(waited.task) : succeededOutcome(rt, waited.task, call, fallback);
};

interface Failure {
  readonly code: string;
  readonly exit: number;
  readonly message: string;
}

const failureOf = (error: unknown): Failure | null => {
  if (error instanceof CliReject) return { code: 'CONFIG', exit: error.code, message: error.message };
  if (error instanceof AmbiguousSubmitError) return { code: 'UNCERTAIN', exit: 1, message: error.message };
  if (error instanceof PopostApiError) {
    const code = error.code || 'API_ERROR';
    // the shared wording of this code speaks of quotes, which a link does not have
    const message =
      code === 'INSUFFICIENT_CREDITS'
        ? msg(
            'Not enough credits to parse this link: parsing a post link is paid with popost credits. No task was created and no credits were charged. popost account shows the balance and how to buy more; if the user does not buy credits, continue with local references such as screenshots and text [INSUFFICIENT_CREDITS]',
            '积分不足，无法解析这条链接：解析帖子链接需要 popost 积分，可用 popost account 查看余额与购买选项，也可改用本地图片和文字参考（未建任务，未扣积分；popost account 可查余额和购买页面）；用户不购买时改用截图和文字等本地参考继续 [INSUFFICIENT_CREDITS]',
          )
        : error.message;
    return { code, exit: LOCAL_CODES.includes(code) ? 2 : 1, message };
  }
  if (error instanceof ImageProviderError) return { code: 'ERROR', exit: 1, message: error.message };
  return null;
};

/** Runs `work` and prints its one JSON document; returns the exit code (0 done, 1 refused / failed / unfinished, 2 input / environment). */
const report = async (rt: Runtime, call: LinkOptions, state: State, work: (cfg: JsonRecord) => Promise<Outcome>): Promise<number> => {
  let secrets: string[] = [];
  const show = (value: JsonRecord, code: number): number => {
    printJson(rt, scrub(value, secrets), true);
    return code;
  };
  try {
    await checkOptions(rt, call);
    const cfg = await loadConfig(rt, call.config);
    secrets = secretValues(rt, cfg);
    const outcome = await work(cfg);
    return show(outcome.body, outcome.exit);
  } catch (error) {
    const failure = failureOf(error);
    if (!failure) throw error;
    const known = state.id ? { task: briefOf(state), ...(state.task ? { resume: resumeCommand(state.id, call) } : {}) } : {};
    return show({ ok: false, code: failure.code, error: failure.message, ...known }, failure.exit);
  }
};

/** `popost link parse URL`: creates the task (or joins it), waits, downloads and writes the bundle. */
export const parseLink = (rt: Runtime, call: ParseCall): Promise<number> => {
  const state: State = { id: null, task: null };
  return report(rt, call, state, async (cfg) => {
    const body = parseBody(call);
    const client = makeClient(rt, cfg);
    if (call.dryRun) return { exit: 0, body: dryRunOf(rt, client, body, call) };
    const quoteCommand = call.libraryOnly ? 'inspiration quote' : 'link quote';
    if (!call.confirm)
      throw badArgs(
        msg(
          `Fee authorization required: show ${quoteCommand} first, then use --confirm --max-credits <authorized ceiling>.`,
          `需要用户授权费用：先展示 ${quoteCommand} 的报价，再用 --confirm --max-credits <已授权上限> 提交。`,
        ),
      );
    if (!Number.isSafeInteger(call.maxCredits) || Number(call.maxCredits) < 0)
      throw badArgs(
        msg(`--max-credits must be the authorized non-negative integer ceiling from ${quoteCommand}.`, `--max-credits 必须是 ${quoteCommand} 报价后用户授权的非负整数上限。`),
      );
    const created = await createTask(client, body);
    state.id = created.id;
    state.task = created;
    if (created.status !== 'succeeded' && created.status !== 'failed')
      rt.stderr(
        msg(
          `Task ${created.id} created; waiting for the parse (up to ${call.timeoutSec} seconds). If this is interrupted, run ${resumeCommand(created.id, call)} to continue\n`,
          `任务 ${created.id} 已创建，等待解析（最长 ${call.timeoutSec} 秒）；中途被打断可运行 ${resumeCommand(created.id, call)} 继续\n`,
        ),
      );
    return finish(rt, client, state, created, call, { url: String(body.url), note: body.note as string | undefined });
  });
};

/** `popost link status TASK_ID`: the same wait and download for a task that exists; never creates or charges. */
export const linkStatus = (rt: Runtime, call: StatusCall): Promise<number> => {
  const state: State = { id: null, task: null };
  return report(rt, call, state, async (cfg) => {
    const source = `popost ${call.libraryOnly ? 'inspiration add' : 'link parse'}`;
    if (!TASK_ID.test(call.taskId))
      throw badArgs(msg(`the task id has the wrong format (it should be the task.id printed by ${source})`, `任务 id 格式不对（应是 ${source} 输出的 task.id）`));
    state.id = call.taskId;
    return finish(rt, makeClient(rt, cfg), state, null, call, {}); // the first poll is at once
  });
};
