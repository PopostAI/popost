/**
 * `popost video` commands that turn a video into facts (measure, text, transcript, describe, compare) and the two that
 * need nothing but files and ffmpeg (draft, synth). Each prints one JSON document and writes the files the development
 * command line wrote. A long listing (every shot, every cue) goes to the file a command writes: stdout then carries
 * the counts and the path, and carries the listing itself only when no output file was asked for.
 */
import type { OptionSpec, ParsedArgs, PositionalSpec } from '../../args';
import { isFile, printJson, readJson } from '../../core/util';
import type { Runtime } from '../../runtime';
import { fitsPoorly, joinedShots, transitionFile } from '../describe/frames';
import { shotCurves } from '../describe/curves';
import { describeReference } from '../describe/index';
import { INSET_FILE, insetPlan, insetText } from '../describe/inset';
import { TRACKS_FILE, tracksFile } from '../describe/paths';
import { knownOf } from '../describe/known';
import { UNRECOVERED_FILE, unrecoveredFile } from '../describe/unrecovered';
import { isSpeechFile, keepConfirmed, middleOf, PHRASES_A_SHEET, phraseSheetFile, SPEECH_FILE, speechOf, withHeardKinds, withPictures, type SpeechFile, type SpeechStatus } from '../describe/speech-kind';
import { heardSound, measureFile, planAnalysis, runAnalysis, type AnalysisPlan, type HeardSound } from '../sound/analysis';
import { musicLine, SOUND_FILE, soundFileOf, type SoundAnalysisRecord, type SoundFile } from '../sound/reading';
import { ToolError } from '../tool';
import { writeSheets } from '../look/sheets';
import { probe } from '../media/ffmpeg';
import { readReference } from '../describe/parts';
import { buildDraft } from '../draft/build';
import { measureVideo } from '../measure/index';
import { stillProblems } from '../measure/still-shots';
import { scoreMeasures } from '../score/index';
import { compareShots, LESS_MOTION, momentsOf, MORE_MOTION, shotTimeMap, type MotionComparison, type ShotDifference } from '../score/shots';
import { compareTracks, type TrackDifference } from '../score/tracks';
import { projectOf, reviewCompare, roundNext } from '../render/record';
import { changeWindows } from '../score/project-windows';
import { readFacts } from '../template/facts';
import { comparisonScope } from './compare-scope';
import { quoteVideoSpeech, transcriptionPrice } from '../speech/hosted';
import { commandTranscriber, NO_TRANSCRIBER, phrasesOf, transcribe, TRANSCRIBER_HINT, transcriberKind } from '../speech/index';
import { Wallet, type PriceItem } from '../wallet';
import { CREDIT_OPTIONS, walletFor } from './credits';
import { synthCase } from '../synth/generate';
import { writeCase } from '../synth/write';
import { commandTextReader, cuesOf, readSamples, withCaptionLook, type TextReading, type TextTrack } from '../text/index';
import { rolesWithSpeech } from '../text/speech';
import type { Boundary, Measure, ShotMeasure, Unrecovered } from '../types';
import { unrecoveredIn } from './elements';
import { measureCommands } from './measure';
import { command, PROJECT_OPTION, userPath, VideoCommandError, videoTitle, type Commands } from './shared';

const VIDEO: PositionalSpec = { name: 'video', help: 'a video file ffmpeg can read' };
const LANGUAGE: OptionSpec = { flag: '--language', help: 'what the speech is in, such as zh or en (default: the transcriber detects it)' };
const outFile = (name: string): OptionSpec => ({ flag: '--out', metavar: 'FILE', help: 'write the whole result to this file (' + name + ') and print only counts' });
const outDir = (what: string): OptionSpec => ({ flag: '--out', metavar: 'DIR', required: true, help: what });

/** How often describe writes a progress line on stderr. */
const PROGRESS_MS = 15_000;

/** Where to get a text reader or a transcriber; skills/popost/tools/video/ has the development loop's. */
const OCR_HINT = 'set POPOST_OCR_CMD (skills/popost/tools/video/ocr-rapidocr/ocr.py explains one way)';
const ASR_HINT = TRANSCRIBER_HINT;
const NO_SPEECH: OptionSpec = { flag: '--no-speech', kind: 'flag', help: 'do not transcribe what is said (nothing is charged for it)' };

/**
 * The transcriber of a command that hears `video`, and its wallet: popost.ai's is priced first and paid only with
 * --confirm --max-credits N (exit code 3 with the price without them); the user's own costs nothing here.
 */
