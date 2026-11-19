/** `popost account [--config …]`: the account behind the API key, its credit balance and plan. Free. */
import { withArgs, type CommandSpec } from '../args';
import { msg } from '../i18n';
import { showAccount } from '../providers/account';
import type { CommandMain } from '../runtime';

const spec = (): CommandSpec => ({
  prog: 'popost account',
  description: msg(
    'Show the popost.ai account: credit balance and membership tier (charges nothing). The pricing field of the output is the page with the buying options of the platform; local references or another chosen image service work too.',
    '查看 popost.ai 账户：积分余额与会员档位（不扣积分）。输出里的 pricing 是平台购买选项页面；也可使用本地参考或其他已选择的生图服务。',
  ),
  options: [{ flag: '--config', help: msg('private config JSON (popost.baseUrl / popost.auth.envVar)', '私有配置 JSON（popost.baseUrl / popost.auth.envVar）') }],
});

export const main: CommandMain = (argv, rt) => withArgs(argv, spec(), rt, (args) => showAccount(rt, { config: args.string('config') }));
