/** Free link tariff query; image jobs retain their existing request-bound image quote flow. */
import { withArgs } from '../args';
import { printJson } from '../core/util';
import { msg } from '../i18n';
import { pricingClient, queryLinkPrice } from '../providers/pricing';
import { CliReject, LOCAL_ERROR_CODES, PopostApiError } from '../providers/errors';
import { scrub, secretValues } from '../providers/secrets';
import { loadConfig } from '../providers/cli-config';
import type { CommandMain } from '../runtime';

const quote = (prog: string, next: () => string): CommandMain => (argv, rt) => withArgs(argv, {
  prog,
  description: msg(
    'Read the current Popost link parsing price and balance; never creates a task or charges. Use image quote for exact image-job prices. A tariff is a conservative per-link ceiling: saved or active results may be reused for less.',
    '查询 Popost 当前的链接解析价格和余额；从不建任务、不扣费。图片任务的准确价格用 image quote 查询。价格是每条链接的保守上限：已保存或进行中的结果可能以更低的价格复用。',
  ),
  options: [{ flag: '--config', help: msg('private provider config', '私有 provider 配置') }],
}, rt, async (args) => {
  let secrets: string[] = [];
  try {
    secrets = secretValues(rt, await loadConfig(rt, args.string('config')));
    const price = await queryLinkPrice(await pricingClient(rt, args.string('config')));
    printJson(rt, scrub({ ok: true, charged: false, linkParse: price, next: next() }, secrets), true);
    return 0;
  } catch (error) {
    if (!(error instanceof PopostApiError || error instanceof CliReject)) throw error;
    const code = error instanceof PopostApiError ? error.code : 'CONFIG';
    const advice = msg(
      'No paid request was made. If pricing is unavailable, use local reference images; never parse a link just to discover its price.',
      '没有发出任何付费请求。查不到价格时改用本地参考图；不要为了知道价格而去解析链接。',
    );
    printJson(rt, scrub({ ok: false, code, error: error.message, charged: false, next: advice }, secrets), true);
    return error instanceof CliReject ? error.code : LOCAL_ERROR_CODES.includes(code ?? '') ? 2 : 1;
  }
});

export const main = quote('popost pricing', () =>
  msg(
    'Show the rate and obtain fee authorization. Then link parse URL --confirm --max-credits <authorized ceiling>. Image fees are quoted separately.',
    '向用户展示价格并取得费用授权，然后运行 link parse URL --confirm --max-credits <已授权上限>。图片费用另行报价。',
  ),
);
export const inspirationQuote = quote('popost inspiration quote', () =>
  msg(
    'Show the rate and obtain fee authorization. Then inspiration add URL --confirm --max-credits <authorized ceiling>.',
    '向用户展示价格并取得费用授权，然后运行 inspiration add URL --confirm --max-credits <已授权上限>。',
  ),
);