const hearing = async (rt: Runtime, args: ParsedArgs, video: string, what: string) => {
  if (transcriberKind(rt) !== 'hosted') return { transcriber: commandTranscriber(rt), wallet: undefined as Wallet | undefined };
  const wallet = await walletFor(rt, args, await transcriptionPrice(rt, video, what));
  return { transcriber: commandTranscriber(rt, wallet), wallet };
};

const NO_SOUND_ANALYSIS: OptionSpec = { flag: '--no-sound-analysis', kind: 'flag', help: 'do not have popost.ai listen to the sound (music, ambience, effects); the sound is still measured here, at no charge' };

/**
 * What describe pays popost.ai for, priced before anything is done: the transcription (unless the user's own
 * transcriber hears it) and the sound analysis. One price, one agreement (--confirm --max-credits N), one wallet.
 */
const describeHearing = async (rt: Runtime, args: ParsedArgs, video: string, o: { speech: boolean; sound: AnalysisPlan }) => {
  const hosted = o.speech && transcriberKind(rt) === 'hosted';
  const items: PriceItem[] = [...(hosted ? await transcriptionPrice(rt, video, 'the speech of the reference') : []), ...(o.sound.kind === 'run' ? [o.sound.item] : [])];
  const wallet = hosted || o.sound.kind === 'run' ? await walletFor(rt, args, items) : undefined;
  return { transcriber: o.speech ? commandTranscriber(rt, wallet) : undefined, wallet };
};

/** The reading of the reference's sound: measured here, and listened to when the plan says so (sound/analysis.ts). */
const readSound = async (rt: Runtime, video: string, m: Measure, heard: HeardSound | undefined, plan: AnalysisPlan, wallet: Wallet | undefined): Promise<SoundFile> => {
  if (!heard) return soundFileOf({ hasAudio: false, analysis: { status: 'silent' } });
  const fps = m.source.fps;
  const measured = await measureFile(rt, video, { cuts: m.boundaries.map((b) => b.frame / fps), motion: m.shots.flatMap((s) => s.events.map((e) => e.start / fps)) }).catch((e: unknown) => {
    if (e instanceof ToolError) throw e;
    return undefined;
  });
  const analysis: SoundAnalysisRecord = plan.kind === 'run' ? await runAnalysis(rt, heard, wallet ?? new Wallet(0)) : plan.record;
  return soundFileOf({ hasAudio: true, audioSha256: heard.sha256, ...(measured ? { measured } : {}), analysis });
};

/** A file the user named, against the working directory; a missing one is an error the user can fix. */
const inputFile = async (rt: Runtime, typed: string): Promise<string> => {
  const file = userPath(rt, typed);
  if (!(await isFile(rt, file))) throw new VideoCommandError('There is no file at ' + file + '. Check the path; a relative one is read from ' + rt.cwd + '.');
  return file;
};

/** The output file a command was given with --out, against the working directory. */
const optionalOut = (rt: Runtime, typed: string | undefined): string | undefined => (typed === undefined ? undefined : userPath(rt, typed));

/** JSON as the development command line wrote it: two-space indents and a final newline. */
const writeJsonFile = (rt: Runtime, file: string, value: unknown): Promise<void> => rt.fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');

/** Seconds since `started` (a Date.now()), to a tenth. */
const secondsSince = (started: number): number => Math.round((Date.now() - started) / 100) / 10;

/** A video, or the measure.json written for one. */
const loadMeasure = async (rt: Runtime, file: string): Promise<Measure> =>
  file.endsWith('.json') ? readJson<Measure>(rt, file) : measureVideo(rt, file);

/** One boundary of the listing: where, what, and for a transition its mixed frames and span. */
const boundaryEntry = (b: Boundary): Record<string, unknown> => ({
  frame: b.frame, kind: b.kind,
  ...(b.kind === 'cut' ? {} : { frames: b.end - b.start - 1, start: b.start, end: b.end, ...(b.direction ? { direction: b.direction } : {}), ...(b.mode ? { mode: b.mode } : {}), ...(b.via ? { via: b.via } : {}) }),
  confidence: b.confidence,
});

/** One shot of the listing: its frames, its camera (rates when it moves) and how many motion events it has. */
const shotEntry = (s: ShotMeasure): Record<string, unknown> => ({
  index: s.index, start: s.start, end: s.end, camera: s.camera.kind,
  ...(s.camera.kind === 'move' ? { zoomPerS: s.camera.zoomPerS, panPerS: s.camera.panPerS } : {}),
  events: s.events.length,
});

