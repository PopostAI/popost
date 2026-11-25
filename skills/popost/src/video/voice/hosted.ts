import type { Runtime } from '../../runtime';
import { sha256 } from '../../core/util';
import { PopostClient, checkUrl, readCapped } from '../../providers/api';
import { isRecord } from '../../providers/base';
import type { Speaker } from './index';

export interface HostedVoice {
  id: string; name: string; description: string; language: string; official: boolean;
  sampleUrl: string; defaultFor: 'male' | 'female' | null; cloneState: string;
}
const client = (rt: Runtime) => new PopostClient(rt, { timeoutSec: 180 });
export const hasHostedVoice = (rt: Runtime): boolean => client(rt).hasKey();
export const hostedVoicePage = async (rt: Runtime, scope = 'all', page = 1) => {
  const data = await client(rt).request('GET', '/voices', { query: { scope, page: String(page), pageSize: '100' } });
  if (!isRecord(data) || !Array.isArray(data.items) || typeof data.total !== 'number') throw new Error('Invalid voice catalog response.');
  return { items: data.items as HostedVoice[], total: data.total };
};
export const selectHostedVoice = async (rt: Runtime, selector = 'default-male'): Promise<HostedVoice> => {
  const key = selector.replace(/^popost:/, '');
  const gender = ['male', 'default-male'].includes(key) ? 'male' : ['female', 'default-female'].includes(key) ? 'female' : null;
  for (let page = 1; ; page += 1) {
    const result = await hostedVoicePage(rt, 'all', page);
    const match = result.items.find((voice) => gender ? voice.defaultFor === gender : voice.id === key);
    if (match) return match;
    if (!result.items.length || page * 100 >= result.total) break;
  }
  throw new Error('The selected voice or configured default is unavailable. Run popost video voice list and choose an available voice.');
};
export const quoteHostedVoice = async (rt: Runtime, voiceId: string, text: string): Promise<number> => {
  const result = await client(rt).request('POST', '/voices/quote', { body: { voiceId, text } });
  if (!isRecord(result) || typeof result.credits !== 'number' || !Number.isSafeInteger(result.credits) || result.credits < 0) throw new Error('Invalid voice quote.');
  return result.credits;
};
export const downloadVoiceAudio = async (rt: Runtime, url: string, out: string): Promise<void> => {
  const response = await rt.fetch(checkUrl(url, 'voice audio'));
  if (!response.ok) throw new Error('The voice audio could not be downloaded.');
  const bytes = await readCapped(response, 50 * 1024 * 1024);
  const tag = (a: number, b: number) => String.fromCharCode(...bytes.subarray(a, b));
  if (tag(0, 4) !== 'RIFF' || tag(8, 12) !== 'WAVE' || bytes.length <= 44) throw new Error('The speech service did not return a WAV recording.');
  await rt.fs.writeFile(out, bytes);
};
export const hostedOperationKey = (voiceId: string, text: string, speed: number, out: string): string => {
  const hex = sha256(JSON.stringify({ voiceId, text, speed, out })).slice(0, 32).split('');
  hex[12] = '4'; hex[16] = '8';
  const id = hex.join('');
  return [id.slice(0,8), id.slice(8,12), id.slice(12,16), id.slice(16,20), id.slice(20)].join('-');
};
export const hostedSpeech = async (rt: Runtime, voice: HostedVoice, text: string, out: string, maxCredits: number, speed = 1, operationPath = out) => {
  const credits = await quoteHostedVoice(rt, voice.id, text);
  if (!Number.isSafeInteger(maxCredits) || maxCredits < credits) throw new Error('Speech exceeds the confirmed credit budget. Run voice quote and set an explicit budget.');
  const operationKey = hostedOperationKey(voice.id, text, speed, operationPath);
  const result = await client(rt).request('POST', '/voices/speech', {
    body: { voiceId: voice.id, text, operationKey, maxCredits: credits, speed }, ambiguous: true,
  });
  if (!isRecord(result) || typeof result.audioUrl !== 'string' || typeof result.chargedCredits !== 'number') throw new Error('Invalid speech response.');
  await downloadVoiceAudio(rt, result.audioUrl, out);
  await rt.fs.writeFile(out + '.voice.json', JSON.stringify({ version: 1, voiceId: voice.id, text, operationKey, audioSha256: sha256(await rt.fs.readFile(out)), tool: 'popost-hosted-voice' }, null, 2));
  return result.chargedCredits;
};
export const hostedSpeaker = (rt: Runtime): Speaker => {
  let remaining = Number(rt.env.POPOST_VOICE_MAX_CREDITS ?? NaN);
  return { speak: async (text, out, options = {}) => {
    if (!Number.isSafeInteger(remaining) || remaining < 0) throw new Error('Hosted speech requires a confirmed POPOST_VOICE_MAX_CREDITS budget. Run voice quote first.');
    const voice = await selectHostedVoice(rt, options.voice);
    remaining -= await hostedSpeech(rt, voice, text, out, remaining, options.speed ?? 1);
  } };
};
