import { describe, expect, it } from 'vitest';
import { createTestRuntime, runCli } from '../../src/testing/memory';
import { hostedSpeaker, hostedSpeech, selectHostedVoice } from '../../src/video/voice/hosted';

const male = { id: '40ae377c-7f86-4a57-ab15-aa2bd917cf37', name: 'Default male', description: '', language: 'zh', official: true, sampleUrl: 'https://audio.example.test/sample.wav', defaultFor: 'male' as const, cloneState: 'ready' };
const female = { ...male, id: 'c47caa4e-9388-4b87-aad6-5e131d7f8660', name: 'Default female', defaultFor: 'female' as const };
const wav = () => {
  const bytes = new Uint8Array(46); const view = new DataView(bytes.buffer);
  const text = (at: number, value: string) => [...value].forEach((c, i) => bytes[at + i] = c.charCodeAt(0));
  text(0,'RIFF'); view.setUint32(4,38,true); text(8,'WAVEfmt '); view.setUint32(16,16,true);
  view.setUint16(20,1,true); view.setUint16(22,1,true); view.setUint32(24,24000,true); view.setUint32(28,48000,true);
  view.setUint16(32,2,true); view.setUint16(34,16,true); text(36,'data'); view.setUint32(40,2,true); return bytes;
};
const setup = (budget?: number) => {
  const requests: Request[] = []; const operationKeys: string[] = [];
  const rt = createTestRuntime({ env: { POPOST_API_KEY: 'test-platform-credential', POPOST_BASE_URL: 'https://platform.example.test/api/open/v1', ...(budget === undefined ? {} : { POPOST_VOICE_MAX_CREDITS: String(budget) }) },
    fetchHandler: async request => {
      requests.push(request.clone()); const url = new URL(request.url);
      const ok = (data: unknown) => Response.json({success:true,data,error:null});
      if(url.hostname === 'audio.example.test') { expect(request.headers.get('authorization')).toBeNull(); return new Response(wav(),{headers:{'content-type':'audio/wav'}}); }
      if(url.pathname.endsWith('/voices')) return ok({items:[male,female],total:2});
      if(url.pathname.endsWith('/quote')) return ok({credits:1});
      if(url.pathname.endsWith('/speech')) { const body = await request.json() as {operationKey:string; maxCredits:number;voiceId:string}; operationKeys.push(body.operationKey); expect(body.maxCredits).toBe(1); expect(body.voiceId).toBe(male.id); return ok({audioUrl:'https://audio.example.test/result.wav',chargedCredits:1}); }
      throw new Error('Unexpected test request');
    } });
  return {rt,requests,operationKeys};
};
describe('hosted voice identity and spending', () => {
  it('reads configured male and female defaults from the live catalog without synthesis', async () => {
    const {rt,requests,operationKeys} = setup();
    expect((await selectHostedVoice(rt,'popost:default-male')).id).toBe(male.id);
    expect((await selectHostedVoice(rt,'default-female')).id).toBe(female.id);
    await expect(selectHostedVoice(rt,'missing-id')).rejects.toThrow('unavailable');
    expect(requests.every(request => request.method === 'GET')).toBe(true); expect(operationKeys).toEqual([]);
    expect((await runCli(rt,['video','voice','list','--scope','official'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ok:true,total:2});
  });
  it('requires a budget before speech and enforces the aggregate command budget', async () => {
    const missing = setup(); await expect(hostedSpeaker(missing.rt).speak('Hello','/work/no.wav')).rejects.toThrow('budget');
    expect(missing.requests).toHaveLength(0);
    const {rt,operationKeys} = setup(1); const speaker = hostedSpeaker(rt);
    await speaker.speak('First','/work/first.wav');
    await expect(speaker.speak('Second','/work/second.wav')).rejects.toThrow('budget');
    expect(operationKeys).toHaveLength(1); expect(await rt.fs.stat('/work/second.wav')).toBeNull();
  });
  it('keeps a stable operation key for retries and records real downloaded bytes', async () => {
    const {rt,operationKeys} = setup();
    await hostedSpeech(rt,male,'Hello','/work/line.wav',1);
    await hostedSpeech(rt,male,'Hello','/work/line.wav',1);
    expect(operationKeys[0]).toBe(operationKeys[1]);
    expect(await rt.fs.readFile('/work/line.wav')).toEqual(wav());
    expect(JSON.parse(await rt.fs.readText('/work/line.wav.voice.json'))).toMatchObject({voiceId:male.id,text:'Hello',operationKey:operationKeys[0],tool:'popost-hosted-voice'});
    await hostedSpeech(rt,male,'New words','/work/line.wav',1);
    expect(operationKeys[2]).not.toBe(operationKeys[0]);
  });
});