const measure = command(
  'cuts, transitions, camera, motion and colour of a video, measured by programs (measure curve <video> --from S --to S --roi x,y,w,h: the curve of one moving thing, with its closest easing)',
  { positionals: [VIDEO], options: [outFile('measure.json')] },
  async (args, rt) => {
    const video = await inputFile(rt, args.req('video'));
    const out = optionalOut(rt, args.string('out'));
    const m = await measureVideo(rt, video);
    if (out) await writeJsonFile(rt, out, m);
    printJson(rt, {
      ok: true, video, frames: m.source.frames, fps: m.source.fps, shots: m.shots.length, boundaries: m.boundaries.length,
      ...(out ? { file: out } : { listing: { boundaries: m.boundaries.map(boundaryEntry), shots: m.shots.map(shotEntry) } }),
    });
  },
);

const text = command(
  'on-screen text as cues with roles (caption, title, label, watermark, in-picture); needs POPOST_OCR_CMD',
  {
    positionals: [VIDEO],
    options: [
      outFile('text.json'),
      { flag: '--step', kind: 'int', help: 'frames between samples (default: about a fifth of a second)' },
      { flag: '--every', kind: 'int', help: 'above 1: whole frames every this many steps, caption strips between (default 1)' },
      { flag: '--samples', metavar: 'FILE', help: 'keep the raw lines in this file, and reuse them when it exists' },
    ],
  },
  async (args, rt) => {
    const started = Date.now();
    const kept = optionalOut(rt, args.string('samples'));
    // A samples file that cannot be read is read again from the video, as before.
    const saved = kept ? await rt.fs.readText(kept).then((t) => JSON.parse(t) as TextReading, () => undefined) : undefined;
    const step = args.number('step'), every = args.number('every');
    const readVideo = async (): Promise<TextReading> => {
      const reader = commandTextReader(rt);
      if (!reader) throw new VideoCommandError('Reading text needs a reader: ' + OCR_HINT + '.');
      return readSamples(rt, await inputFile(rt, args.req('video')), reader, { ...(step === undefined ? {} : { step }), ...(every === undefined ? {} : { every }) });
    };
    const reading = saved ?? (await readVideo());
    if (kept && !saved) await rt.fs.writeFile(kept, JSON.stringify(reading));
    const video = userPath(rt, args.req('video'));
    // What is behind the caption letters is read off the video's frames: only when the video is there.
    const track = (await isFile(rt, video)) ? await withCaptionLook(rt, video, cuesOf(reading)) : cuesOf(reading);
    const out = optionalOut(rt, args.string('out'));
    if (out) await writeJsonFile(rt, out, track);
    const roles: Record<string, number> = {};
    for (const c of track.cues) roles[c.role] = (roles[c.role] ?? 0) + 1;
    printJson(rt, {
      ok: true, video: userPath(rt, args.req('video')),
      samples: track.sampled, wholeFrames: reading.whole ?? track.sampled, captionStrips: reading.strips ?? 0, seconds: secondsSince(started),
      cues: track.cues.length, roles, ...(track.captionLook ? { captionLook: track.captionLook } : {}),
      ...(kept ? { samplesFile: kept, samplesReused: saved !== undefined } : {}),
      // The listing leaves out text that belongs to the footage, as the old one did; the file has every cue.
      ...(out ? { file: out } : { listing: { cues: track.cues.filter((c) => c.role !== 'in-picture').map((c) => ({ start: c.start, end: c.end, role: c.role, y: c.box[1], size: c.size, text: c.text })) } }),
    });
  },
);

const transcript = command(
  'what is said, word by word, in source frames. With a popost.ai account it is transcribed there, paid in credits: without --confirm it prints the price (exit code 3) and charges nothing; --quote only prices it. A transcriber of your own in POPOST_ASR_CMD goes first',
  {
    positionals: [VIDEO],
    options: [
      outFile('transcript.json'), LANGUAGE,
      { flag: '--quote', kind: 'flag', help: 'transcribe nothing: print the seconds of sound and the credits popost.ai charges to transcribe them (free; needs a connected account)' },
      ...CREDIT_OPTIONS, PROJECT_OPTION,
    ],
  },
  async (args, rt) => {
    if (args.flag('quote')) {
      const video = await inputFile(rt, args.req('video'));
      const q = await quoteVideoSpeech(rt, video);
      printJson(rt, {
        ok: true, video, ...q, chargedCredits: 0,
        ...(q.sound ? { next: 'show the user the credits; with their agreement transcribe with --confirm --max-credits ' + q.credits + ' (or more)' + (transcriberKind(rt) === 'own' ? '. POPOST_ASR_CMD is set, so your own transcriber is used instead, at no charge here' : '') } : { note: 'The video has no sound: nothing to transcribe.' }),
      });
      return;
    }
    const video = await inputFile(rt, args.req('video'));
    const { transcriber, wallet } = await hearing(rt, args, video, 'the sound of ' + rt.path.basename(video));
    if (!transcriber) throw new VideoCommandError('Transcribing needs a transcriber (' + NO_TRANSCRIBER + '): ' + ASR_HINT + '.');
    const started = Date.now();
    const t = await transcribe(rt, video, transcriber, args.string('language'));
    if (!t) {
      printJson(rt, { ok: true, video, sound: false, words: 0, chargedCredits: 0, note: 'The video has no sound.' });
      return;
    }
    const out = optionalOut(rt, args.string('out'));
    if (out) await writeJsonFile(rt, out, t);
    const phrases = phrasesOf(t);
    printJson(rt, {
      ok: true, video, sound: true, words: t.words.length, language: t.language, seconds: secondsSince(started), phrases: phrases.length, chargedCredits: wallet?.spent ?? 0,
      ...(out ? { file: out } : { listing: { phrases: phrases.map((p) => ({ start: p.start, end: p.end, confidence: p.confidence, text: p.text })) } }),
    });
  },
  (args) => args.string('project'),
  videoTitle,
);

