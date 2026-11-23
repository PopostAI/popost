/**
 * A shot a model fills with words instead of a file: { "generate": "what the clip shows" }. Before anything is
 * checked or built, such a shot becomes a footage fill on a file that does not exist yet, plus a request to make
 * that file (src/generate). The program decides what a model cannot: how long the clip is (what the shot needs,
 * within what the generator makes) and how fast it plays when the shot is longer than the clip.
 */
import type { MaterialRequest } from '../generate/index';
import { error } from '../project/check-common';
import type { TemplatePackage } from '../template/types';
import type { Problem } from '../types';

export interface GenerateOptions {
  /** The shortest and the longest clip the generator makes, in whole seconds. */
  minSeconds: number;
  maxSeconds: number;
  /** Where the clips go, without the number and the extension. Default "assets/gen". */
  prefix?: string;
  /** Reference pictures sent with every request (the product), as paths in the project. The prompt calls them @image1, @image2 ... */
  images?: string[];
}

/** The slowest a clip may play to cover its shot. */
export const SLOWEST = 0.5;

export interface SplitResult {
  /** The answer with every "generate" shot replaced by a footage fill. */
  fill: unknown;
  requests: MaterialRequest[];
  /** The shots that were replaced. */
  shots: number[];
  problems: Problem[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const two = (n: number): string => String(n).padStart(2, '0');

export const splitGenerated = (answer: unknown, pkg: TemplatePackage, o: GenerateOptions): SplitResult => {
  if (!isObject(answer) || !Array.isArray(answer.shots)) return { fill: answer, requests: [], shots: [], problems: [] };
  const { width, height } = pkg.template.canvas;
  const aspect = width >= height ? '16:9' as const : '9:16' as const;
  const requests: MaterialRequest[] = [];
  const shots: number[] = [];
  const problems: Problem[] = [];
  const filled = answer.shots.map((s: unknown, k: number): unknown => {
    if (!isObject(s) || !('generate' in s)) return s;
    const at = 'shots[' + k + '].generate';
    const slot = pkg.slots.shots[k];
    const { generate: prompt, ...rest } = s;
    if (typeof prompt !== 'string' || !prompt.trim()) { problems.push(error(at, '"generate" is a sentence that says what the clip shows.', 'Write for example { "generate": "a woman holds the bottle up to the camera and smiles, bright kitchen, handheld" }.')); return s; }
    if (Object.keys(rest).some((key) => ['footage', 'picture', 'color', 'card', 'keep'].includes(key))) { problems.push(error('shots[' + k + ']', 'A shot is filled by exactly one thing; this one has "generate" and another.', 'Keep "generate" alone, or remove it.')); return s; }
    if (!slot) return s;
    const need = slot.footage.seconds;
    const seconds = Math.min(o.maxSeconds, Math.max(o.minSeconds, Math.ceil(need)));
    const speed = need <= seconds ? 1 : Math.floor((seconds / need) * 100) / 100;
    if (speed < SLOWEST) {
      problems.push(error(at, 'Shot ' + (k + 1) + ' lasts ' + need + ' s and a generated clip is at most ' + o.maxSeconds + ' s: even at half speed it would run out.', 'Fill shot ' + (k + 1) + ' with a picture, a card or footage from the materials.'));
      return s;
    }
    const file = (o.prefix ?? 'assets/gen') + '-' + two(k + 1) + '.mp4';
    requests.push({ file, prompt: prompt.trim(), seconds, aspect, ...(o.images?.length ? { images: o.images } : {}) });
    shots.push(k);
    return { footage: file, in: 0, ...(speed < 1 ? { speed } : {}), ...rest };
  });
  return { fill: { ...answer, shots: filled }, requests, shots, problems };
};
