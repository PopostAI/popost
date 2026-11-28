/**
 * `popost video speech-kind`: the kind of a reference's speech (describe/speech-kind.ts). show prints the phrases with
 * the picture of each (the frame at its middle) and what is to be decided; confirm records the kind per range of
 * phrases in speech.json and writes REFERENCE.md and timeline.md again, whose beats follow the kinds. Each prints one
 * JSON document; a confirmation with problems exits 2 and changes nothing.
 */
import type { OptionSpec, PositionalSpec } from '../../args';
import { printJson } from '../../core/util';
import type { Runtime } from '../../runtime';
import { OPENING_FILE } from '../describe/frames';
import { describeReference } from '../describe/index';
import { INSET_FILE, type Inset } from '../describe/inset';
import { confirmSpeech, isSpeechFile, KIND_MEANS, kindLine, PHRASE_KINDS, SPEECH_FILE, type PhraseKind, type SpeechFile } from '../describe/speech-kind';
import type { Transcript } from '../speech/types';
import type { TextTrack } from '../text/types';
import type { Measure } from '../types';
import { command, userPath, VideoCommandError, type Commands } from './shared';

const DIR: PositionalSpec = { name: 'describe-dir', help: 'what popost video describe wrote (speech.json and the pictures)' };

const optionalJson = <T>(rt: Runtime, file: string): Promise<T | undefined> => rt.fs.readText(file).then((t) => JSON.parse(t) as T, () => undefined);

/** The record in a describe directory, or undefined when describe wrote none (an older describe). */
export const speechIn = async (rt: Runtime, dir: string): Promise<SpeechFile | undefined> => {
  const raw = await optionalJson<unknown>(rt, rt.path.join(dir, SPEECH_FILE));
  return isSpeechFile(raw) ? raw : undefined;
};

const required = async (rt: Runtime, dir: string, typed: string): Promise<SpeechFile> => {
  const speech = await speechIn(rt, dir);
  if (!speech) throw new VideoCommandError('No ' + SPEECH_FILE + ' in ' + dir + '. Describe the video with this version: popost video describe <video> --out ' + typed);
  return speech;
};

const QUESTION =
  'For each phrase, open its picture and find the frame with its time: is a person visible who is saying these words (a talking head, an interview, a presenter in a window: on-camera)? '
  + 'Are the words heard while nobody on screen says them (over a recording, a product, B-roll: narration)? Are they sung (the lyrics of the music: sung)? Or only a few exclamations with no script (fragments)? '
  + 'One frame does not show a mouth moving: hold it against the frames of the shot it lies in (shots/NN-frames.jpg) and, when unsure, look closer with popost video look <video> --at <seconds>.';

const show = command(
  'the phrases a reference says, each with its time and the picture that shows the frame at its middle, and what is to be decided about them: narration, on-camera, sung or fragments',
  { positionals: [DIR] },
  async (args, rt) => {
    const typed = args.req('describe-dir');
    const dir = userPath(rt, typed);
    const speech = await required(rt, dir, typed);
    const pictures = [...new Set(speech.phrases.flatMap((p) => (p.picture ? [p.picture.file] : [])))];
    printJson(rt, {
      ok: true, dir, status: speech.status, ...(speech.why ? { why: speech.why } : {}), confirmed: speech.confirmed, kinds: speech.confirmed ? speech.kinds : 'unconfirmed',
      seconds: speech.seconds, says: kindLine(speech).replace(/^- /, ''),
      phrases: speech.phrases.map((p) => ({
        phrase: p.index, time: [Number((p.start / speech.fps).toFixed(2)), Number((p.end / speech.fps).toFixed(2))], text: p.text, ...(p.kind ? { kind: p.kind } : {}),
        ...(p.picture ? { picture: rt.path.join(dir, p.picture.file), frameAt: p.picture.seconds } : {}),
      })),
      ...(pictures.length ? { pictures: pictures.map((f) => rt.path.join(dir, f)) } : {}),
      kindsMean: Object.fromEntries(PHRASE_KINDS.map((k) => [k, KIND_MEANS[k]])),
      ...(speech.confirmed ? {} : { question: QUESTION, next: 'popost video speech-kind confirm ' + typed + ' --on-camera 0-3 --narration 4-9 (every phrase one kind: --narration, --on-camera, --sung, --fragments; --all <kind> names them all)' }),
    });
  },
);