/** Pictures an earlier describe wrote into the same directory, which this one's may not replace (a shot or a transition fewer). */
const removeOldPictures = async (rt: Runtime, dir: string): Promise<void> => {
  await rt.fs.rm(rt.path.join(dir, 'transitions'));
  const shots = rt.path.join(dir, 'shots');
  const names = (await rt.fs.stat(shots))?.isDirectory ? await rt.fs.readdir(shots) : [];
  for (const name of names.filter((n) => n.endsWith('-frames.jpg'))) await rt.fs.rm(rt.path.join(shots, name));
};

/**
 * The pictures of the phrases whose kind waits for the frames: one frame per phrase, at its middle, with its time
 * under it, up to PHRASES_A_SHEET on a sheet. One more pass over the video at the size of the other pictures.
 */
const phrasePictures = async (rt: Runtime, video: string, dir: string, speech: SpeechFile): Promise<SpeechFile> => {
  await rt.fs.rm(rt.path.join(dir, 'speech'));
  if (speech.confirmed || !speech.phrases.length) return speech;
  const sheets = Array.from({ length: Math.ceil(speech.phrases.length / PHRASES_A_SHEET) }, (_, k) => ({ file: phraseSheetFile(k + 1), frames: speech.phrases.slice(k * PHRASES_A_SHEET, (k + 1) * PHRASES_A_SHEET).map(middleOf) }));
  const p = await probe(rt, video);
  await writeSheets(rt, video, sheets, { width: insetPlan(p).width, outDir: dir, probe: p });
  return withPictures(speech);
};

