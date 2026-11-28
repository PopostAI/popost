/**
 * The three readings of a reference that describe needs: the measurement (always), the on-screen text (with a text
 * reader) and the speech (with a transcriber). None needs another, so they run side by side when the CPU budget has
 * room (SIDE_BY_SIDE_FROM processors), and one after another below it; the result is the same either way. On a 30 s
 * video they take from half a minute to several minutes, the reader most, so a progress line about all three goes
 * out every everyMs, and it says which part works and which waits its turn. Beside them (or after them, below the
 * budget) a few frames a second are decoded for the frame around the content (inset.ts); the same frames give each shot
 * the share of its middle picture that is not ground (measure/fill.ts), at no further decoding. With pictures asked for,
 * that pass waits for the measurement and also decodes the frames of describe's pictures (frames.ts), at the same size,
 * and writes them: the frames of a shot's sheet depend on where the measurement put its boundaries.
 */
import type { Runtime } from '../../runtime';
import { cpuBudgetOf, partsSideBySide } from '../host';
import { writeSheets, type SheetResult } from '../look/sheets';
import { sourceFrames } from '../media/decode';
import { probe } from '../media/ffmpeg';
import { fillOfRgb } from '../measure/fill';
import { measureVideo } from '../measure/index';
import { pictureSheets } from './frames';
import { frameOf, insetPlan, insetSamples, type Inset, type InsetSamples } from './inset';
import { watchProgress, type OnStage } from '../progress';
import { transcribe, type Transcriber, type Transcript } from '../speech/index';
import { ToolError } from '../tool';
import { cuesOf, readSamples, withCaptionLook, type TextReader, type TextTrack } from '../text/index';
import type { Measure } from '../types';

export interface ReadReferenceOptions {
  reader?: TextReader;
  transcriber?: Transcriber;
  language?: string;
  /** Where a progress line goes (stderr in the command), and how often. */
  progress?: { write: (line: string) => void; everyMs: number };
  /** Write describe's pictures (frames.ts) into this directory. */
  pictures?: { dir: string };
}

/**
 * inset: the frame around the content when the shots show one (inset.ts). pictures: the sheets written, when asked for.
 * speechFailed: the transcriber failed (its message, first line); the rest of the reading stands, and the speech is
 * then unknown, not absent.
 */
export interface ReferenceReading { measure: Measure; text?: TextTrack; transcript?: Transcript; inset?: Inset; pictures?: SheetResult[]; speechFailed?: string }

/** The inset's samples and describe's pictures, from one pass over the video once the measurement is known. */
const samplesAndPictures = async (rt: Runtime, video: string, measure: Measure, dir: string): Promise<{ samples: InsetSamples; pictures: SheetResult[] }> => {
  const p = await probe(rt, video);
  const { every, width } = insetPlan(p);
  const keep = Array.from({ length: Math.ceil(sourceFrames(p) / every) }, (_, i) => i * every);
  const w = await writeSheets(rt, video, pictureSheets(measure), { width, outDir: dir, keep, probe: p });
  const frames = keep.flatMap((frame) => { const rgb = w.kept.get(frame); return rgb ? [{ frame, rgb }] : []; });
  return { samples: { width: w.size.width, height: w.size.height, frames }, pictures: w.sheets };
};

/**
 * Each shot with the share of its middle picture that is not ground: the sample nearest the middle of the shot's clean
 * interior, clear of the transitions. A shot too short to hold a sample keeps none.
 */
export const withShotFills = (m: Measure, s: InsetSamples): Measure => ({
  ...m,
  shots: m.shots.map((shot, i) => {
    const lo = i > 0 ? (m.boundaries[i - 1]?.end ?? shot.start) : 0;
    const hi = i < m.boundaries.length ? (m.boundaries[i]?.start ?? shot.end - 1) : shot.end - 1;
    const middle = (lo + hi) / 2;
    const nearest = s.frames.filter((f) => f.frame >= lo && f.frame <= hi).sort((a, b) => Math.abs(a.frame - middle) - Math.abs(b.frame - middle))[0];
    const fill = nearest ? fillOfRgb(s.width, s.height, nearest.rgb) : undefined;
    return fill === undefined ? shot : { ...shot, fill: Math.round(fill * 1000) / 1000 };
  }),
});

