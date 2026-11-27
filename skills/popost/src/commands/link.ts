/** `popost link parse URL [--note …] [--out DIR] [--timeout SEC] [--no-download] [--dry-run]` and `popost link status TASK_ID`. */
import { main as pricingMain } from './pricing';
import type { OptionSpec } from '../args';
import { msg } from '../i18n';
import { linkStatus, parseLink } from '../providers/link';
import { runSubcommand } from '../providers/cli-args';
import type { CommandMain } from '../runtime';

const out = (): OptionSpec => ({
  flag: '--out',
  help: msg(
    'folder for the pictures and postbundle.json (default inputs/link-<first 8 characters of the task id>)',
    '图片和 postbundle.json 的保存目录（默认 inputs/link-<任务 id 前 8 位>）',
  ),
});
const timeout = (): OptionSpec => ({
  flag: '--timeout',
  kind: 'int',
  default: 600,
  help: msg(
    'longest wait in seconds (1–3600); after a timeout the parse may still finish on the platform: continue with link status',
    '最长等待秒数（1–3600）；超时后解析可能仍会在平台完成，用 link status 继续',
  ),
});
const noDownload = (): OptionSpec => ({
  flag: '--no-download',
  kind: 'flag',
  help: msg(
    'do not download the pictures; only print the post and the picture addresses (short-lived signed links that expire soon)',
    '不下载图片，只打印帖子内容和图片地址（地址是短期签名链接，很快失效）',
  ),
});
const config = (): OptionSpec => ({ flag: '--config', help: msg('private config JSON (popost.baseUrl / popost.auth.envVar)', '私有配置 JSON（popost.baseUrl / popost.auth.envVar）') });

export const main: CommandMain = (argv, rt) =>
  runSubcommand(
    'popost link',
    {
      quote: {
        spec: {
          description: msg('Read the live parsing tariff and balance without creating a task or charging.', '查询实时的链接解析价格和余额，不建任务、不扣积分。'),
          options: [config()],
        },
        run: (a) => pricingMain(a.string('config') ? ['--config', a.string('config')!] : [], rt),
      },
      parse: {
        spec: {
          description: msg(
            'Have popost.ai parse a social post link (X, Instagram, TikTok, Douyin, Xiaohongshu, YouTube; a YouTube video gives its cover, title, description and tags, not the video file), wait for the result, download the pictures and write a PostBundle (postbundle.v1). Get the live price with link quote first, then submit with --confirm --max-credits N, the ceiling the user authorized; the actual net charge is task.chargedCredits; a link already saved is reused without a new charge. The parsed post is also saved to My Inspirations.',
            '让 popost.ai 解析一条社媒帖子链接（X、Instagram、TikTok、抖音、小红书、YouTube；YouTube 视频给出封面、标题、简介和标签，不含视频文件），等待结果，把图片下载到本地并写出 PostBundle（postbundle.v1）。先 link quote 查询动态价格，再带 --confirm --max-credits N 按已授权上限提交；实际净扣见 task.chargedCredits；已保存过的链接直接复用、不再扣。解析结果同时存入「我的灵感」。',
          ),
          positionals: [{ name: 'url', help: msg('the post link (http/https)', '帖子链接（http/https）') }],
          options: [
            { flag: '--confirm', kind: 'flag', help: msg('the user authorized this paid parse', '用户已授权这次付费解析') },
            { flag: '--max-credits', kind: 'int', help: msg('authorized ceiling from link quote; required unless dry-run', 'link quote 报价后授权的上限；dry-run 以外必填') },
            { flag: '--note', help: msg('a note for this post (≤2000 characters)', '给这条帖子的备注（≤2000 字）') },
            out(),
            timeout(),
            noDownload(),
            { flag: '--dry-run', kind: 'flag', help: msg('offline, no key, no charge: only show the requests that would be sent', '不联网、不需要密钥、不扣积分，只展示将发出的请求') },
            config(),
          ],
        },
        run: (a) => parseLink(rt, { url: a.req('url'), note: a.string('note'), out: a.string('out'), timeoutSec: a.number('timeout') as number, noDownload: a.flag('no-download'), dryRun: a.flag('dry-run'), confirm: a.flag('confirm'), maxCredits: a.number('max-credits'), config: a.string('config') }),
      },
      status: {
        spec: {
          description: msg(
            'Keep waiting for an existing parsing task and download its result (after link parse timed out or was interrupted). Creates no task and charges nothing.',
            '继续等待一个已存在的解析任务并下载结果（用于 link parse 超时或被打断之后）。不新建任务、不扣积分。',
          ),
          positionals: [{ name: 'task-id', help: msg('the task.id printed by link parse', 'link parse 输出的 task.id') }],
          options: [out(), timeout(), noDownload(), config()],
        },
        run: (a) => linkStatus(rt, { taskId: a.req('task-id'), out: a.string('out'), timeoutSec: a.number('timeout') as number, noDownload: a.flag('no-download'), config: a.string('config') }),
      },
    },
    argv,
    rt,
  );
