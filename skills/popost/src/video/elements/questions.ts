/**
 * What `popost video elements questions` prints: the fixed instructions for the model that reads the frames (the part
 * of references/video-elements.md from "For the reader" on, read from the Skill, so that the page and the command
 * never say different things), then this video's own part: the pictures in the order to open them and every measured
 * shot with its time and the change into it as the measurement labelled it. Any harness can send the text and the
 * pictures to a model and write what it answers to elements.json.
 */
import type { Runtime } from '../../runtime';
import { fitsPoorly, joinedShots, OPENING_FILE, shotSheetFile, transitionFile } from '../describe/frames';
import { shownIn } from '../describe/kind';
import type { TextTrack } from '../text/types';
import type { Measure } from '../types';
import { measuredLabel } from './check';
import { ELEMENTS_FILE } from './types';

/** The page that holds the instructions, in the Skill, and the heading they start at. */
export const GUIDE_FILE = 'references/video-elements.md';
export const GUIDE_HEADING = '## For the reader';

/** The instructions for the reader, or undefined when the Skill's page is not there. */
export const readerGuide = async (rt: Runtime): Promise<string | undefined> => {
  const text = await rt.fs.readText(rt.path.join(rt.skillRoot, GUIDE_FILE)).catch(() => undefined);
  const at = text?.indexOf(GUIDE_HEADING) ?? -1;
  return text === undefined || at < 0 ? undefined : text.slice(at).trim() + '\n';
};

export interface QuestionShot {
  shot: number;
  time: [number, number];
  /** The shot's sheet, and the sheet of the change into it when it is not a plain cut. */
  frames: string;
  transition?: string;
  /** The change into it as the measurement labelled it, and what the measurement doubted. */
  in: string;
}

const two = (n: number): number => Number(n.toFixed(2));
const quote = (t: string): string => '"' + t.replace(/"/g, "'") + '"';

/** Numbers as runs: 2-4, 7. */
const runs = (xs: readonly number[]): string =>
  xs.reduce<[number, number][]>((out, x) => {
    const last = out[out.length - 1];
    if (last && last[1] === x - 1) last[1] = x;
    else out.push([x, x]);
    return out;
  }, []).map(([a, b]) => (a === b ? String(a) : a + '-' + b)).join(', ');

/** The shots as the reader is to number them, with the measured change into each. */
export const questionShots = (m: Measure): QuestionShot[] => {
  const fps = m.source.fps, joined = joinedShots(m);
  return m.shots.map((s, k) => {
    const b = k > 0 ? m.boundaries[k - 1] : undefined;
    const transition = b && b.kind !== 'cut' ? transitionFile(k + 1) : undefined;
    const doubts = b && b.kind !== 'cut' ? [...(fitsPoorly(b) ? ['does not fit the frames well'] : []), ...(b.confidence < 0.4 ? ['unsure'] : [])] : [];
    const into = !b ? 'start' : b.kind === 'cut' ? 'a cut' : measuredLabel(b) + ' ' + Math.max(0, b.end - b.start - 1) + 'f' + (doubts.length ? ', ' + doubts.join(', ') : '');
    const part = joined.has(k) ? '; very short, on a flat ground with something moving: most likely part of the change into shot ' + (k + 2) : '';
    return { shot: k + 1, time: [two(s.start / fps), two(s.end / fps)], frames: shotSheetFile(k + 1), ...(transition ? { transition } : {}), in: into + part };
  });
};

/** What the text reader found that the reading must account for: watermarks and the shots with captions. */
const textPart = (m: Measure, text: TextTrack | undefined): string[] => {
  if (!text) return ['No text reader read this video: read the words off the pictures.'];
  const step = text.step;
  const shotsOf = (c: { start: number; end: number }): number[] => m.shots.filter((s) => shownIn(c, s, step)).map((s) => s.index + 1);
  const marks = text.cues.filter((c) => c.role === 'watermark').map((c) => 'a watermark ' + quote(c.text) + ' at [' + c.box.map((v) => Math.round(v * 1000) / 1000).join(', ') + '] in shots ' + runs(shotsOf(c)));
  const captioned = [...new Set(text.cues.filter((c) => c.role === 'caption').flatMap(shotsOf))].sort((a, b) => a - b);
  const found = [...marks, ...(captioned.length ? ['caption lines in shots ' + runs(captioned)] : [])];
  return found.length ? ['What the text reader found: ' + found.join('; ') + '.'] : ['The text reader found no captions and no watermark.'];
};

/**
 * This video's part of the questions: its size, the pictures in the order to open them (those of the list that
 * exist), the shots, and what the text reader found. exists: whether a picture was written.
 */
export const videoQuestions = (m: Measure, text: TextTrack | undefined, exists: (file: string) => boolean): { pictures: string[]; shots: QuestionShot[]; text: string } => {
  const shots = questionShots(m);
  const pictures = [OPENING_FILE, ...shots.flatMap((s) => [...(s.transition ? [s.transition] : []), s.frames])].filter(exists);
  const { width, height, duration } = m.source;
  const lines = [
    '## This video', '',
    width + 'x' + height + ', ' + duration.toFixed(2) + ' s, ' + shots.length + ' shot' + (shots.length === 1 ? '' : 's') + '. Open the pictures in this order: ' + pictures.join(', ') + '.', '',
    'The shots (copy "shot" and "time"; "in" is the change into each as the measurement labelled it, which the frames confirm or correct):', '',
    ...shots.map((s) => '- shot ' + s.shot + ', time [' + s.time.join(', ') + ']: ' + (s.shot === 1 ? 'opens the video' + s.in.slice('start'.length) : 'in ' + s.in) + (s.transition ? ' (' + s.transition + ')' : '') + '; frames ' + s.frames),
    '', ...textPart(m, text), '',
    'Write the whole file, ' + ELEMENTS_FILE + ', with one entry for each of the ' + shots.length + ' shots.',
  ];
  return { pictures, shots, text: lines.join('\n') + '\n' };
};
