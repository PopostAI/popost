/**
 * The measurements of a sound (sound/measure.ts) on PCM built here: a click track gives its tempo and its beats, the
 * onsets lie where the clicks are, silences and levels are read, and the picture's cuts are held against the grid.
 * Then the reading (sound/reading.ts): the facts and the default sound plan that follow from what was measured and
 * heard, and the kinds a listener's reading gives the phrases of the speech (describe/speech-kind.ts).
 */
import { describe, expect, it } from 'vitest';
import { speechOf, withHeardKinds, confirmSpeech, kindLine } from '../../src/video/describe/speech-kind';
import type { SoundAnalysisResult } from '../../src/video/hosted-api';
import { soundResultOf } from '../../src/video/hosted-api';
import { alignmentOf, ANALYSIS_RATE, beatsOf, levelCurve, measureSound, onsetEnvelope, onsetsOf, peakTime, rmsDb, silencesOf, tempoOf } from '../../src/video/sound/measure';
import { cutsFollowBeat, factsOf, soundFileOf, soundLines, soundSection } from '../../src/video/sound/reading';
import type { Phrase } from '../../src/video/speech/types';

const RATE = ANALYSIS_RATE;

/** A short decaying burst of a tone at each time: a click a drum machine would make. Deterministic. */
export const clicks = (times: readonly number[], seconds: number, o: { hz?: number; level?: number; decay?: number } = {}): Float32Array => {
  const pcm = new Float32Array(Math.round(seconds * RATE));
  for (const t of times) {
    const at = Math.round(t * RATE);
    for (let i = 0; i < 0.08 * RATE && at + i < pcm.length; i++) pcm[at + i] = (pcm[at + i] ?? 0) + (o.level ?? 0.8) * Math.exp(-i / ((o.decay ?? 0.012) * RATE)) * Math.sin((2 * Math.PI * (o.hz ?? 1000) * i) / RATE);
  }
  return pcm;
};
const every = (period: number, seconds: number, first = 0.25): number[] => Array.from({ length: Math.floor((seconds - first) / period) + 1 }, (_, k) => first + k * period);

describe('levels and silences', () => {
  it('reads the RMS level of a tone, and digital silence as the floor', () => {
    const tone = Float32Array.from({ length: RATE }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / RATE));
    expect(rmsDb(tone)).toBeCloseTo(-9.03, 1);
    expect(rmsDb(new Float32Array(100))).toBe(-90);
    const half = new Float32Array(2 * RATE);
    half.set(tone, RATE);
    expect(levelCurve(half, RATE)).toEqual([-90, -90, -9, -9]);
    // Read in 50 ms steps: the silence ends within one step of where the tone begins.
    const quiet = silencesOf(half, RATE);
    expect(quiet).toHaveLength(1);
    expect(quiet[0]?.[0]).toBe(0);
    expect(Math.abs((quiet[0]?.[1] ?? 0) - 1)).toBeLessThan(0.06);
  });

  it('does not call the gaps between clicks a tenth of a second apart silences', () => {
    expect(silencesOf(clicks(every(0.1, 2, 0), 2, { decay: 0.05 }), RATE)).toEqual([]);
  });
});

describe('onsets', () => {
  it('finds each click within 15 ms of where it is, and nothing in a held tone', () => {
    const at = [0.5, 1.13, 1.9, 2.42, 3.3];
    const found = onsetsOf(onsetEnvelope(clicks(at, 4)), RATE);
    expect(found).toHaveLength(at.length);
    found.forEach((o, i) => expect(Math.abs(o.t - (at[i] ?? 0))).toBeLessThan(0.015));
    const tone = Float32Array.from({ length: 3 * RATE }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / RATE));
    // The tone begins once (its first window) and then only holds.
    expect(onsetsOf(onsetEnvelope(tone), RATE).filter((o) => o.t > 0.2)).toEqual([]);
  });

  it('gives a quiet click a lower strength than a loud one', () => {
    const pcm = clicks([0.5, 2.5], 4);
    pcm.set(clicks([1.5], 4, { level: 0.02 }).subarray(Math.round(1.4 * RATE), Math.round(1.7 * RATE)), Math.round(1.4 * RATE));
    const [loud, quiet] = onsetsOf(onsetEnvelope(pcm), RATE);
    expect(loud?.strength).toBeGreaterThan(quiet?.strength ?? 1);
  });

  it('finds the hit of a one-shot sound: the loudest 5 ms', () => {
    const pcm = new Float32Array(RATE);
    for (let i = 0; i < RATE; i++) pcm[i] = 0.05 * Math.sin(i / 7) * Math.min(1, i / (0.3 * RATE));
    pcm.set(clicks([0], 0.1).subarray(0, Math.round(0.08 * RATE)), Math.round(0.42 * RATE));
    expect(Math.abs(peakTime(pcm, RATE) - 0.42)).toBeLessThan(0.006);
  });
});

