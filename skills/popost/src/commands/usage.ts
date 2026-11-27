/**
 * `popost usage --dir P [--budget N]`: what a project has cost on popost.ai so far, as the platform counts it (free).
 * Every request made in a project carries the project's task (providers/task.ts), and `GET /usage/tasks/{id}` answers
 * the net credits of the task, refunds subtracted, item by item; the user's account page shows the same as one line,
 * "Task: <title>". With --budget N, the budget the user agreed (for a video: the one budget of the video), it adds what
 * is left of it; with the agreed clips of a video project (production/approved-clips.json), their count and price.
 * Nothing about the budget is stored: N is given each time.
 */
import { withArgs, type CommandSpec } from '../args';
import { isDir, printJson } from '../core/util';
import { msg } from '../i18n';
import { DEFAULT_KEY_ENV, PopostClient } from '../providers/api';
import { isRecord, type JsonRecord } from '../providers/base';
import { loadConfig, providerConfig } from '../providers/cli-config';
import { CliReject, ImageProviderError, LOCAL_ERROR_CODES, PopostApiError } from '../providers/errors';
import { scrub, secretValues } from '../providers/secrets';
import { inProject, projectTask, VIDEO_MARKS } from '../providers/task';
import type { CommandMain, Runtime } from '../runtime';
import { readClipRecord } from '../video/generate/approved';

const spec = (): CommandSpec => ({
  prog: 'popost usage',
  description: msg(
    'What a project has cost on popost.ai so far (charges nothing): the credits of its task, refunds subtracted, item by item (clips, image tasks, voice-over, transcription, link parsing), as the account page shows them in one line "Task: <title>". With --budget N it prints what is left of the budget the user agreed; pass that as --max-credits to the next paid command.',
    '查看一个工程在 popost.ai 上已经花了多少积分（不扣积分）：它的任务的净积分（已扣除退款），按项目列出（视频片段、图片任务、配音、转写、链接解析），与账户页上的一行「任务：<标题>」一致。加 --budget N 时输出用户同意的预算还剩多少；把它作为下一个付费命令的 --max-credits。',
  ),
  options: [
    { flag: '--dir', required: true, help: msg('the project: an image project, or a video project (the folder of video.json)', '工程目录：图文工程，或视频工程（video.json 所在目录）') },
    { flag: '--budget', kind: 'int', metavar: 'N', help: msg('the budget the user agreed, in credits: adds what is left', '用户同意的预算（积分）：同时输出剩余') },
    { flag: '--config', help: msg('private config JSON (popost.baseUrl / popost.auth.envVar)', '私有配置 JSON（popost.baseUrl / popost.auth.envVar）') },
  ],
});

const KINDS = ['video', 'image', 'voice', 'transcription', 'link', 'search', 'other'];
const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined);

/** The items of the answer as they are, without anything that is not one. */
const itemsOf = (value: unknown): JsonRecord[] =>
  (Array.isArray(value) ? value : []).filter((i): i is JsonRecord => isRecord(i) && KINDS.includes(String(i.kind)) && count(i.credits) !== undefined);

/** The budget part: what is left of --budget, and the agreed clips of a video project. */
const budgetOf = async (rt: Runtime, dir: string, agreed: number | undefined, spent: number): Promise<JsonRecord> => {
  const record = await readClipRecord(rt, dir).catch(() => undefined);
  if (agreed === undefined && !record) return {};
  const clips = record?.clips ?? [];
  return {
    budget: {
      ...(agreed !== undefined ? { agreed, spent, left: Math.max(0, agreed - spent) } : { spent }),
      ...(record ? { agreedClips: { count: clips.length, credits: clips.reduce((n, c) => n + (count(c.credits) ?? 0), 0) } } : {}),
      next:
        agreed !== undefined
          ? msg('Pass left as --max-credits to the next paid command; ask the user again only when a price is above it.', '把 left 作为下一个付费命令的 --max-credits；只有报价超过它时才再问用户。')
          : msg('left = the budget the user agreed − spent (--budget N prints it); pass it as --max-credits to the next paid command.', 'left = 用户同意的预算 − spent（--budget N 会直接输出）；把它作为下一个付费命令的 --max-credits。'),
    },
  };
};