const describe = command(
  'the layered description of a reference for a model: REFERENCE.md, timeline.md, shots/NN.md, the pictures to open (opening.jpg, shots/NN-frames.jpg, transitions/NN.jpg: consecutive frames with their times) and the data under them',
  {
    positionals: [VIDEO],
    options: [
      outDir('the directory to write into'),
      { flag: '--name', default: 'reference', help: 'what REFERENCE.md calls the video (not a file name of a private data set)' },
      LANGUAGE, NO_SPEECH, NO_SOUND_ANALYSIS, ...CREDIT_OPTIONS, PROJECT_OPTION,
    ],
  },
  async (args, rt) => {
    const video = await inputFile(rt, args.req('video'));
    const dir = userPath(rt, args.req('out'));
    const reader = commandTextReader(rt);
    const skipped = args.flag('no-speech');
    // The sound as a listener hears it, and what the listener will do for it (kept from an earlier describe, run, or not at all).
    const heard = (await probe(rt, video)).hasAudio ? await heardSound(rt, video) : undefined;
    const soundBefore = await rt.fs.readText(rt.path.join(dir, SOUND_FILE)).then((t) => JSON.parse(t) as unknown, () => undefined);
    const soundPlan = await planAnalysis(rt, heard, { skip: args.flag('no-sound-analysis'), before: soundBefore });
    // With popost.ai the speech and the sound analysis are priced before anything else is done: without --confirm the price is all there is.
    const { transcriber, wallet } = await describeHearing(rt, args, video, { speech: !skipped, sound: soundPlan });
    const language = args.string('language');
    await removeOldPictures(rt, dir);
    // Minutes with a reader and a transcriber: a line on stderr every 15 s says which part is where.
    const got = await readReference(rt, video, {
      ...(reader ? { reader } : {}), ...(transcriber ? { transcriber } : {}), ...(language ? { language } : {}),
      progress: { write: (line) => rt.stderr(line + '\n'), everyMs: PROGRESS_MS }, pictures: { dir },
    });
    // The curve of the main moving element of the shots that move throughout, for their scenes (describe/curves.ts).
    const curves = await shotCurves(rt, video, got.measure).catch(() => []);
    const m: Measure = curves.length ? { ...got.measure, curves } : got.measure;
    const read = got.text, spoken = got.transcript, inset = got.inset;
    // text.json keeps the roles the speech gives (and why each cue has its role).
    const cues = read ? rolesWithSpeech(read, spoken) : undefined;
    // Why there is, or is not, a transcript: a failed transcription is not a skipped one, and neither is a missing tool.
    const status: SpeechStatus = !m.source.hasAudio ? 'silent' : spoken ? 'transcribed' : got.speechFailed !== undefined ? 'failed' : skipped ? 'skipped' : 'no-tool';
    const boundaries = m.boundaries.map((b) => b.frame);
    const before = await rt.fs.readText(rt.path.join(dir, SPEECH_FILE)).then((t) => JSON.parse(t) as unknown, () => undefined);
    const sound = await readSound(rt, video, m, heard, soundPlan, wallet);
    const listened = sound.analysis.status === 'done' ? sound.analysis.result : undefined;
    // Words inside the music (sung, a sampled voice) get their kind from the listener; a reader of the frames can still correct it.
    const speech = await phrasePictures(rt, video, dir, withHeardKinds(keepConfirmed(speechOf({
      status, ...(got.speechFailed !== undefined ? { why: got.speechFailed } : {}), ...(spoken ? { transcript: spoken, phrases: phrasesOf(spoken, { boundaries }) } : {}), fps: m.source.fps, duration: m.source.duration,
    }), isSpeechFile(before) ? before : undefined), listened ? { music: listened.music.present, vocals: listened.music.vocals, speech: listened.speech.kind } : undefined));
    const d = describeReference(m, cues, args.string('name') ?? 'reference', spoken, inset, { pictures: true, speech, sound });
    for (const [name, content] of Object.entries(d.files)) await rt.fs.writeFile(rt.path.join(dir, name), content);
    // measure.json says of each value how it is known (describe/known.ts), as the files a model reads do.
    await writeJsonFile(rt, rt.path.join(dir, 'measure.json'), { ...m, known: knownOf(m) });
    await writeJsonFile(rt, rt.path.join(dir, TRACKS_FILE), tracksFile(m));
    await writeJsonFile(rt, rt.path.join(dir, UNRECOVERED_FILE), unrecoveredFile(d.unrecovered));
    if (cues) await writeJsonFile(rt, rt.path.join(dir, 'text.json'), cues);
    if (spoken) await writeJsonFile(rt, rt.path.join(dir, 'transcript.json'), spoken);
    else await rt.fs.rm(rt.path.join(dir, 'transcript.json'));
    await writeJsonFile(rt, rt.path.join(dir, SPEECH_FILE), speech);
    await writeJsonFile(rt, rt.path.join(dir, SOUND_FILE), sound);
    // The frame around the content, for template save; a frame an earlier describe found must not outlive this one.
    if (inset) await writeJsonFile(rt, rt.path.join(dir, INSET_FILE), inset);
    else await rt.fs.rm(rt.path.join(dir, INSET_FILE));
    const leftOut = [
      ...(reader ? [] : [{ part: 'on-screen text', because: 'POPOST_OCR_CMD is not set', toAdd: OCR_HINT }]),
      ...(spoken || !m.source.hasAudio ? [] : [
        skipped ? { part: 'speech', because: '--no-speech was given' }
          : got.speechFailed !== undefined ? { part: 'speech', because: 'the transcription failed: ' + got.speechFailed, toAdd: 'run the same command again: a failed transcription starts a new one, and nothing was charged for the failed one' }
          : { part: 'speech', because: NO_TRANSCRIBER, toAdd: ASR_HINT },
      ]),
      ...(['done', 'silent'].includes(sound.analysis.status) ? [] : [{ part: 'sound analysis (what the music, ambience and effects are)', because: sound.analysis.status + (sound.analysis.why ? ': ' + sound.analysis.why : ''), ...(sound.analysis.status === 'no-account' ? { toAdd: 'popost auth login, then describe again' } : sound.analysis.status === 'failed' ? { toAdd: 'run the same command again: nothing was charged for a failed analysis' } : {}) }]),
    ];
    const typed = args.req('out');
    printJson(rt, {
      ok: true, dir,
      files: ['REFERENCE.md', 'timeline.md', 'measure.json', TRACKS_FILE, UNRECOVERED_FILE, SPEECH_FILE, SOUND_FILE, ...(cues ? ['text.json'] : []), ...(spoken ? ['transcript.json'] : []), ...(inset ? [INSET_FILE] : [])],
      shotFiles: m.shots.length, paths: m.tracks?.length ?? 0, notRecovered: d.unrecovered.length,
      tokens: { 'REFERENCE.md': d.tokens['REFERENCE.md'], 'timeline.md': d.tokens['timeline.md'] },
      sound: m.source.hasAudio, text: cues !== undefined, speech: spoken !== undefined, chargedCredits: wallet?.spent ?? 0,
      // What kind of speech it is decides whether the re-make has a voice-over (describe/speech-kind.ts).
      speechKind: speech.confirmed
        ? { status: speech.status, kinds: speech.kinds }
        : { status: speech.status, kinds: 'unconfirmed', phrases: speech.phrases.length, next: 'popost video speech-kind show ' + typed + ' lists the phrases with their pictures; confirm each kind with popost video speech-kind confirm ' + typed + ' before template save' },
      // What the sound is decides the re-make's sound (video-sound.md): music, ambience, effects, the default plan.
      soundReading: {
        analysis: sound.analysis.status, ...(sound.analysis.why ? { why: sound.analysis.why } : {}), music: musicLine(sound.facts, sound.analysis.status),
        ambience: sound.facts.ambience, ...(sound.facts.ambienceWhat ? { ambienceWhat: sound.facts.ambienceWhat } : {}), effects: sound.facts.effects,
        ...(sound.measured?.tempo ? { beatGrid: { bpm: sound.measured.tempo.bpm, confidence: sound.measured.tempo.confidence } } : {}), ...(sound.facts.cutsOnBeat ? { cutsOnBeat: sound.facts.cutsOnBeat } : {}),
        onsets: sound.measured?.onsets.length ?? 0, plan: sound.facts.plan,
      },
      ...(inset ? { inset: { ...inset, note: insetText(inset, m.shots.length) } } : {}),
      pictures: picturesEntry(rt, dir, m, got.pictures ?? []),
      ...(leftOut.length ? { leftOut } : {}),
    });
  },
  (args) => args.string('project'),
  videoTitle,
);