describe('tempo and the beat grid', () => {
  it.each([[90], [120], [128], [150]])('reads %i beats a minute from a click track, with its first beat', (bpm) => {
    const period = 60 / bpm;
    const m = tempoOf(onsetEnvelope(clicks(every(period, 12), 12)), RATE);
    expect(m).toBeDefined();
    expect(Math.abs((m?.bpm ?? 0) - bpm)).toBeLessThan(1);
    expect(m?.confidence).toBeGreaterThan(0.6);
    // The first beat lies on a click (the grid's phase), whichever click that is.
    const off = (((m?.first ?? 0) - 0.25) % period + period) % period;
    // The phase is read in hops of 11.6 ms.
    expect(Math.min(off, period - off)).toBeLessThan(0.03);
    const beats = beatsOf(m ?? { period, first: 0 }, 12);
    expect(beats.length).toBeGreaterThan(12 / period - 2);
  });

  it('has little confidence in clicks at irregular times, and none in a sound without onsets', () => {
    const irregular = [0.31, 0.92, 1.18, 2.47, 2.71, 3.9, 4.02, 5.77, 6.3, 7.95, 8.11, 9.6, 10.2, 11.41];
    expect(tempoOf(onsetEnvelope(clicks(irregular, 12)), RATE)?.confidence ?? 0).toBeLessThan(0.3);
    expect(tempoOf(onsetEnvelope(new Float32Array(6 * RATE)), RATE)).toBeUndefined();
    expect(tempoOf(onsetEnvelope(clicks([0.5], 2)), RATE)).toBeUndefined();
  });

  it('says what share of the cuts lie on a beat, and what chance would give', () => {
    const beats = every(0.5, 12);
    const m = measureSound(clicks(beats, 12), RATE, { cuts: [beats[2], beats[6], beats[10], (beats[13] ?? 0) + 0.2].map((t) => t ?? 0), motion: [0.1] });
    expect(m.tempo?.bpm).toBeCloseTo(120, 0);
    expect(m.cuts).toMatchObject({ events: 4, onBeat: 0.75, byChance: 0.28, onOnset: 0.75 });
    expect(m.motion).toMatchObject({ events: 1, onBeat: 0, onOnset: 0 });
    expect(alignmentOf([1, 2], [], undefined)).toEqual({ events: 2, onOnset: 0 });
    // The same samples give the same JSON.
    expect(JSON.stringify(measureSound(clicks(beats, 12), RATE))).toBe(JSON.stringify({ ...m, cuts: undefined, motion: undefined }));
  });
});

const HEARD: SoundAnalysisResult = soundResultOf({
  music: { present: true, description: 'an upbeat electronic track', genre: 'electro pop', mood: 'bright, driving', tempo: 'fast', bpm: 124, instruments: ['synth bass', 'claps', 'plucks'], vocals: 'sung', energy: 'high', sections: [{ from: 0, to: 8, what: 'intro' }, { from: 8, to: 20, what: 'drop' }] },
  ambience: { present: false, description: '' },
  effects: [{ at: 7.9, what: 'a riser into the drop', kind: 'riser' }, { at: 2.1, what: 'a whoosh on the cut', kind: 'whoosh' }],
  speech: { present: true, kind: 'sung', languages: ['en'] }, summary: 'Music with a sung hook.',
}) as SoundAnalysisResult;

