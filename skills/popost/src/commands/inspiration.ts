/** Save a supported post URL to My Inspirations, or import a local PostBundle. */
import { runSubcommand } from '../providers/cli-args';
import { importInspiration } from '../providers/inspiration';
import { linkStatus, parseLink } from '../providers/link';
import { inspirationQuote } from './pricing';
import type { CommandMain } from '../runtime';

export const main: CommandMain = (argv, rt) =>
  runSubcommand(
    'popost inspiration',
    {
      quote: {
        spec: { description: 'Read the live link import tariff and balance without charging.', options: [{ flag: '--config', help: 'Private provider configuration' }] },
        run: (a) => inspirationQuote(a.string('config') ? ['--config', a.string('config')!] : [], rt),
      },
      add: {
        spec: {
          description: 'Save a TikTok, Douyin, X, Xiaohongshu or Instagram post URL to the current account\'s My Inspirations. Check inspiration quote first, then submit with an authorized credit ceiling. Reused links do not charge again.',
          positionals: [{ name: 'url', help: 'Public post URL (http/https)' }],
          options: [
            { flag: '--confirm', kind: 'flag', help: 'The user authorized this paid link import' },
            { flag: '--max-credits', kind: 'int', help: 'Authorized ceiling from inspiration quote; required unless dry-run' },
            { flag: '--note', help: 'Note for this inspiration (up to 2000 characters)' },
            { flag: '--timeout', kind: 'int', default: 600, help: 'Wait time in seconds (1–3600); use inspiration status if unfinished' },
            { flag: '--dry-run', kind: 'flag', help: 'Describe the request without network access or a charge' },
            { flag: '--config', help: 'Private provider configuration' },
          ],
        },
        run: (a) => parseLink(rt, { url: a.req('url'), note: a.string('note'), timeoutSec: a.number('timeout') as number, noDownload: true, libraryOnly: true, dryRun: a.flag('dry-run'), confirm: a.flag('confirm'), maxCredits: a.number('max-credits'), config: a.string('config') }),
      },
      status: {
        spec: {
          description: 'Check an existing link import task and report its My Inspirations record without creating a new task or charge.',
          positionals: [{ name: 'task-id', help: 'Task ID from inspiration add' }],
          options: [
            { flag: '--timeout', kind: 'int', default: 600, help: 'Wait time in seconds (1–3600)' },
            { flag: '--config', help: 'Private provider configuration' },
          ],
        },
        run: (a) => linkStatus(rt, { taskId: a.req('task-id'), timeoutSec: a.number('timeout') as number, noDownload: true, libraryOnly: true, config: a.string('config') }),
      },
      import: {
        spec: {
          description: '上传本地图片并在 popost.ai 灵感库创建一条灵感',
          options: [
            { flag: '--file', required: true, help: 'PostBundle JSON（postbundle.v1）' },
            { flag: '--note', help: '给这条灵感的备注（覆盖 bundle.note）' },
            { flag: '--client-id', help: '幂等 id（≤64）；默认由内容派生' },
            { flag: '--allow-incomplete', kind: 'flag', help: 'parseStatus 非 ready 时仍保存现有内容（例如只有链接）' },
            { flag: '--dry-run', kind: 'flag', help: '不联网、不需要密钥，只展示计划' },
            { flag: '--config', help: '私有配置 JSON（popost.baseUrl / popost.auth.envVar）' },
          ],
        },
        run: (a) => importInspiration(rt, { file: a.req('file'), note: a.string('note'), clientId: a.string('client-id'), allowIncomplete: a.flag('allow-incomplete'), dryRun: a.flag('dry-run'), config: a.string('config') }),
      },
    },
    argv,
    rt,
  );