/** What describe says of its pictures: where they are, which labels do not fit them, and that they are to be opened. */
const picturesEntry = (rt: Runtime, dir: string, m: Measure, written: readonly { file: string }[]): Record<string, unknown> => {
  const relative = written.map((s) => rt.path.relative(dir, s.file));
  const transitions = relative.filter((f) => f.startsWith('transitions'));
  const poor = m.boundaries.flatMap((b, k) => (fitsPoorly(b) ? [transitionFile(k + 2)] : []));
  const joined = [...joinedShots(m)].map((k) => ({ shot: k + 1, with: transitionFile(k + 2) }));
  return {
    ...(relative.includes('opening.jpg') ? { opening: 'opening.jpg' } : {}),
    shots: relative.filter((f) => f.endsWith('-frames.jpg')).length, transitions,
    ...(poor.length ? { doNotFit: poor } : {}), ...(joined.length ? { partOfEffect: joined } : {}),
    note: 'Open opening.jpg, every shots/NN-frames.jpg and every transitions/NN.jpg before writing a plan: the labels are measurements and can be wrong; what the frames show wins.',
  };
};

/** The command that shows a shot of worst, the other video's frame (A) beside the reference's (B), at full width up to 1280. */
export const lookCommand = (typed: { reference: string; other: string }, m: Measure, d: ShotDifference): string | undefined =>
  typed.reference.endsWith('.json') || typed.other.endsWith('.json') ? undefined
    : 'popost video look ' + typed.other + ' --at ' + (d.change ? momentsOf(d.change.other).join(',') : d.at.other) + ' --against ' + typed.reference + ' --against-at ' + (d.change ? momentsOf(d.change.reference).join(',') : d.at.reference) + ' --width ' + Math.min(1280, m.source.width) + ' --out review/shot-' + String(d.shot).padStart(2, '0');

const list = (shots: readonly number[]): string => (shots.length === 1 ? 'Shot ' : 'Shots ') + shots.join(', ') + (shots.length === 1 ? ' moves' : ' move');

/** What the motion amounts say, and what to do about a shot that moves much less or much more than its reference shot. */
export const motionNote = (m: MotionComparison): string => [
  'The motion amount is how much the picture changes between frames 1/15 s apart (0 is a still); ratio is the other video\'s as a multiple of the reference\'s, for the whole video and in each shot\'s motionAmount.',
  ...(m.less.length ? [list(m.less) + ' less than ' + LESS_MOTION + ' times as much as the reference\'s: give the shot the motion its reference has (generate the clip again with the action and the pace of shots/NN.md in its prompt, raise its "speed", or animate the scene), and never slow a clip down to fill a shot.'] : []),
  ...(m.more.length ? [list(m.more) + ' more than ' + MORE_MOTION + ' times as much as the reference\'s: calm the shot (a steadier clip, a still where the reference holds one).'] : []),
  ...(!m.less.length && !m.more.length ? ['No shot moves less than ' + LESS_MOTION + ' or more than ' + MORE_MOTION + ' times as much as its reference shot.'] : []),
].join(' ');

