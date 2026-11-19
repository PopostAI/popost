/** `popost account [--config …]`: the account behind the API key, its credit balance and plan. Free. */
import { withArgs, type CommandSpec } from '../args';
import { showAccount } from '../providers/account';
import type { CommandMain } from '../runtime';

const SPEC: CommandSpec = {
  prog: 'popost account',
  description: '查看 popost.ai 账户：积分余额与会员档位（不扣积分）。输出里的 pricing 是平台购买选项页面；也可使用本地参考或其他已选择的生图服务。',
  options: [{ flag: '--config', help: '私有配置 JSON（popost.baseUrl / popost.auth.envVar）' }],
};

export const main: CommandMain = (argv, rt) => withArgs(argv, SPEC, rt, (args) => showAccount(rt, { config: args.string('config') }));
