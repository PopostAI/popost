/**
 * `popost video elements`: the reading of a reference's frames, shot by shot (src/video/elements). questions prints what
 * the model that reads the frames is to do (the instructions, the pictures in the order to open them, every shot with
 * its time); check holds elements.json to the measurement. Each prints one JSON document; a file with errors exits 2.
 */
import type { PositionalSpec } from '../../args';
import { printJson } from '../../core/util';
import type { Runtime } from '../../runtime';
import { checkElements } from '../elements/check';
import { captionHintProblems } from '../elements/caption-roles';
import { GUIDE_FILE, questionShots, readerGuide, videoQuestions } from '../elements/questions';
import { readElements } from '../elements/read';
import type { LabelCounts } from '../elements/status';
import { ELEMENTS_FILE, type Elements } from '../elements/types';
import { OPENING_FILE } from '../describe/frames';
import type { TextTrack } from '../text/types';
import type { Measure, Problem, Unrecovered } from '../types';
import { UNRECOVERED_FILE } from '../describe/unrecovered';
import { command, userPath, VideoCommandError, type Commands } from './shared';

const DIR: PositionalSpec = { name: 'describe-dir', help: 'what popost video describe wrote (measure.json and the pictures)' };

const optionalJson = <T>(rt: Runtime, file: string): Promise<T | undefined> => rt.fs.readText(file).then((t) => JSON.parse(t) as T, () => undefined);

const measureIn = async (rt: Runtime, dir: string): Promise<Measure> => {
  const m = await optionalJson<Measure>(rt, rt.path.join(dir, 'measure.json'));
  if (!m) throw new VideoCommandError('No measure.json in ' + dir + '. Run: popost video describe <video> --out ' + dir);
  return m;
};

/**
 * The reading in a describe directory, checked against its measurement: undefined when there is no elements.json;
 * otherwise the well-formed part with every problem. A file that is not JSON is a failure with what to do.
 */
export const readingIn = async (rt: Runtime, dir: string, m: Measure, text: TextTrack | undefined): Promise<{ elements: Elements; problems: Problem[]; summary: string[]; labels: LabelCounts } | undefined> => {
  const file = rt.path.join(dir, ELEMENTS_FILE);
  const raw = await rt.fs.readText(file).catch(() => undefined);
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new VideoCommandError(file + ' is not valid JSON (' + (e instanceof Error ? e.message : String(e)) + '). Correct it and run: popost video elements check ' + dir);
  }
  const read = readElements(parsed);
  const checked = checkElements(read, m, text);
  return { elements: read.elements, ...checked, problems: [...checked.problems, ...captionHintProblems(read.elements, m, text)] };
};

/**
 * The one list of what was not recovered of a described reference: what describe wrote into its directory
 * (unrecovered.json), then what the reader appended in elements.json. Empty when neither is there.
 */
export const unrecoveredIn = async (rt: Runtime, dir: string, elements?: Elements): Promise<Unrecovered[]> => {
  const reading = await optionalJson<{ unrecovered?: Unrecovered[] }>(rt, rt.path.join(dir, UNRECOVERED_FILE));
  const own = elements ?? (await optionalJson<unknown>(rt, rt.path.join(dir, ELEMENTS_FILE)).then((raw) => (raw === undefined ? undefined : readElements(raw).elements)));
  return [...(Array.isArray(reading?.unrecovered) ? reading.unrecovered : []), ...(own?.unrecovered ?? [])];
};

const questions = command(
  'what the model that reads the frames is to do: the instructions (references/video-elements.md from "For the reader" on), the pictures to open in order, and every shot to describe with its time and its measured change; prompt holds it all as one text, to send with pictures to any model',
  { positionals: [DIR] },
  async (args, rt) => {
    const typed = args.req('describe-dir');
    const dir = userPath(rt, typed);
    const m = await measureIn(rt, dir);
    const text = await optionalJson<TextTrack>(rt, rt.path.join(dir, 'text.json'));
    const guide = await readerGuide(rt);
    if (!guide) throw new VideoCommandError('The instructions for the reader are not in ' + rt.path.join(rt.skillRoot, GUIDE_FILE) + ': the Skill is incomplete. Install the popost package again.');
    const candidates = [OPENING_FILE, ...questionShots(m).flatMap((s) => [s.frames, ...(s.transition ? [s.transition] : [])])];
    const present = new Set<string>();
    for (const f of candidates) if ((await rt.fs.stat(rt.path.join(dir, f)))?.isFile) present.add(f);
    const q = videoQuestions(m, text, (f) => present.has(f));
    if (!q.pictures.length) throw new VideoCommandError('There are no pictures in ' + dir + ' (opening.jpg, shots/NN-frames.jpg, transitions/NN.jpg). Describe the video again with this version: popost video describe <video> --out ' + typed);
    printJson(rt, {
      ok: true, dir, write: rt.path.join(dir, ELEMENTS_FILE), pictures: q.pictures.map((f) => rt.path.join(dir, f)), shots: q.shots,
      prompt: guide + '\n' + q.text, next: 'write ' + rt.path.join(typed, ELEMENTS_FILE) + ', then: popost video elements check ' + typed,
    });
  },
);

const check = command(
  'elements.json against the measurement: a shot without an entry, a box outside the frame, a custom change with no description, a change the measurement doubts called standard without a reason, a watermark no platform layer covers, captions with no caption layer, a mark with no why, a last shot that is the platform\'s end card, a field labelled measured that contradicts the reading; summary has one line per shot, status counts the fields labelled measured, inferred and unknown',
  { positionals: [DIR] },
  async (args, rt) => {
    const typed = args.req('describe-dir');
    const dir = userPath(rt, typed);
    const m = await measureIn(rt, dir);
    const text = await optionalJson<TextTrack>(rt, rt.path.join(dir, 'text.json'));
    const r = await readingIn(rt, dir, m, text);
    if (!r) throw new VideoCommandError('There is no ' + ELEMENTS_FILE + ' in ' + dir + '. Open the pictures and write it: popost video elements questions ' + typed + ' says how.');
    const errors = r.problems.filter((p) => p.level === 'error').length;
    printJson(rt, {
      ok: errors === 0, file: rt.path.join(dir, ELEMENTS_FILE), shots: m.shots.length, errors, warnings: r.problems.length - errors, summary: r.summary,
      // How many fields say how they are known ("status"), and the shots that say it of none.
      status: { measured: r.labels.measured, inferred: r.labels.inferred, unknown: r.labels.unknown, ...(r.labels.unlabelledShots.length ? { unlabelledShots: r.labels.unlabelledShots } : {}) },
      // The reading's own list of what it did not recover, and what this file adds to it.
      notRecovered: { reading: (await unrecoveredIn(rt, dir, { shots: [] })).length, added: r.elements.unrecovered?.length ?? 0 },
      problems: r.problems,
      next: errors ? 'correct ' + ELEMENTS_FILE + ' and run this again' : 'answer every warning, then: popost video template save ' + typed + ' --out template --name <name>',
    });
    return errors ? 2 : 0;
  },
);

export const elementsCommands: Commands = { questions, check };
