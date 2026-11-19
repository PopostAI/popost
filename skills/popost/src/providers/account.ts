/**
 * `popost account`: the popost.ai account behind the API key: who it is, the credit balance and the plan (`GET /me`).
 * Free: it never charges. Credits pay for platform image generation and link parsing; when the balance cannot cover
 * the next step, `pricing` is where the user buys a membership.
 */
import { printJson } from '../core/util';
import type { Runtime } from '../runtime';
import { DEFAULT_KEY_ENV, PopostClient } from './api';
import { isRecord, type JsonRecord } from './base';
import { loadConfig, providerConfig } from './cli-config';
import { CliReject, ImageProviderError, LOCAL_ERROR_CODES, PopostApiError } from './errors';
import { scrub, secretValues } from './secrets';

/** The membership page of the site that serves this API: `https://popost.ai/api/open/v1` -> `https://popost.ai/pricing`. */
export const pricingUrl = (baseUrl: string): string => `${new URL(baseUrl).origin}/pricing`;

/** What a user is told when credits cannot cover an action; shared by every command that can run out. */
export const membershipHint = (baseUrl: string): string => `这一步需要 Popost 算力，可查看平台提供的购买选项，也可使用本地参考或其他生图服务：${pricingUrl(baseUrl)}`;

const numberOf = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const textOf = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

const viewOf = (data: unknown, baseUrl: string): JsonRecord => {
  const body = isRecord(data) ? data : {};
  const user = isRecord(body.user) ? body.user : {};
  const balance = numberOf(isRecord(body.credits) ? body.credits.balance : null);
  if (balance === null) throw new PopostApiError('popost.ai 返回的账户信息里没有积分余额', { code: 'BAD_RESPONSE' });
  return {
    ok: true,
    user: { name: textOf(user.name), email: textOf(user.email) },
    credits: { balance },
    plan: { tier: textOf(isRecord(body.plan) ? body.plan.tier : null) },
    pricing: pricingUrl(baseUrl),
    note: balance > 0 ? '积分用于平台生图和帖子链接解析；生图先 image quote；解析先 link quote；查询不扣费' : membershipHint(baseUrl),
  };
};

export const showAccount = async (rt: Runtime, call: { readonly config?: string }): Promise<number> => {
  let secrets: string[] = [];
  const show = (value: JsonRecord, code: number): number => {
    printJson(rt, scrub(value, secrets), true);
    return code;
  };
  try {
    const cfg = await loadConfig(rt, call.config);
    secrets = secretValues(rt, cfg);
    const pcfg = providerConfig(cfg, 'popost');
    const auth = isRecord(pcfg.auth) ? pcfg.auth : {};
    const client = new PopostClient(rt, { baseUrl: pcfg.baseUrl as string | undefined, keyEnv: (auth.envVar as string | undefined) || DEFAULT_KEY_ENV, timeoutSec: Number(pcfg.timeoutSec || 60) });
    return show(viewOf(await client.request('GET', '/me'), client.baseUrl), 0);
  } catch (error) {
    if (error instanceof CliReject) return show({ ok: false, code: 'CONFIG', error: error.message }, error.code);
    if (error instanceof PopostApiError) {
      const code = error.code || 'API_ERROR';
      return show({ ok: false, code, error: error.message }, LOCAL_ERROR_CODES.includes(code) ? 2 : 1);
    }
    if (error instanceof ImageProviderError) return show({ ok: false, code: 'ERROR', error: error.message }, 1);
    throw error;
  }
};
