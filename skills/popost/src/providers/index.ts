/** Provider registry: popost (the popost.ai platform, paid), custom (bring your own key), manual / host (not generative). */
import type { Runtime } from '../runtime';
import type { BaseImageProvider, ProviderInit } from './base';
import { CustomHttpProvider, PROVIDER_NAME as CUSTOM_NAME } from './custom-http';
import { ImageProviderError } from './errors';
import { HOST_NAME, HostProvider, MANUAL_NAME, ManualProvider } from './manual-host';
import { PopostProvider, PROVIDER_NAME as POPOST_NAME } from './popost';
import { msg } from '../i18n';

export { POPOST_NAME, CUSTOM_NAME, MANUAL_NAME, HOST_NAME };
export const OFFICIAL_PROVIDER = POPOST_NAME;

type Factory = new (rt: Runtime, init?: ProviderInit) => BaseImageProvider;

const PAID: Record<string, Factory> = { [POPOST_NAME]: PopostProvider, [CUSTOM_NAME]: CustomHttpProvider };
// manual: the user hands over files; host: tools of the host environment, which this Skill neither calls nor bills.
const NON_GENERATIVE: Record<string, Factory> = { [MANUAL_NAME]: ManualProvider, [HOST_NAME]: HostProvider };

export const availablePaidProviders = (): string[] => Object.keys(PAID).sort();
export const allProviderKinds = (): string[] => [...availablePaidProviders(), ...Object.keys(NON_GENERATIVE).sort()];

export const getProvider = (rt: Runtime, name: string, init: ProviderInit = {}): BaseImageProvider => {
  const Provider = PAID[name] ?? NON_GENERATIVE[name];
  if (!Provider) throw new ImageProviderError(msg(`unknown provider ${name} (choose from ${allProviderKinds().join('/')})`, `未知 provider ${name}（可选 ${allProviderKinds().join('/')}）`));
  return new Provider(rt, init);
};