describe('the reading of a sound', () => {
  const measured = measureSound(clicks(every(60 / 124, 20), 20), RATE, { cuts: every(60 / 124, 20).filter((_t, i) => i % 4 === 0) });

  it('plans one music bed when a listener heard music, with its style, tempo, sections and effects', () => {
    const file = soundFileOf({ hasAudio: true, audioSha256: 'abc', measured, analysis: { status: 'done', id: 'sa-1', chargedCredits: 6, result: HEARD } });
    expect(file.facts).toMatchObject({ music: 'yes', style: 'electro pop; bright, driving; synth bass, claps, plucks', tempo: 'fast', bpm: 124, vocals: 'sung', ambience: 'no', sfx: 'yes' });
    // The effects come in time order whatever order the listener gave them in.
    expect(file.facts.effects.map((e) => e.kind)).toEqual(['whoosh', 'riser']);
    expect(file.facts.plan.music).toBe('bed');
    expect(cutsFollowBeat(file.facts.cutsOnBeat)).toBe(true);
    const lines = soundLines(file).join('\n');
    expect(lines).toContain('Music: yes: electro pop');
    expect(lines).toContain('Music sections: 0.0-8.0 s intro; 8.0-20.0 s drop');
    expect(lines).toContain('the edit follows the music');
    expect(lines).toContain('Every clip is asked for without music');
    expect(soundSection(file).join('\n')).toContain('- effect 2.10 whoosh: a whoosh on the cut');
  });

  it('plans no music when the listener heard none, and says so plainly', () => {
    const none = soundResultOf({ music: { present: false }, ambience: { present: true, description: 'a busy street' }, effects: [], speech: { present: true, kind: 'narration' } }) as SoundAnalysisResult;
    const file = soundFileOf({ hasAudio: true, measured, analysis: { status: 'done', result: none } });
    expect(file.facts).toMatchObject({ music: 'no', ambience: 'yes', ambienceWhat: 'a busy street', sfx: 'no' });
    expect(file.facts.bpm).toBeUndefined();
    expect(file.facts.plan.music).toBe('none');
    expect(soundLines(file)[0]).toBe('Music: none (a listener heard none)');
  });

  it('says what it does not know when nobody listened: a steady pulse is only "likely" music and nothing is planned', () => {
    const file = soundFileOf({ hasAudio: true, measured, analysis: { status: 'no-account' } });
    expect(file.facts).toMatchObject({ music: 'likely', ambience: 'unknown', sfx: 'unknown', effects: [] });
    expect(file.facts.plan.music).toBe('ask');
    expect(file.facts.plan.says[0]).toContain('no popost.ai account is connected');
    const unsure = soundFileOf({ hasAudio: true, measured: measureSound(clicks([0.4, 1.9, 2.2, 5.1], 8), RATE), analysis: { status: 'unavailable' } });
    expect(unsure.facts.music).toBe('unknown');
    expect(soundLines(unsure)[0]).toContain('does not offer the sound analysis');
  });

  it('reads a silent video as no music, no ambience and no effects', () => {
    expect(factsOf({ hasAudio: false, analysis: { status: 'silent' } })).toMatchObject({ music: 'no', ambience: 'no', sfx: 'no', plan: { music: 'none' } });
  });
});

describe('the kinds a listener gives the phrases', () => {
  const phrase = (start: number, text: string): Phrase => ({ start, end: start + 20, text, confidence: 0.9, words: text.split(' ').map((w, i) => ({ text: w, start: start + i * 5, end: start + i * 5 + 5, confidence: 0.9 })) });
  const hook = speechOf({ status: 'transcribed', fps: 30, duration: 30, transcript: { language: 'en', fps: 30, words: [phrase(30, 'oh yeah come on'), phrase(300, 'feel the night')].flatMap((p) => p.words) } as never, phrases: [phrase(30, 'oh yeah come on'), phrase(300, 'feel the night tonight baby')] });

  it('defaults short, sparse phrases to sung when the music has sung vocals, and says where the kind came from', () => {
    expect(hook.confirmed).toBe(false);
    const sung = withHeardKinds(hook, { music: true, vocals: 'sung' });
    expect(sung).toMatchObject({ confirmed: true, from: 'sound-analysis', kinds: ['sung'] });
    expect(kindLine(sung)).toContain('A default from the sound analysis');
    expect(withHeardKinds(hook, { music: true, vocals: 'spoken-sample' }).kinds).toEqual(['fragments']);
    expect(withHeardKinds(hook, { music: true, vocals: 'rap' }).kinds).toEqual(['sung']);
  });

  it('leaves the phrases open without vocals in the music, and a reader of the frames can still say otherwise', () => {
    expect(withHeardKinds(hook, { music: true, vocals: 'none' })).toBe(hook);
    expect(withHeardKinds(hook, { music: false, vocals: 'sung' })).toBe(hook);
    expect(withHeardKinds(hook, undefined)).toBe(hook);
    const corrected = confirmSpeech(withHeardKinds(hook, { music: true, vocals: 'sung' }), { narration: ['0-1'] }).file;
    expect(corrected).toMatchObject({ confirmed: true, kinds: ['narration'] });
    expect(corrected?.from).toBeUndefined();
  });

  it('does not take a narrated script for the song: long or dense phrases stay to be confirmed from the frames', () => {
    const script = [0, 1, 2, 3, 4, 5].map((k) => phrase(k * 140, 'this is a long sentence of a narration that explains the product in detail'));
    const narrated = speechOf({ status: 'transcribed', fps: 30, duration: 30, transcript: { language: 'en', fps: 30, words: script.flatMap((p) => p.words) } as never, phrases: script });
    expect(withHeardKinds(narrated, { music: true, vocals: 'sung' }).confirmed).toBe(false);
  });
});
