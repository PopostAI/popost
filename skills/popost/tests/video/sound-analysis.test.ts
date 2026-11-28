/**
 * The hosted sound analysis (sound/analysis.ts) against the in-memory platform: priced first, run within the wallet,
 * read back without a second charge, and every way it can be missing (no account, an older server, too long, a
 * failure, a wallet that does not cover it) is a record that says why, never the end of the reading.
 */
import { describe, expect, it } from 'vitest';
import { sha256 } from '../../src/core/util';
import { createTestRuntime } from '../../src/testing/memory';
import { planAnalysis, runAnalysis, type HeardSound } from '../../src/video/sound/analysis';
import { soundFileOf } from '../../src/video/sound/reading';
import { Wallet } from '../../src/video/wallet';
import { ENV, fakePlatform, wav, type FakeOptions } from './hosted-fake';

const RESULT = { music: { present: true, genre: 'lo-fi', mood: 'calm', tempo: 'slow', bpm: 80, instruments: ['piano'], vocals: 'none', sections: [] }, ambience: { present: false }, effects: [{ at: 1.5, what: 'a click', kind: 'click' }], speech: { present: false, kind: 'none', languages: [] }, summary: 'Calm music.' };
const sound = (seconds = 30): HeardSound => { const bytes = wav({ seconds }); return { bytes, sha256: sha256(bytes), seconds }; };
const setup = (o: FakeOptions = {}, env: Record<string, string> = ENV) => {
  const platform = fakePlatform({ balance: 100, ...o });
  return { platform, rt: createTestRuntime({ env, fetchHandler: platform.handler, sleep: async () => undefined }) };
};

describe('the hosted sound analysis', () => {
  it('is priced by its length before anything is uploaded', async () => {
    const { rt, platform } = setup({ soundAnalysis: RESULT });
    const plan = await planAnalysis(rt, sound(30));
    expect(plan).toMatchObject({ kind: 'run', credits: 6, item: { kind: 'sound-analysis', credits: 6, seconds: 30 } });
    expect((await planAnalysis(rt, sound(60)) as { credits: number }).credits).toBe(7);
    expect(platform.paths()).toEqual(['POST /sound-analyses/quote', 'POST /sound-analyses/quote']);
    expect(platform.puts).toHaveLength(0);
  });

  it('uploads the WAV, runs within the wallet and returns the result; the same sound again is read back for nothing', async () => {
    const { rt, platform } = setup({ soundAnalysis: RESULT });
    const wallet = new Wallet(10);
    const record = await runAnalysis(rt, sound(), wallet);
    expect(record).toMatchObject({ status: 'done', id: 'sa-1', chargedCredits: 6 });
    expect(record.result?.music).toMatchObject({ present: true, genre: 'lo-fi', bpm: 80, vocals: 'none' });
    expect(wallet.spent).toBe(6);
    expect(platform.puts[0]).toMatchObject({ contentType: 'audio/wav', authorization: null });
    expect(platform.sent.find((s) => s.path.endsWith('/run'))?.body).toEqual({ maxCredits: 10 });
    const again = await runAnalysis(rt, sound(), new Wallet(0));
    expect(again).toMatchObject({ status: 'done', chargedCredits: 0 });
    expect(platform.account.charged).toBe(6);
  });

  it('keeps the reading of a sound.json that is there for the same sound', async () => {
    const { rt, platform } = setup({ soundAnalysis: RESULT });
    const s = sound();
    const before = soundFileOf({ hasAudio: true, audioSha256: s.sha256, analysis: await runAnalysis(rt, s, new Wallet(10)) });
    const sent = platform.sent.length;
    expect(await planAnalysis(rt, s, { before: JSON.parse(JSON.stringify(before)) })).toMatchObject({ kind: 'kept', record: { status: 'done', chargedCredits: 0 } });
    expect(platform.sent).toHaveLength(sent);
    // Another sound is another reading.
    expect((await planAnalysis(rt, sound(12), { before })).kind).toBe('run');
  });

  it('says why nobody listened: skipped, no account, an older server, a sound too long, silence', async () => {
    const { rt } = setup({ soundAnalysis: RESULT });
    expect(await planAnalysis(rt, sound(), { skip: true })).toEqual({ kind: 'none', record: { status: 'skipped' } });
    expect(await planAnalysis(rt, undefined)).toEqual({ kind: 'none', record: { status: 'silent' } });
    expect((await planAnalysis(rt, { ...sound(1), seconds: 700 })).kind === 'none').toBe(true);
    expect(await planAnalysis(createTestRuntime({ env: {} }), sound())).toEqual({ kind: 'none', record: { status: 'no-account' } });
    const old = setup({ soundAnalysis: 'missing' });
    expect(await planAnalysis(old.rt, sound())).toEqual({ kind: 'none', record: { status: 'unavailable' } });
    expect(await runAnalysis(old.rt, sound(), new Wallet(10))).toEqual({ status: 'unavailable' });
  });

  it('records a failed job and a wallet that does not cover the price as a failure, charging nothing', async () => {
    const failing = setup({ soundAnalysis: 'fails' });
    expect(await runAnalysis(failing.rt, sound(), new Wallet(10))).toMatchObject({ status: 'failed', chargedCredits: 0 });
    expect(failing.platform.account.charged).toBe(0);
    const { rt, platform } = setup({ soundAnalysis: RESULT });
    const short = await runAnalysis(rt, sound(), new Wallet(3));
    expect(short.status).toBe('failed');
    expect(short.why).toContain('costs 6 credits');
    expect(platform.puts).toHaveLength(0);
    expect(platform.account.charged).toBe(0);
  });
});