/** What the paths say: how many of the reference's differ, and where the numbers to set a scene from are. */
export const pathsNote = (paths: readonly TrackDifference[]): string => {
  const off = paths.filter((p) => p.differs.length);
  return 'Each path measured in the reference (an object or an edge of a transition, an element that travels; angles: 0 is to the right, 90 down) against the other video\'s at the same moment. '
    + (off.length ? off.length + ' of ' + paths.length + ' differ' + (off.length === 1 ? 's' : '') + ' (differs says how, the reference\'s number first): set the scene from the reference\'s numbers (shots/NN.md, "Paths"; tracks.json has the samples) and compare again.' : 'None differs beyond the tolerances.');
};

/**
 * What was not recovered of the reference, for a compare to carry forward: the record of the render's project
 * (reference.facts.json), else the list beside a reference given as the measure.json describe wrote.
 */
const notRecovered = async (rt: Runtime, reference: string, facts: { unrecovered?: Unrecovered[] } | undefined): Promise<Unrecovered[]> => {
  if (Array.isArray(facts?.unrecovered)) return facts.unrecovered;
  return reference.endsWith('.json') ? unrecoveredIn(rt, rt.path.dirname(reference)) : [];
};

export const NOT_RECOVERED_NOTE = 'What the reading of the reference did not recover, and what its reader added. The delivery notes list every entry: what was not recovered, and what the re-make does instead ("assumed", or what you drew there). An entry you settled since says so.';

/** The change into each reference shot as the project of the render says, when the other video is a render of one. */
const projectWindows = async (rt: Runtime, other: string, shots: number, m: Measure): Promise<ReturnType<typeof changeWindows>> => {
  if (other.endsWith('.json')) return undefined;
  const dir = await projectOf(rt, other).catch(() => undefined);
  if (!dir) return undefined;
  const project = await readJson<Parameters<typeof changeWindows>[0]>(rt, rt.path.join(dir, 'video.json')).catch(() => undefined);
  return project ? changeWindows(project, shots, m.source.frames > 0 ? m.source.frames / (m.source.fps > 0 ? m.source.fps : 30) : m.source.duration) : undefined;
};

