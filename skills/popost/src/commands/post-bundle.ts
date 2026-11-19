/**
 * `popost ticket|validate|import` (and `service-config`): the unified PostBundle (`post_bundle.py`). Pure local, no
 * network. Failures print `{"ok": false, "error": {"code", "msg"}}` with exit code 2, as the Python module did.
 */
import type { CommandMain, Runtime } from '../runtime';
import { printJson } from '../core/util';
import { msg } from '../i18n';
import { OsError, ValueError } from '../workflow/errors';
import { fromCwd, readUserJson } from '../workflow/io';
import * as bundles from '../workflow/post-bundle';
import { runSubcommand, type Subcommand } from '../workflow/subcommands';

const FILE = [{ flag: '--file', required: true }] as const;

const ticket = (): Subcommand => ({
  spec: {
    description: msg('make a pending ticket for a URL the user gave (nothing is fetched)', '用户给 URL，只建 pending ticket（不抓取）'),
    options: [{ flag: '--url', required: true }, { flag: '--platform', required: true, choices: bundles.PLATFORMS }, { flag: '--out' }],
  },
  run: async (args, rt) => {
    const bundle = bundles.makePendingTicket(rt, args.req('url'), args.req('platform'));
    const out = args.string('out');
    if (out) await rt.fs.writeFile(fromCwd(rt, out), JSON.stringify(bundle, null, 2));
    printJson(rt, { ok: true, route: 'pending-ticket', bundle }, true);
    return 0;
  },
});

const validate = (): Subcommand => ({
  spec: { description: msg('check the structure of a bundle the user supplied', '校验用户提供的 bundle 结构'), options: FILE },
  run: async (args, rt) => {
    const [ok, errors] = bundles.validateBundle(await readUserJson(rt, args.req('file')));
    printJson(rt, { ok, valid: ok, errors }, true);
    return ok ? 0 : 2;
  },
});

const importBundle = (): Subcommand => ({
  spec: {
    description: msg(
      'import a bundle and decide whether it is buildable (a missing picture, missing auth or a pending parse => not buildable)',
      '导入 bundle 并判定 buildable（缺图/auth/parse pending => 不可 build）',
    ),
    options: FILE,
  },
  run: async (args, rt) => {
    const file = args.req('file');
    const data = await readUserJson(rt, file);
    const [ok, errors] = bundles.validateBundle(data);
    if (!ok) {
      printJson(rt, { ok: false, buildable: false, errors }, true);
      return 2;
    }
    const verdict = await bundles.evaluateBuildable(rt, data as bundles.Bundle, rt.path.dirname(fromCwd(rt, file)));
    printJson(rt, { ok: true, buildable: verdict.buildable, blockers: verdict.blockers }, true);
    return verdict.buildable ? 0 : 2;
  },
});

const serviceConfig = (): Subcommand => ({
  spec: { description: msg('print the interface definition of the future parse service (there is no client)', '打印未来解析服务的接口配置定义（无客户端）') },
  run: async (_args, rt) => {
    printJson(rt, { ok: true, service: bundles.serviceConfig() }, true);
    return 0;
  },
});

const table = () => ({ ticket: ticket(), validate: validate(), import: importBundle(), 'service-config': serviceConfig() });

const failure = (rt: Runtime, code: string, error: Error): number => {
  printJson(rt, { ok: false, error: { code, msg: error.message } }, true);
  return 2;
};

export const main: CommandMain = async (argv, rt) => {
  try {
    return await runSubcommand('popost', table(), argv, rt);
  } catch (error) {
    if (error instanceof OsError) return failure(rt, error.code === 'ENOENT' ? 'FILE_NOT_FOUND' : 'NOT_A_FILE', error);
    // A malformed JSON file is what Python reported as JSONDecodeError, a ValueError.
    if (error instanceof ValueError || error instanceof SyntaxError) return failure(rt, 'BAD_ARGS', error);
    throw error;
  }
};
