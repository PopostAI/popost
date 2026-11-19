/** Public, read-only tariff queries. Never derive a current price from task charges or a fixture. */
import type { Runtime } from '../runtime';
import { DEFAULT_KEY_ENV, PopostClient } from './api';
import { isRecord, type JsonRecord } from './base';
import { loadConfig, providerConfig } from './cli-config';
import { PopostApiError } from './errors';

export const pricingClient = async (rt: Runtime, config?: string): Promise<PopostClient> => {
  const pcfg = providerConfig(await loadConfig(rt, config), 'popost');
  const auth = isRecord(pcfg.auth) ? pcfg.auth : {};
  return new PopostClient(rt, { baseUrl: pcfg.baseUrl as string | undefined, keyEnv: typeof auth.envVar === 'string' ? auth.envVar : DEFAULT_KEY_ENV });
};

export const queryLinkPrice = async (client: PopostClient): Promise<JsonRecord> => {
  const body = await client.request('GET', '/pricing');
  const link = isRecord(body) && isRecord(body.linkParse) ? body.linkParse : {};
  if (!isRecord(body) || body.unit !== 'credits' || !Number.isSafeInteger(link.creditsPerRequest) || Number(link.creditsPerRequest) < 0 || typeof body.balance !== 'number' || !Number.isFinite(body.balance) || body.balance < 0)
    throw new PopostApiError('解析价格查询响应无效；未创建任务、未扣费，请勿猜测价格', { code: 'BAD_RESPONSE' });
  return { creditsPerRequest: link.creditsPerRequest, balance: body.balance, sufficient: body.balance >= Number(link.creditsPerRequest), unit: 'credits', source: `${client.baseUrl}/pricing` };
};