const RANGES = (kind: PhraseKind, what: string): OptionSpec => ({ flag: '--' + kind, kind: 'list', metavar: 'PHRASES', help: 'the phrases ' + what + ', as numbers or ranges: 0-3 5' });

/** REFERENCE.md, timeline.md and the shot files again, from what describe kept, with the kinds now known. */
const rewrite = async (rt: Runtime, dir: string, speech: SpeechFile): Promise<void> => {
  const m = await optionalJson<Measure>(rt, rt.path.join(dir, 'measure.json'));
  if (!m) return;
  const text = await optionalJson<TextTrack>(rt, rt.path.join(dir, 'text.json'));
  const transcript = await optionalJson<Transcript>(rt, rt.path.join(dir, 'transcript.json'));
  const inset = await optionalJson<Inset>(rt, rt.path.join(dir, INSET_FILE));
  const card = await rt.fs.readText(rt.path.join(dir, 'REFERENCE.md')).catch(() => '');
  const name = /^# Reference: (.+)$/m.exec(card)?.[1] ?? 'reference';
  const pictures = (await rt.fs.stat(rt.path.join(dir, OPENING_FILE)))?.isFile === true;
  const d = describeReference(m, text, name, transcript, inset, { pictures, speech });
  for (const [file, content] of Object.entries(d.files)) await rt.fs.writeFile(rt.path.join(dir, file), content);
};

const confirm = command(
  'record the kind of every phrase of the reference\'s speech, as the frames show it: which are narration, which a visible person says (on-camera), which are sung, which are fragments. A video can be part one, part another. Writes speech.json, and REFERENCE.md and timeline.md again',
  {
    positionals: [DIR],
    options: [
      RANGES('narration', 'heard while nobody on screen says them'),
      RANGES('on-camera', 'a visible person says'),
      RANGES('sung', 'that are sung (the lyrics of the music)'),
      RANGES('fragments', 'that are single exclamations or words, no script'),
      { flag: '--all', choices: PHRASE_KINDS, metavar: 'KIND', help: 'every phrase has this kind: ' + PHRASE_KINDS.join(', ') },
    ],
  },
  async (args, rt) => {
    const typed = args.req('describe-dir');
    const dir = userPath(rt, typed);
    const speech = await required(rt, dir, typed);
    if (!speech.phrases.length) {
      printJson(rt, { ok: true, dir, confirmed: true, kinds: speech.kinds, note: 'There is no phrase to confirm: ' + kindLine(speech).replace(/^- /, '') + '.' });
      return 0;
    }
    const all = args.string('all') as PhraseKind | undefined;
    const given = Object.fromEntries(PHRASE_KINDS.map((k) => [k, [...args.list(k), ...(all === k ? ['0-' + (speech.phrases.length - 1)] : [])]])) as Record<PhraseKind, string[]>;
    // What a confirmation names replaces what the record had: the reader's eyes over the program's rule.
    const open: SpeechFile = { ...speech, phrases: speech.phrases.map(({ kind: _kind, ...p }) => p) };
    const r = confirmSpeech(PHRASE_KINDS.some((k) => given[k].length) ? open : speech, given);
    if (!r.file) {
      printJson(rt, { ok: false, error: 'The kinds were not recorded: ' + r.problems.length + ' problem(s).', problems: r.problems.map((p) => ({ level: 'error', ...p })) });
      return 2;
    }
    await rt.fs.writeFile(rt.path.join(dir, SPEECH_FILE), JSON.stringify(r.file, null, 2) + '\n');
    await rewrite(rt, dir, r.file);
    printJson(rt, {
      ok: true, dir, file: rt.path.join(dir, SPEECH_FILE), confirmed: true, kinds: r.file.kinds,
      phrases: Object.fromEntries(PHRASE_KINDS.flatMap((k) => { const n = r.file?.phrases.filter((p) => p.kind === k).length ?? 0; return n ? [[k, n]] : []; })),
      means: r.file.kinds.map((k) => k + ': ' + KIND_MEANS[k]),
      next: 'read ' + rt.path.join(typed, 'timeline.md') + ' again (its beats follow the kinds), then: popost video template save ' + typed + ' --out template --name <name>',
    });
    return 0;
  },
);

export const speechKindCommands: Commands = { show, confirm };