const NOT_A_PROJECT = (dir: string): string =>
  msg(
    `${dir} is not a project: it has no social-studio-project.json, and none of the files of a video project (${VIDEO_MARKS.join(', ')})`,
    `${dir} 不是工程：没有 social-studio-project.json，也没有视频工程的文件（${VIDEO_MARKS.join('、')}）`,
  );

const NOT_REPORTED = msg(
  'The connected popost.ai does not report what a task has cost yet (it has no /usage/tasks). Nothing was charged. Until it does, add up the chargedCredits that each paid command prints.',
  '当前连接的 popost.ai 还不提供任务用量（没有 /usage/tasks）。未扣费。在此之前，请把每个付费命令输出的 chargedCredits 相加。',
);

const showUsage = async (rt: Runtime, call: { dir: string; budget?: number; config?: string }): Promise<number> => {
  let secrets: string[] = [];
  const show = (value: JsonRecord, code: number): number => {
    printJson(rt, scrub(value, secrets), true);
    return code;
  };
  if (call.budget !== undefined && call.budget < 0) return show({ ok: false, code: 'BAD_ARGUMENT', error: msg('--budget is a number of credits, 0 or more', '--budget 是积分数，不小于 0') }, 2);
  const dir = rt.path.resolve(rt.cwd, call.dir);
  const task = (await isDir(rt, dir)) ? await projectTask(rt, { dir, kind: 'found' }, false) : undefined;
  if (!task) return show({ ok: false, code: 'NOT_A_PROJECT', error: NOT_A_PROJECT(call.dir) }, 2);
  const title = task.title ?? null;
  if (!task.id) {
    const note = msg('Nothing has been sent to popost.ai from this project yet, so nothing was charged under it.', '这个工程还没有向 popost.ai 发出过请求，因此没有记在它名下的费用。');
    return show({ ok: true, task: null, title, credits: 0, items: [], ...(await budgetOf(rt, dir, call.budget, 0)), note }, 0);
  }
  try {
    const cfg = await loadConfig(rt, call.config);
    secrets = secretValues(rt, cfg);
    const pcfg = providerConfig(cfg, 'popost');
    const auth = isRecord(pcfg.auth) ? pcfg.auth : {};
    const client = new PopostClient(inProject(rt, dir, 'found'), { baseUrl: pcfg.baseUrl as string | undefined, keyEnv: (auth.envVar as string | undefined) || DEFAULT_KEY_ENV, timeoutSec: Number(pcfg.timeoutSec || 60) });
    const data = await client.request('GET', '/usage/tasks/' + encodeURIComponent(task.id));
    const body = isRecord(data) ? data : {};
    const credits = count(body.credits);
    if (credits === undefined) throw new PopostApiError(msg('popost.ai answered the usage of the task without its credits', 'popost.ai 返回的任务用量里没有积分'), { code: 'BAD_RESPONSE' });
    const named = typeof body.title === 'string' && body.title ? body.title : title;
    return show({ ok: true, task: task.id, title: named, credits, items: itemsOf(body.items), ...(await budgetOf(rt, dir, call.budget, credits)) }, 0);
  } catch (error) {
    if (error instanceof PopostApiError && error.status === 404) return show({ ok: false, code: 'USAGE_NOT_AVAILABLE', task: task.id, title, error: NOT_REPORTED }, 1);
    if (error instanceof CliReject) return show({ ok: false, code: 'CONFIG', error: error.message }, error.code);
    if (error instanceof PopostApiError) {
      const code = error.code || 'API_ERROR';
      return show({ ok: false, code, error: error.message }, LOCAL_ERROR_CODES.includes(code) ? 2 : 1);
    }
    if (error instanceof ImageProviderError) return show({ ok: false, code: 'ERROR', error: error.message }, 1);
    throw error;
  }
};

export const main: CommandMain = (argv, rt) =>
  withArgs(argv, spec(), rt, (args) => showUsage(rt, { dir: args.req('dir'), ...(args.number('budget') !== undefined ? { budget: args.number('budget') } : {}), config: args.string('config') }));