export const readReference = async (rt: Runtime, video: string, o: ReadReferenceOptions = {}): Promise<ReferenceReading> => {
  const together = partsSideBySide(rt);
  const label = together ? 'describe' : 'describe (one part at a time, CPU budget ' + cpuBudgetOf(rt).cpus + ')';
  const progress = o.progress ? watchProgress(o.progress.write, { label, everyMs: o.progress.everyMs }) : undefined;
  /** A part with its own reporter, marked done when it ends. */
  const part = async <T>(name: string, work: (onStage: OnStage | undefined) => Promise<T>): Promise<T> => {
    const onStage = progress?.part(name);
    try {
      return await work(onStage);
    } finally {
      progress?.end(name);
    }
  };
  const { reader, transcriber } = o;
  const measureIt = (): Promise<Measure> => part('measure', (onStage) => measureVideo(rt, video, onStage ? { onStage } : {}));
  const readIt = (): Promise<TextTrack | undefined> => reader ? part('text', async (onStage) => {
    const track = cuesOf(await readSamples(rt, video, reader, onStage ? { onStage } : {}));
    onStage?.('measuring what is behind the caption letters');
    return withCaptionLook(rt, video, track);
  }) : Promise.resolve(undefined);
  // A transcriber that fails (a tool's error, a job the platform could not finish) does not take the measurement and
  // the pictures with it: the reading goes on and says that the speech is unknown. A price or a refusal still stops it.
  const failure: { speech?: string } = {};
  const hearIt = (): Promise<Transcript | undefined> => transcriber ? part('speech', (onStage) => transcribe(rt, video, transcriber, o.language, onStage).catch((e: unknown) => {
    if (!(e instanceof ToolError)) throw e;
    failure.speech = e.message.split('\n')[0] ?? 'the transcriber failed';
    return undefined;
  })) : Promise.resolve(undefined);
  const dir = o.pictures?.dir;
  type Looked = { samples: InsetSamples; pictures?: SheetResult[] };
  const samplesOnly = (): Promise<Looked> => insetSamples(rt, video).then((samples) => ({ samples }));
  const lookIt = (measure: Measure): Promise<Looked> => dir === undefined ? samplesOnly()
    : part('pictures', (onStage) => { onStage?.('decoding and drawing the pictures'); return samplesAndPictures(rt, video, measure, dir); });
  try {
    if (!together) {
      // Every part is listed from the start, in the order they will run.
      progress?.wait('measure');
      if (reader) progress?.wait('text');
      if (transcriber) progress?.wait('speech');
      if (dir !== undefined) progress?.wait('pictures');
    }
    // A few frames a second for the frame around the content; the shots it is read by come from the measurement. With
    // pictures, the pass waits for the measurement (their frames follow its boundaries); without, it runs beside it.
    const measured = async (): Promise<[Measure, Looked]> => {
      if (dir === undefined) return Promise.all([measureIt(), samplesOnly()]);
      const m = await measureIt();
      return [m, await lookIt(m)];
    };
    const [[measure, looked], text, transcript] = together
      ? await Promise.all([measured(), readIt(), hearIt()])
      : await (async () => { const m = await measureIt(); const t = await readIt(); const s = await hearIt(); return [[m, await lookIt(m)], t, s] as const; })();
    const inset = frameOf(looked.samples, measure, text);
    return {
      measure: withShotFills(measure, looked.samples), ...(text ? { text } : {}), ...(transcript ? { transcript } : {}), ...(inset ? { inset } : {}),
      ...(looked.pictures ? { pictures: looked.pictures } : {}), ...(failure.speech !== undefined ? { speechFailed: failure.speech } : {}),
    };
  } finally {
    progress?.stop();
  }
};
