/** `popost link parse URL [--note …] [--out DIR] [--timeout SEC] [--no-download] [--dry-run]` and `popost link status TASK_ID`. */
import { main as pricingMain } from './pricing';
import type { OptionSpec } from '../args';
import { linkStatus, parseLink } from '../providers/link';
import { runSubcommand } from '../providers/cli-args';
import type { CommandMain } from '../runtime';

const OUT: OptionSpec = { flag: '--out', help: '图片和 postbundle.json 的保存目录（默认 inputs/link-<任务 id 前 8 位>）' };
const TIMEOUT: OptionSpec = { flag: '--timeout', kind: 'int', default: 600, help: '最长等待秒数（1–3600）；超时后解析可能仍会在平台完成，用 link status 继续' };
const NO_DOWNLOAD: OptionSpec = { flag: '--no-download', kind: 'flag', help: '不下载图片，只打印帖子内容和图片地址（地址是短期签名链接，很快失效）' };
const CONFIG: OptionSpec = { flag: '--config', help: '私有配置 JSON（popost.baseUrl / popost.auth.envVar）' };

export const main: CommandMain = (argv, rt) =>
  runSubcommand(
    'popost link',
    {
      quote: {
        spec: { description: 'Read the live parsing tariff and balance without creating a task or charging.', options: [CONFIG] },
        run: (a) => pricingMain(a.string('config') ? ['--config', a.string('config')!] : [], rt),
      },
      parse: {
        spec: {
          description:
            '让 popost.ai 解析一条社媒帖子链接（X、Instagram、TikTok、抖音、小红书），等待结果，把图片下载到本地并写出 PostBundle（postbundle.v1）。先 link quote 查询动态价格，再带 --confirm --max-credits N 按已授权上限提交；实际净扣见 task.chargedCredits；已保存过的链接直接复用、不再扣。解析结果同时存入「我的灵感」。',
          positionals: [{ name: 'url', help: '帖子链接（http/https）' }],
          options: [
            { flag: '--confirm', kind: 'flag', help: 'the user authorized this paid parse' },
            { flag: '--max-credits', kind: 'int', help: 'authorized ceiling from link quote; required unless dry-run' },
            { flag: '--note', help: '给这条帖子的备注（≤2000 字）' },
            OUT,
            TIMEOUT,
            NO_DOWNLOAD,
            { flag: '--dry-run', kind: 'flag', help: '不联网、不需要密钥、不扣积分，只展示将发出的请求' },
            CONFIG,
          ],
        },
        run: (a) => parseLink(rt, { url: a.req('url'), note: a.string('note'), out: a.string('out'), timeoutSec: a.number('timeout') as number, noDownload: a.flag('no-download'), dryRun: a.flag('dry-run'), confirm: a.flag('confirm'), maxCredits: a.number('max-credits'), config: a.string('config') }),
      },
      status: {
        spec: {
          description: '继续等待一个已存在的解析任务并下载结果（用于 link parse 超时或被打断之后）。不新建任务、不扣积分。',
          positionals: [{ name: 'task-id', help: 'link parse 输出的 task.id' }],
          options: [OUT, TIMEOUT, NO_DOWNLOAD, CONFIG],
        },
        run: (a) => linkStatus(rt, { taskId: a.req('task-id'), out: a.string('out'), timeoutSec: a.number('timeout') as number, noDownload: a.flag('no-download'), config: a.string('config') }),
      },
    },
    argv,
    rt,
  );
