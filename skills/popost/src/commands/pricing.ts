/** Free link tariff query; image jobs retain their existing request-bound image quote flow. */
import { withArgs } from '../args';
import { printJson } from '../core/util';
import { pricingClient, queryLinkPrice } from '../providers/pricing';
import { CliReject, LOCAL_ERROR_CODES, PopostApiError } from '../providers/errors';
import { scrub, secretValues } from '../providers/secrets';
import { loadConfig } from '../providers/cli-config';
import type { CommandMain } from '../runtime';

const quote = (prog: string, next: string): CommandMain => (argv, rt) => withArgs(argv, {
  prog,
  description: 'Read the current Popost link parsing price and balance; never creates a task or charges. Use image quote for exact image-job prices. A tariff is a conservative per-link ceiling: saved or active results may be reused for less.',
  options: [{ flag: '--config', help: 'private provider config' }],
}, rt, async (args) => {
  let secrets: string[] = [];
  try {
    secrets = secretValues(rt, await loadConfig(rt, args.string('config')));
    const price = await queryLinkPrice(await pricingClient(rt, args.string('config')));
    printJson(rt, scrub({ ok: true, charged: false, linkParse: price, next }, secrets), true);
    return 0;
  } catch (error) {
    if (!(error instanceof PopostApiError || error instanceof CliReject)) throw error;
    const code = error instanceof PopostApiError ? error.code : 'CONFIG';
    printJson(rt, scrub({ ok: false, code, error: error.message, charged: false, next: 'No paid request was made. If pricing is unavailable, use local reference images; never parse a link just to discover its price.' }, secrets), true);
    return error instanceof CliReject ? error.code : LOCAL_ERROR_CODES.includes(code ?? '') ? 2 : 1;
  }
});

export const main = quote('popost pricing', 'Show the rate and obtain fee authorization. Then link parse URL --confirm --max-credits <authorized ceiling>. Image fees are quoted separately.');
export const inspirationQuote = quote('popost inspiration quote', 'Show the rate and obtain fee authorization. Then inspiration add URL --confirm --max-credits <authorized ceiling>.');
