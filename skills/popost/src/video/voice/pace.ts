/**
 * How fast a voice speaks: characters a second, found by having it speak one sentence and measuring the clip. With
 * it a line can be given a budget before anything is spoken: a beat of 2 s holds 9 characters of a voice that says
 * 4.6 a second. Six automatic videos ran 24% to 76% longer than their references because the model that wrote the
 * lines did not know this number.
 * Characters are counted as the engine counts them everywhere (spokenChars: no spaces, no punctuation), so a pace
 * is per script: full-width characters for Chinese, Japanese and Korean, letters and digits otherwise.
 */
import type { Runtime } from '../../runtime';
import { withTempDir } from '../host';
import { spokenChars } from '../retarget/pace';
import { speakLines, type Speaker } from './index';

export type Script = 'cjk' | 'latin';

/**
 * What a voice is timed on: four short lines, each spoken on its own, as the lines of a video are. One long sentence
 * was tried first: its commas are pauses a short line does not have, the pace came out low (3.8 for a voice whose
 * lines run at about 4.3), and seven videos made on those budgets were 9% to 16% shorter than their references.
 */
export const PACE_SAMPLE: Record<Script, string[]> = {
  cjk: ['今天给大家介绍一个小工具', '三分钟就能学会', '每天帮你省下不少时间', '赶紧来看看吧'],
  latin: ['Today I want to show you a small tool', 'It takes three minutes to learn', 'You will use it every day', 'Come and take a look'],
};

export interface PaceOptions {
  speaker: Speaker;
  voice?: string;
  speed?: number;
  script: Script;
  /** The lines to time the voice on. Default: PACE_SAMPLE of the script (give lines in the language the video will be in). */
  sample?: string[];
  /** Where measured paces are kept, so that a voice is timed once. */
  cacheFile?: string;
}

const keyOf = (o: PaceOptions): string => [o.voice ?? '', o.speed ?? 1, o.script, (o.sample ?? PACE_SAMPLE[o.script]).join('/')].join('|');
const readCache = (rt: Runtime, file: string | undefined): Promise<Record<string, number>> =>
  file ? rt.fs.readText(file).then((t) => JSON.parse(t) as Record<string, number>, () => ({})) : Promise.resolve({});

/** Characters a second of this voice at this speed (one decimal). Speaks the sample lines once unless the pace is in the cache. */
export const measureVoicePace = async (rt: Runtime, o: PaceOptions): Promise<number> => {
  const cache = await readCache(rt, o.cacheFile);
  const known = cache[keyOf(o)];
  if (typeof known === 'number' && known > 0) return known;
  const sample = o.sample ?? PACE_SAMPLE[o.script];
  return withTempDir(rt, 'popost-video-pace-', async (dir) => {
    // 100 frames a second: the clip's length to a hundredth of a second.
    const lines = await speakLines(rt, { lines: sample, dir, speaker: o.speaker, fps: 100, ...(o.voice ? { voice: o.voice } : {}), ...(o.speed ? { speed: o.speed } : {}) });
    const seconds = lines.reduce((n, l) => n + l.frames, 0) / 100;
    if (!(seconds > 0)) throw new Error('The voice gave no sound for the sample lines, so its pace is unknown.');
    const pace = Math.round((sample.reduce((n, l) => n + spokenChars(l).length, 0) / seconds) * 10) / 10;
    if (o.cacheFile) await rt.fs.writeFile(o.cacheFile, JSON.stringify({ ...cache, [keyOf(o)]: pace }, null, 1) + '\n');
    return pace;
  });
};

/** The most characters a line may have in each beat: what the voice says in that time, never under 2. */
export const lineBudgets = (seconds: number[], pace: number): number[] => seconds.map((s) => Math.max(2, Math.floor(pace * s)));

/** A line may be this much over its budget before it is refused: a voice does not keep one pace to the character. */
export const BUDGET_SLACK = 1.1;

const FULL_WIDTH = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export const scriptOfLanguage = (language: string | undefined, text: string): Script => {
  if (language && /chinese|中文|汉语|mandarin|cantonese|japanese|日本|korean|한국/i.test(language)) return 'cjk';
  if (language) return 'latin';
  const chars = spokenChars(text);
  return chars.filter((c) => FULL_WIDTH.test(c)).length * 2 >= chars.length ? 'cjk' : 'latin';
};