const compare = command(
  'two videos, or two measure.json files, scored dimension by dimension (1 is the same); then shots (each shot of the reference against the matching part of the other, with its motion amount in both), motionAmount (how much the picture moves in both videos, and the shots that move much less or more than the reference\'s), paths (each measured path of the reference against the other\'s: path angle, size, duration, edge shape, and what differs), notRecovered (what the reading of the reference did not recover, for the delivery notes) stillShots (the shots that stand still for more than 40% of their length while the reference shot moves throughout: each a named problem with its fix, to be fixed, not noted) and worst (the shots that differ most, each with the dimension that makes it so, its seconds in both and a look command that shows it, and the still shots with their problem); for a render, round (the review rounds so far), stillWorst and next',
  {
    positionals: [{ name: 'reference', help: 'a video, or the measure.json of one' }, { name: 'other', help: 'a video, or the measure.json of one' }],
    options: [
      { flag: '--reference-text', metavar: 'FILE', help: 'the text read from the reference (describe\'s text.json); with --other-text, the shots are compared on their text too' },
      { flag: '--other-text', metavar: 'FILE', help: 'the text read from the other video: popost video text <video> --out FILE' },
    ],
  },
  async (args, rt) => {
    const reference = await inputFile(rt, args.req('reference'));
    const other = await inputFile(rt, args.req('other'));
    const textA = args.string('reference-text'), textB = args.string('other-text');
    const text = textA !== undefined && textB !== undefined
      ? { reference: await readJson<TextTrack>(rt, await inputFile(rt, textA)), other: await readJson<TextTrack>(rt, await inputFile(rt, textB)) } : undefined;
    // One after the other: two decodes side by side would hold both videos' frames at once.
    const fullReference = await loadMeasure(rt, reference);
    const projectDir = other.endsWith('.json') ? undefined : await projectOf(rt, other).catch(() => undefined);
    const facts = projectDir ? await readFacts(rt, projectDir) : undefined;
    const scope = comparisonScope(fullReference, facts);
    const a = scope.measure;
    const b = await loadMeasure(rt, other);
    const score = scoreMeasures(a, b);
    const windows = await projectWindows(rt, other, a.shots.length, b);
    const shots = compareShots(a, b, { ...(text ? { text } : {}), ...(windows ? { windows } : {}) });
    const paths = compareTracks(a, b, shotTimeMap(a, b));
    const lost = await notRecovered(rt, reference, facts);
    const typed = { reference: args.req('reference'), other: args.req('other') };
    // A shot that stands still where its reference moves throughout is named with its fix, and is among worst whatever its score.
    const still = stillProblems(a, b, shots.shots);
    const listed = [...shots.worst, ...shots.shots.filter((d) => still.some((p) => p.shot === d.shot) && !shots.worst.includes(d))];
    const worst = listed.map((d) => {
      const look = lookCommand(typed, b, d);
      const problem = still.find((p) => p.shot === d.shot);
      return { shot: d.shot, by: d.by, score: d.score, scores: d.scores, reference: { ...d.reference, at: d.at.reference }, other: { ...d.other, at: d.at.other }, ...(look ? { look } : {}), ...(problem ? { problem: { name: problem.name, message: problem.message, fix: problem.fix } } : {}) };
    });
    // A render is recorded with its worst shots, and the round it is in is said where the agent reads (render/record.ts).
    const review = other.endsWith('.json') ? undefined : await reviewCompare(rt, {
      file: other, reference, worst: worst.map((w) => ({ shot: w.shot, score: w.score, by: w.by })),
      mean: Math.round((shots.shots.reduce((n, s) => n + s.score, 0) / Math.max(1, shots.shots.length)) * 1000) / 1000,
      ...(text && textA && textB ? { referenceText: userPath(rt, textA), otherText: userPath(rt, textB) } : {}),
    }).catch(() => undefined);
    printJson(rt, {
      ok: true, reference, other, composite: score.composite, dimensions: score.dimensions, shots: shots.shots, worst,
      ...(shots.motion ? { motionAmount: { ...shots.motion, note: motionNote(shots.motion) } } : {}),
      ...(still.length ? { stillShots: { shots: still, note: still.length + ' shot' + (still.length === 1 ? ' stands' : 's stand') + ' still where the reference moves throughout. Each is a problem to fix before delivery (worst[].problem has the fix), not a difference to note.' } } : {}),
      ...(paths.length ? { paths: { tracks: paths, note: pathsNote(paths) } } : {}),
      ...(lost.length ? { notRecovered: { entries: lost, note: NOT_RECOVERED_NOTE } } : {}),
      ...(scope.omitted ? { scope: { seconds: [0, a.source.frames / a.source.fps], omittedShots: scope.omitted, note: 'Only retained reference content is compared. Declared trailing platform shots are excluded after verifying the full reference visual fingerprint.' } } : {}),
      ...((textA === undefined) !== (textB === undefined) ? { note: 'Text is compared shot by shot only with both --reference-text and --other-text.' } : {}),
      ...(review ? { round: review.round, ...(review.stillWorst.length ? { stillWorst: review.stillWorst } : {}) } : {}),
      ...(other.endsWith('.json') ? {} : { next: roundNext(review) }),
    });
  },
);

const draft = command(
  'a first project built from the measurement of a video, no model',
  {
    positionals: [VIDEO],
    options: [
      outDir('the project directory to write (video.json, draft-notes.json, assets/)'),
      { flag: '--footage', choices: ['still', 'video'], default: 'still', help: 'still: every shot rebuilt from a frame and its measured elements; video: the footage is kept' },
    ],
  },
  async (args, rt) => {
    const video = await inputFile(rt, args.req('video'));
    const dir = userPath(rt, args.req('out'));
    const r = await buildDraft(rt, { video, measure: await measureVideo(rt, video), outDir: dir, footage: args.string('footage') === 'video' ? 'video' : 'still' });
    printJson(rt, {
      ok: true, dir, project: rt.path.join(dir, 'video.json'),
      segments: r.project.segments.length, items: r.project.tracks.length, notes: r.notes.length, notesFile: rt.path.join(dir, 'draft-notes.json'),
    });
  },
);

const synth = command(
  'one random project with a known truth, for calibrating the measurement (video.json and its pictures)',
  { options: [{ flag: '--seed', kind: 'int', required: true, help: 'the same seed always gives the same project' }, outDir('the project directory to write')] },
  async (args, rt) => {
    const dir = userPath(rt, args.req('out'));
    const c = synthCase({ seed: args.number('seed') ?? 0 });
    await writeCase(rt, c, dir);
    printJson(rt, { ok: true, seed: c.seed, dir, segments: c.project.segments.length, items: c.project.tracks.length, pictures: c.pictures.length });
  },
);

export const readCommands: Commands = { measure, text, transcript, describe, compare, draft, synth };

/** Command groups with commands of their own, e.g. `popost video scene check`. */
export const readGroups: Readonly<Record<string, Commands>> = {};

/** `popost video measure curve ...`: commands under the name of the `measure` command, told from it by their first word. */
export const measureGroup: Commands = measureCommands;
