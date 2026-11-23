/**
 * What each shot of a reference shows, in one sentence, read from a few of its frames by a model that reads
 * pictures. The measurements say when a shot starts and how it moves; they do not say that it is a woman by a car
 * holding up a coat. Without this the notes were written by a person, and a plan for a selling video cannot be
 * written from structure alone.
 * Frames go to the model as small JPEGs inside the request; nothing is uploaded anywhere else.
 */
import type { Runtime } from '../../runtime';
import { error } from '../project/check-common';
import { lookTimes, pictureUrl } from '../scene/pictures';
import type { Problem } from '../types';
import { extractJson } from './ask';
import type { ContentPart, Model, ModelUsage } from './model';

export interface SeeOptions {
  video: string;
  /** The shots, in seconds of the video. */
  shots: { start: number; end: number }[];
  model: Model;
  /** Frames looked at in each shot (spread over it). Default 3. */
  framesPerShot?: number;
  /** The longer side of a frame in pixels. Default 384: enough to say what is there, and small to send. */
  maxSide?: number;
  /** Shots in one request. Default 6. */
  batch?: number;
}

export interface SeeResult { notes: string[]; problems: Problem[]; usage: ModelUsage; requests: number }

/** The frames and pictures for a model live in scene/pictures.ts, shared with the scene writer. */
export { lookTimes, pictureUrl, pngUrl } from '../scene/pictures';

const ASK = (first: number, count: number): string => [
  'These are frames of ' + count + ' shot' + (count === 1 ? '' : 's') + ' of one video, in order. Each shot is introduced by a line "Shot N".',
  'For every shot say in one English sentence what it shows: who or what, doing what, where, and how the camera moves if it does.',
  'Describe the same person or place with the same words in every shot (hair, clothes, setting), so that a reader knows it is the same one. Do not copy text that is written on the picture.',
  'Answer with one JSON object and nothing else: {"shots": ["...", "..."]} with exactly ' + count + ' strings, for shots ' + first + ' to ' + (first + count - 1) + ' in order.',
].join('\n');

const askBatch = async (rt: Runtime, o: SeeOptions, first: number, shots: SeeOptions['shots']): Promise<{ notes?: string[]; usage: ModelUsage; requests: number; why?: string }> => {
  const per = o.framesPerShot ?? 3, side = o.maxSide ?? 384;
  const content: ContentPart[] = [{ type: 'text', text: ASK(first, shots.length) }];
  for (const [k, s] of shots.entries()) {
    content.push({ type: 'text', text: 'Shot ' + (first + k) + ' (' + (s.end - s.start).toFixed(1) + ' s):' });
    for (const t of lookTimes(s.start, s.end, per)) content.push({ type: 'image_url', image_url: { url: await pictureUrl(rt, o.video, side, t) } });
  }
  const usage = { input: 0, output: 0 };
  let why = '';
  // One more try when the count is wrong: the request is the same, the answer usually is not.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const reply = await o.model.ask([{ role: 'user', content }]);
    usage.input += reply.usage?.input ?? 0;
    usage.output += reply.usage?.output ?? 0;
    const value = extractJson(reply.text).value as { shots?: unknown } | undefined;
    const list = Array.isArray(value?.shots) ? value.shots.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
    // A model likes to repeat the label it was given ("Shot 3: ..."): the position already says it.
    if (list.length === shots.length) return { notes: list.map((x) => x.trim().replace(/\s+/g, ' ').replace(/^shot\s*\d+\s*[:.-]\s*/i, '')), usage, requests: attempt };
    why = 'the model gave ' + list.length + ' sentences for ' + shots.length + ' shots';
  }
  return { usage, requests: 2, why };
};

/** One sentence per shot. A batch the model could not answer leaves its shots without a note, and says so. */
export const seeShots = async (rt: Runtime, o: SeeOptions): Promise<SeeResult> => {
  const size = Math.max(1, o.batch ?? 6);
  const notes: string[] = [];
  const problems: Problem[] = [];
  const usage = { input: 0, output: 0 };
  let requests = 0;
  for (let first = 0; first < o.shots.length; first += size) {
    const part = o.shots.slice(first, first + size);
    const r = await askBatch(rt, o, first, part);
    usage.input += r.usage.input;
    usage.output += r.usage.output;
    requests += r.requests;
    if (r.notes) notes.push(...r.notes);
    else {
      notes.push(...part.map(() => ''));
      problems.push(error('shots[' + first + '-' + (first + part.length - 1) + ']', 'What these shots show could not be read: ' + r.why + '.', 'Run it again, or write their lines in the notes file by hand.'));
    }
  }
  return { notes, problems, usage, requests };
};
