/** Save a supported post URL to My Inspirations, or import a local PostBundle. */
import { msg } from '../i18n';
import { runSubcommand } from '../providers/cli-args';
import { aroundPath } from '../providers/task';
import { importInspiration } from '../providers/inspiration';
import { linkStatus, parseLink } from '../providers/link';
import { inspirationQuote } from './pricing';
import type { CommandMain } from '../runtime';

const config = () => ({ flag: '--config', help: msg('Private provider configuration', '私有 provider 配置') });

export const main: CommandMain = (argv, rt) =>
  runSubcommand(
    'popost inspiration',
    {
      quote: {
        spec: {
          description: msg('Read the live link import tariff and balance without charging.', '查询实时的链接导入价格和余额，不扣积分。'),
          options: [config()],
        },
        run: (a) => inspirationQuote(a.string('config') ? ['--config', a.string('config')!] : [], rt),
      },
      add: {
        spec: {
          description: msg(
            "Save a TikTok, Douyin, X, Xiaohongshu, Instagram or YouTube post URL to the current account's My Inspirations. Check inspiration quote first, then submit with an authorized credit ceiling. Reused links do not charge again.",
            '把 TikTok、抖音、X、小红书、Instagram 或 YouTube 的帖子链接存入当前账号的「我的灵感」。先用 inspiration quote 查询价格，再带用户授权的积分上限提交。已保存过的链接不会再次扣费。',
          ),
          positionals: [{ name: 'url', help: msg('Public post URL (http/https)', '公开帖子链接（http/https）') }],
          options: [
            { flag: '--confirm', kind: 'flag', help: msg('The user authorized this paid link import', '用户已授权这次付费链接导入') },
            { flag: '--max-credits', kind: 'int', help: msg('Authorized ceiling from inspiration quote; required unless dry-run', 'inspiration quote 报价后授权的上限；dry-run 以外必填') },
            { flag: '--note', help: msg('Note for this inspiration (up to 2000 characters)', '给这条灵感的备注（≤2000 字）') },
            {
              flag: '--timeout',
              kind: 'int',
              default: 600,
              help: msg('Wait time in seconds (1–3600); use inspiration status if unfinished', '等待秒数（1–3600）；未完成时用 inspiration status 继续'),
            },
            { flag: '--dry-run', kind: 'flag', help: msg('Describe the request without network access or a charge', '只描述将发出的请求，不联网、不扣积分') },
            config(),
          ],
        },
        run: (a) => parseLink(rt, { url: a.req('url'), note: a.string('note'), timeoutSec: a.number('timeout') as number, noDownload: true, libraryOnly: true, dryRun: a.flag('dry-run'), confirm: a.flag('confirm'), maxCredits: a.number('max-credits'), config: a.string('config') }),
      },
      status: {
        spec: {
          description: msg(
            'Check an existing link import task and report its My Inspirations record without creating a new task or charge.',
            '查询一个已存在的链接导入任务并报告它在「我的灵感」里的记录，不新建任务、不扣积分。',
          ),
          positionals: [{ name: 'task-id', help: msg('Task ID from inspiration add', 'inspiration add 输出的任务 id') }],
          options: [{ flag: '--timeout', kind: 'int', default: 600, help: msg('Wait time in seconds (1–3600)', '等待秒数（1–3600）') }, config()],
        },
        run: (a) => linkStatus(rt, { taskId: a.req('task-id'), timeoutSec: a.number('timeout') as number, noDownload: true, libraryOnly: true, config: a.string('config') }),
      },
      import: {
        spec: {
          description: msg('upload the local pictures and create an inspiration in the popost.ai inspiration library', '上传本地图片并在 popost.ai 灵感库创建一条灵感'),
          options: [
            { flag: '--file', required: true, help: msg('PostBundle JSON (postbundle.v1)', 'PostBundle JSON（postbundle.v1）') },
            { flag: '--note', help: msg('a note for this inspiration (replaces bundle.note)', '给这条灵感的备注（覆盖 bundle.note）') },
            { flag: '--client-id', help: msg('idempotency id (≤64); derived from the content by default', '幂等 id（≤64）；默认由内容派生') },
            {
              flag: '--allow-incomplete',
              kind: 'flag',
              help: msg('save what there is even when parseStatus is not ready (for example only a link)', 'parseStatus 非 ready 时仍保存现有内容（例如只有链接）'),
            },
            { flag: '--dry-run', kind: 'flag', help: msg('offline and without a key: only show the plan', '不联网、不需要密钥，只展示计划') },
            { flag: '--config', help: msg('private config JSON (popost.baseUrl / popost.auth.envVar)', '私有配置 JSON（popost.baseUrl / popost.auth.envVar）') },
          ],
        },
        // A bundle of a project: the import is made under the project's task (providers/task.ts).
        run: async (a) => importInspiration(await aroundPath(rt, rt.path.dirname(rt.path.resolve(rt.cwd, a.req('file')))), { file: a.req('file'), note: a.string('note'), clientId: a.string('client-id'), allowIncomplete: a.flag('allow-incomplete'), dryRun: a.flag('dry-run'), config: a.string('config') }),
      },
    },
    argv,
    rt,
  );
