/**
 * Retarget: the structure of a measured reference, filled with new content. The plan is what a model writes, and it
 * holds no times at all: lists that line up with the reference by position. "captions[3]" is the new line of the
 * reference's fourth beat (src/describe/beats.ts: what is said or shown, in time order); "shots[1]" says what fills the
 * reference's second shot. The program takes every time, length, transition and position from the measurement.
 * Copying an index is something a weak model does reliably; computing a frame number is not.
 */
import type { Base, Boundary, Box, Material, Measure, Problem, Project, Segment, Track, TransitionSpec } from '../types';
import { referenceBeats } from '../describe/beats';
import { paceOf } from '../speech/index';
import type { Transcript } from '../speech/types';
import type { TextCue, TextTrack } from '../text/types';
import { DUCK_DB } from '../timeline/mix';
import type { KindRange } from '../describe/speech-kind';
import { captionStyle } from './caption-look';
import { highlightColour, markSpans, unmark } from './marks';
import { projectFps } from './fps';
import { footageAudioProblems, itemTracks, shotItemProblems, type ShotItem } from './items';
import { paceWarnings, type Pace } from './pace';
import { barNote, barPlaces, barProblems, barTracks, emptyWords, titlePlaces, wordProblems, wordTracks } from './titles';

/**
 * What fills one shot of the reference; items: clips and pictures drawn over it (retarget/items.ts); words: a line
 * for each place the reference laid words on in this shot, by position, drawn in its place (retarget/titles.ts).
 */
export type ShotFill = ShotBase & { items?: ShotItem[]; words?: string[] };
export type { ShotItem };

export type ShotBase =
  /**
   * fit: 'cover' (default) fills the canvas and crops; 'contain' shows the whole picture, with "ground" (a colour,
   * default black) around it: a 16:9 recording on a 9:16 canvas.
   */
  | { footage: string; in?: number; speed?: number; audio?: false | number; fit?: 'cover' | 'contain'; ground?: string }
  /** zoom: how much the picture grows per second (0.04 = 4% a second, a slow push in; negative pulls out). Not a scale. */
  | { picture: string; zoom?: number; fit?: 'cover' | 'contain'; ground?: string }
  | { color: string }
  /**
   * A card of text on a plain or gradient ground: a title card, an end card. The title is set large, the lines
   * below it smaller, and they enter one after another.
   */
  | { card: { title: string; lines?: string[]; background?: string | [string, string]; color?: string } }
  /** Keep the reference's own footage for this shot (needs the reference video in the project as assets/reference.mp4). */
  | { keep: true }
  /**
   * A scene: an HTML file in the project (scenes/hook.html) that draws the whole shot, written for this video (the rules
   * a scene keeps are in references/video-scenes.md). slots: new words or pictures for its data-slot places.
   */
  | { scene: string; slots?: Record<string, string> };

export interface RetargetPlan {
  /**
   * New lines, one per beat of the reference, in order. A beat the reference showed gets its line drawn as a caption;
   * a beat it only said gets its line spoken (with a voice) and not drawn. An empty string leaves a beat empty. Words
   * wrapped in asterisks, *like this*, are drawn in the highlight colour (marks.ts).
   */
  captions?: string[];
  /** One entry per shot of the reference, in order. */
  shots: ShotFill[];
  /**
   * An audio file for the whole video (music, a recording), relative to the project directory: from the start, at its
   * own level, cut at the video's end with a fade-out when it is longer, not repeated when it is shorter. With a
   * spoken voice (--speak) it lies under the voice, UNDER_VOICE_DB lower.
   */
  sound?: string;
  /**
   * The sound of a clip running on under the shots cut from it, instead of being cut and re-timed with each shot:
   * footage is the clip, shots the first and the last shot it lies under (from 1), in the source frame it starts at
   * (default: the "in" of the first of those shots when that shot shows the clip, else 0), audio its gain in dB.
   */
  beds?: SoundBed[];
  /** Words that are spoken differently from how they are written: a brand name, an abbreviation. */
  say?: { text: string; as: string }[];
  /** The voice to speak the captions with (what the configured speaker understands), and its speed (1 is normal). */
  voice?: string;
  speed?: number;
  /**
   * With a voice: light up the word being spoken (true: a warm yellow; or a colour of your own, and optionally the
   * colour of the words already spoken). Needs the words of the voice, which "--speak" writes.
   */
  captionSpoken?: true | { color?: string; pastColor?: string };
  /**
   * With a voice: 'words' shows each word of a caption when it is spoken; 'whole' shows every line whole at once.
   * Default: as the reference's lines came on screen when that was measured (text.json captionLook.reveal: built
   * word by word or character by character gives 'words'), else whole.
   */
  captionReveal?: 'words' | 'whole';
  /**
   * Caption colour and the colour of its outline. Defaults: as the reference's captions looked when that was measured
   * (text.json captionLook: on a plate, outlined, plain), else white on a dark outline.
   */
  captionColor?: string;
  captionOutline?: string;
  /** The words of the reference's bar (sections laid on through the video; retarget/titles.ts), from the left. */
  bar?: string[];
  note?: string;
}

export interface SoundBed { footage: string; shots: [number, number]; in?: number; audio?: number }

/** What is wrong with the beds of a fill: each a clip and a range of shots, the ranges apart. */
export const bedProblems = (beds: unknown, shots: number): Problem[] => {
  if (beds === undefined) return [];
  const example = 'Write "beds": [{ "footage": "assets/film.mp4", "shots": [1, 4] }].';
  if (!Array.isArray(beds)) return [{ level: 'error', at: 'beds', message: '"beds" is a list: the clips whose sound runs on under a range of shots.', fix: example }];
  const taken: number[] = [];
  return beds.flatMap((b: Partial<SoundBed> | null, i): Problem[] => {
    const at = 'beds[' + i + ']';
    const r = b?.shots;
    if (!b || typeof b !== 'object' || typeof b.footage !== 'string' || !b.footage.trim() || !Array.isArray(r) || r.length !== 2 || !r.every((n) => Number.isInteger(n)) || r[0] < 1 || r[1] < r[0] || r[1] > shots)
      return [{ level: 'error', at, message: 'A bed names a clip and the first and last shot its sound lies under, counted from 1 (the video has ' + shots + ' shots).', fix: example }];
    const out: Problem[] = [];
    if (b.in !== undefined && !(Number.isInteger(b.in) && b.in >= 0)) out.push({ level: 'error', at: at + '.in', message: '"in" is the source frame the sound starts at, a whole number from 0.', fix: 'Write "in": 0, or remove it.' });
    out.push(...footageAudioProblems(b.audio as unknown, at + '.audio'));
    for (let k = r[0]; k <= r[1]; k++) {
      if (taken.includes(k)) { out.push({ level: 'error', at: at + '.shots', message: 'Shot ' + k + ' lies under two beds.', fix: 'Give every shot one bed at most.' }); break; }
      taken.push(k);
    }
    return out;
  });
};

export interface RetargetInput {
  measure: Measure;
  text?: TextTrack;
  /** The reference's speech: roles follow it, and speech that no caption covers gets beats of its own. */
  transcript?: Transcript;
  /**
   * The beats when they are known already (a template keeps them), in source frames; shown: false for a beat that was
   * only said. Without them they come from text and transcript. The caption band is set from text's captions either way.
   */
  beats?: { start: number; end: number; shown?: boolean; speech?: 'on-camera' }[];
  /** The confirmed kinds of the reference's speech (describe/speech-kind.ts), for beats read from text and transcript here. */
  kinds?: readonly KindRange[];
  /**
   * The beats whose lines the person of a clip says (dialogue beats a clip's speech covers): the voice never speaks
   * them, their time is the reference's, and a note says so. Their captions are drawn as the beat's "shown" says.
   */
  dialogue?: readonly number[];
  /** How fast the reference's speaker spoke (default: from the transcript), for the warning about lines too long to say. */
  pace?: Pace;
  plan: RetargetPlan;
  /**
   * Speech timing. frames[i] is how long the new caption line i is spoken (0 for an empty line). When given, time is
   * re-flowed: each caption beat takes the length of its spoken line, the pauses between beats stay as the reference
   * has them, and every shot boundary moves with the beat it falls in. Without it, the reference's own timing is kept.
   */
  spoken?: {
    frames: number[];
    /**
     * true: a beat never gets shorter than it is in the reference; a line that is said faster leaves air after it.
     * The video is then as long as its reference unless a line runs over, and every cut stays on the reference's
     * rhythm. false (default): a beat takes the length of its spoken line, shorter or longer.
     */
    hold?: boolean;
  };
  /** The words file of the plan's sound, relative to the project: the sound material names it and captions may follow it. */
  wordsFile?: string;
  /**
   * The plan's own sound file when a voice took its place as the plan's sound (--speak): music. It lies under the
   * voice for the whole video, lowered while a line is spoken (timeline/mix.ts), and fades out like any sound of a plan.
   */
  music?: string;
}

/** How far music lies under a spoken line, in dB (timeline/mix.ts, DUCK_DB); in the pauses and without speech it plays at its own level. */
export const UNDER_VOICE_DB = -DUCK_DB;
/** Seconds over which a plan's sound fades out when it is longer than the video (AudioTrack.fadeOut). */
export const SOUND_FADE_SECONDS = 1;
/**
 * Where the spoken lines start in the re-flowed video, for laying the voice clips on a track. slots: each beat's length
 * in the reference (project frames); reference: the reference's length.
 */
export interface RetargetTiming { starts: number[]; total: number; map: (frame: number) => number; slots: number[]; reference: number }
export interface RetargetOutput extends RetargetResult { timing?: RetargetTiming }
export interface RetargetResult { project?: Project; problems: Problem[]; notes: string[] }

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);
const two = (n: number): string => String(n).padStart(2, '0');
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;

const transitionSpec = (b: Boundary, toFrames: (n: number) => number, room: number): TransitionSpec | undefined => {
  if (b.kind === 'cut') return undefined;
  const frames = Math.min(Math.max(2, toFrames(b.end - b.start - 1)), room);
  if (frames < 2) return undefined;
  return { transition: b.kind, frames, ...(b.direction ? { direction: b.direction } : {}), ...(b.mode ? { mode: b.mode } : {}), ...(b.via ? { via: b.via } : {}) };
};

export const FILL_KINDS = ['footage', 'picture', 'color', 'card', 'keep', 'scene'] as const;

/** The items of a card: the title at about 40% of the height, the lines stacked below it, entering 5 frames apart. */
const cardItems = (id: string, card: Extract<ShotFill, { card: unknown }>['card'], frames: number): Track[] => {
  const color = card.color ?? '#ffffff';
  const lines = (card.lines ?? []).filter((l) => l.trim());
  const start = Math.min(6, Math.max(0, frames - 12));
  const enter = { preset: 'slide' as const, frames: Math.min(10, Math.max(2, Math.floor(frames / 4))), direction: 'up' as const, distance: 0.06, ease: 'out' as const };
  const title: Track = { id: id + '-title', type: 'text', text: card.title, box: [0.08, lines.length ? 0.3 : 0.4, 0.84, 0.2], style: { size: 0.085, weight: 800, color, align: 'center' }, during: { segment: id, from: start }, enter };
  const rest = lines.map((text, i): Track => ({
    id: id + '-line' + (i + 1), type: 'text', text, box: [0.1, r4(0.52 + i * 0.09), 0.8, 0.085], style: { size: 0.04, weight: 500, color, align: 'center', opacity: 0.86 },
    during: { segment: id, from: Math.min(frames - 2, start + 5 * (i + 1)) }, enter,
  }));
  return [title, ...rest];
};

/** The largest zoom rate a fill may ask for: at 0.3 a picture is a third larger after one second. */
export const MAX_ZOOM_RATE = 0.3;

/** Reject malformed caption overrides before a fill writes a project or requests speech. */
export const captionOptionProblems = (plan: RetargetPlan): Problem[] => [
  ...(['captionColor', 'captionOutline'] as const).flatMap((key) => plan[key] === undefined || (typeof plan[key] === 'string' && plan[key].trim()) ? [] : [{ level: 'error' as const, at: key, message: key + ' is a CSS colour string.', fix: 'Write "' + key + '": "#111111", or remove it.' }]),
  ...(plan.captionReveal === undefined || plan.captionReveal === 'words' || plan.captionReveal === 'whole' ? [] : [{ level: 'error' as const, at: 'captionReveal', message: 'captionReveal is "words" (each word shows when it is spoken) or "whole" (every line whole at once); it is ' + JSON.stringify(plan.captionReveal) + '.', allowed: ['words', 'whole'], fix: 'Write "captionReveal": "words" or "whole", or remove it to follow the source.' }]),
];

/** Problems of the values of a footage or picture fill that every caller checks the same way: zoom, fit, ground. */
export const fillValueProblems = (s: Record<string, unknown>, at: string): Problem[] => {
  const out: Problem[] = [];
  out.push(...footageAudioProblems(s.audio, at + '.audio'));
  if (s.audio !== undefined && !('footage' in s)) out.push({ level: 'error', at: at + '.audio', message: 'Source audio belongs to a footage fill.', fix: 'Put audio on the video item, or remove it.' });
  if (s.zoom !== undefined && !(typeof s.zoom === 'number' && Math.abs(s.zoom) <= MAX_ZOOM_RATE))
    out.push({ level: 'error', at: at + '.zoom', message: '"zoom" is how much the picture grows per second (0.04 = 4% a second), not a scale; it is ' + JSON.stringify(s.zoom) + ', and the most is ' + MAX_ZOOM_RATE + '.', fix: 'Write "zoom": 0.04 for a slow push in, -0.04 to pull out, or remove it for a still picture.' });
  if (s.fit !== undefined && s.fit !== 'cover' && s.fit !== 'contain')
    out.push({ level: 'error', at: at + '.fit', message: '"fit" is "cover" (fill the canvas, crop what does not fit) or "contain" (show the whole picture on a ground); it is ' + JSON.stringify(s.fit) + '.', allowed: ['cover', 'contain'], fix: 'Write "fit": "contain", or remove it.' });
  if (s.ground !== undefined && (typeof s.ground !== 'string' || !s.ground.trim()))
    out.push({ level: 'error', at: at + '.ground', message: '"ground" is the colour around a picture that is shown whole, such as "#101014".', fix: 'Write "ground": "#101014".' });
  return out;
};

const checkPlan = (plan: RetargetPlan, shots: number, beats: { shown: boolean }[], places: number[]): Problem[] => {
  const out: Problem[] = [...captionOptionProblems(plan), ...(Array.isArray(plan.shots) ? bedProblems(plan.beds, shots) : [])];
  if (!Array.isArray(plan.shots)) return [{ level: 'error', at: 'shots', message: 'The plan needs "shots": one entry per shot of the reference (' + shots + ').', fix: 'Add "shots": [ ... ] with ' + shots + ' entries.' }];
  if (plan.shots.length !== shots) {
    out.push({ level: 'error', at: 'shots', message: 'The plan has ' + plan.shots.length + ' shots; the reference has ' + shots + '. They are matched by position.', fix: plan.shots.length < shots ? 'Add ' + (shots - plan.shots.length) + ' more entries (see timeline.md for what each shot is).' : 'Remove the last ' + (plan.shots.length - shots) + ' entries.' });
  }
  plan.shots.forEach((s, k) => {
    const kinds = FILL_KINDS.filter((key) => key in s);
    if (kinds.length !== 1) out.push({ level: 'error', at: 'shots[' + k + ']', message: 'A shot is filled by exactly one of ' + FILL_KINDS.join(', ') + '; this one has ' + (kinds.length ? kinds.join(' and ') : 'none') + '.', allowed: [...FILL_KINDS], fix: 'For example { "footage": "assets/clip.mp4", "in": 0 }.' });
    if ('card' in s && !s.card?.title?.trim()) out.push({ level: 'error', at: 'shots[' + k + '].card.title', message: 'A card needs a title.', fix: 'Add "title": "..." (a few words).' });
    if ('scene' in s && (typeof s.scene !== 'string' || !s.scene.trim())) out.push({ level: 'error', at: 'shots[' + k + '].scene', message: 'A scene is the path of an HTML file in the project, such as "scenes/shot-01.html".', fix: 'Write "scene": "scenes/shot-01.html".' });
    const at = 'shots[' + k + ']', shot = s as Record<string, unknown>;
    out.push(...fillValueProblems(shot, at), ...shotItemProblems(shot, at), ...wordProblems(shot, at, places[k] ?? 0));
  });
  return plan.captions ? [...out, ...countProblem(plan.captions.length, beats)] : out;
};

/** The count of a plan's lines against the beats. As many lines as shown beats, when some beats are spoken only, is a plan written for the captions alone. */
const countProblem = (lines: number, beats: { shown: boolean }[]): Problem[] => {
  const n = beats.length, shown = beats.filter((b) => b.shown).length;
  if (lines === n) return [];
  const has = 'The plan has ' + lines + ' caption lines; the reference has ' + n + (shown === n ? ' caption beats.' : ' beats (' + shown + ' shown, ' + (n - shown) + ' spoken only; timeline.md numbers them).') + ' They are matched by position.';
  if (lines > 0 && lines === shown && shown < n)
    return [{ level: 'error', at: 'captions', message: has + ' A line is needed for the spoken-only beats too.', fix: 'Write one line per beat, in the order of timeline.md: captions[i] is beat i. A spoken-only line is spoken (--speak) and not drawn.' }];
  if (lines > n) return [{ level: 'error', at: 'captions', message: has, fix: 'Remove ' + (lines - n) + ' lines, or join short lines.' }];
  return [{ level: 'warning', at: 'captions', message: has + ' The last ' + (n - lines) + ' beats stay without a caption.', fix: 'Add lines, or leave it if the ending should be silent.' }];
};

/** The caption band of the reference: where the lines sit and how large they are. */
const captionLayout = (cues: TextCue[]): { box: Box; size: number } => {
  const size = median(cues.map((c) => c.size));
  const centre = median(cues.map((c) => c.box[1] + c.box[3] / 2));
  // Room for two lines around the measured centre, 84% of the width. Near an edge the box gets lower rather than
  // moving, so that a single line still sits where the reference's lines sit.
  const half = Math.max(size * 0.6, Math.min(size * 1.4, centre - 0.01, 0.99 - centre));
  return { box: [0.08, r4(centre - half), 0.84, r4(2 * half)], size: r4(size * 0.92) };
};

/** A caption line as it is to be spoken: every "say" entry applied. */
export const spokenForm = (line: string, say: RetargetPlan['say']): string =>
  (say ?? []).reduce((s, x) => s.split(x.text).join(x.as), line);

/** Frames of air after a spoken line before its caption may give way to the next. */
export const LINE_TAIL = 4;

/**
 * The re-flow: a piecewise linear map from the reference's time to the new time. Its knots are the start and the
 * end of every caption beat; before the first beat and after the last, time passes as in the reference. With hold,
 * a beat is at least as long as it was.
 */
export const reflow = (beats: { start: number; end: number }[], spoken: number[], total: number, hold = false): { map: (frame: number) => number; starts: number[]; ends: number[]; total: number } => {
  const knots: [number, number][] = [[0, 0]];
  const starts: number[] = [], ends: number[] = [];
  let shift = 0;
  beats.forEach((b, i) => {
    const was = b.end - b.start;
    const length = spoken[i] ? Math.max(hold ? was : 0, (spoken[i] as number) + LINE_TAIL) : was;
    const start = b.start + shift;
    starts.push(start);
    ends.push(start + length);
    knots.push([b.start, start], [b.end, start + length]);
    shift += length - (b.end - b.start);
    // The next beat may begin before this one's new end only if the reference let them touch: keep at least no overlap.
    const next = beats[i + 1];
    if (next && next.start + shift < start + length) shift = start + length - next.start;
  });
  knots.push([total, total + shift]);
  const map = (frame: number): number => {
    for (let k = 1; k < knots.length; k++) {
      const [x0, y0] = knots[k - 1] as [number, number], [x1, y1] = knots[k] as [number, number];
      if (frame <= x1 || k === knots.length - 1) return x1 === x0 ? y1 : Math.round(y0 + ((frame - x0) * (y1 - y0)) / (x1 - x0));
    }
    return frame;
  };
  return { map, starts, ends, total: total + shift };
};

/**
 * The reference's measurement on the re-flowed clock: every boundary, shot and event moved by the same map as the
 * project was. A re-flowed remake is scored against this, not against the reference's own clock, or every cut that
 * moved with its spoken line would count as wrong. Rhythm and the picture signature are tied to the old clock and
 * are left empty.
 */
export const reflowMeasure = (m: Measure, map: (frame: number) => number, total: number): Measure => {
  const fps = projectFps(m.source.fps);
  const ratio = fps / m.source.fps;
  const at = (frame: number): number => map(Math.round(frame * ratio));
  return {
    version: 1,
    source: { ...m.source, fps, frames: total, duration: total / fps },
    boundaries: m.boundaries.map((b) => {
      const frame = at(b.frame);
      // A transition keeps its own length; only where it sits moves.
      return { ...b, frame, start: frame - Math.round((b.frame - b.start) * ratio), end: frame + Math.round((b.end - b.frame) * ratio) };
    }),
    shots: m.shots.map((s) => ({
      ...s, start: at(s.start), end: at(s.end),
      events: s.events.map((e) => { const start = at(e.start); return { ...e, start, end: start + Math.max(1, Math.round((e.end - e.start) * ratio)) }; }),
    })),
    rhythm: { step: m.rhythm.step, change: [] },
    signature: { ...m.signature, count: 0, data: '' },
  };
};

/** The beats of the input (given, or read from its text and speech), the caption cues that set the band, and the text with its roles. */
const beatsOf = (input: RetargetInput): { beats: { start: number; end: number; shown: boolean }[]; captions: TextCue[]; text?: TextTrack } => {
  if (input.beats) {
    const captions = (input.text?.cues ?? []).filter((c) => c.role === 'caption').sort((a, b) => a.start - b.start);
    return { beats: input.beats.map((b) => ({ start: b.start, end: b.end, shown: b.shown !== false })), captions, ...(input.text ? { text: input.text } : {}) };
  }
  const m = input.measure;
  const r = referenceBeats({ ...(input.text ? { text: input.text } : {}), ...(input.transcript ? { transcript: input.transcript } : {}), total: m.source.frames, boundaries: m.boundaries.map((b) => b.frame), ...(input.kinds ? { kinds: input.kinds } : {}) });
  return { beats: r.beats, captions: r.captions, ...(r.text ? { text: r.text } : {}) };
};

export const retarget = (input: RetargetInput): RetargetOutput => {
  const { measure: m } = input;
  // Words a line marks *like this* are drawn in the highlight colour (marks.ts); all else reads the line without its marks.
  const marked = (input.plan.captions ?? []).map(unmark);
  const plan: RetargetPlan = input.plan.captions ? { ...input.plan, captions: marked.map((l) => l.text) } : input.plan;
  const read = beatsOf(input);
  const captionCues = read.captions;
  // Where the reference laid words over its shots (its titles), in its own frames from each shot's start.
  const places = titlePlaces(m, read.text ?? input.text).map((xs) => xs.map((x) => x.place));
  const bar = barPlaces(m, read.text ?? input.text);
  const problems = [...checkPlan(plan, m.shots.length, read.beats, places.map((p) => p.length)), ...barProblems(plan.bar, bar?.places.length ?? 0)];
  if (problems.some((p) => p.level === 'error')) return { problems, notes: [] };
  const notes: string[] = [];
  const fps = projectFps(m.source.fps);
  const ratio = fps / m.source.fps;
  const toFrames = (n: number): number => Math.round(n * ratio);
  const refTotal = toFrames(m.source.frames);
  const beats = read.beats.map((b) => ({ start: toFrames(b.start), end: Math.min(toFrames(b.end), refTotal), shown: b.shown }));
  const slots = beats.map((b) => b.end - b.start);
  if (!input.spoken) problems.push(...paceWarnings(plan.captions ?? [], slots, fps, input.pace ?? paceOf(input.transcript)));
  const flow = input.spoken ? reflow(beats, input.spoken.frames, refTotal, input.spoken.hold === true) : undefined;
  const at = (frame: number): number => (flow ? flow.map(frame) : frame);
  const total = flow ? flow.total : refTotal;
  const starts = m.shots.map((s) => at(toFrames(s.start)));
  const lengths = m.shots.map((_s, k) => Math.max(1, (starts[k + 1] ?? total) - (starts[k] ?? 0)));
  const materials: Material[] = [];
  const use = (file: string, kind: Material['kind']): string => {
    const found = materials.find((x) => x.file === file);
    if (found) return found.id;
    const id = kind + '-' + (materials.filter((x) => x.kind === kind).length + 1);
    materials.push({ id, kind, file });
    return id;
  };
  const baseOf = (fill: ShotFill, k: number): Base => {
    const view = 'footage' in fill || 'picture' in fill ? { fit: fill.fit ?? ('cover' as const), ...(fill.ground ? { ground: fill.ground } : {}) } : { fit: 'cover' as const };
    if ('footage' in fill) return { material: use(fill.footage, 'video'), ...view, ...(fill.in ? { in: fill.in } : {}), ...(fill.speed && fill.speed !== 1 ? { speed: fill.speed } : {}), ...(fill.audio !== undefined ? { audio: fill.audio } : {}) };
    if ('picture' in fill) return { material: use(fill.picture, 'image'), ...view, ...(fill.zoom ? { camera: { zoom: fill.zoom } } : {}) };
    if ('color' in fill) return { color: fill.color };
    if ('scene' in fill) return { scene: fill.scene, ...(fill.slots ? { slots: fill.slots } : {}) };
    if ('card' in fill) {
      const bg = fill.card.background ?? ['#141a2e', '#0b0d17'];
      return { color: typeof bg === 'string' ? bg : { type: 'linear', angle: 160, stops: [{ at: 0, color: bg[0] }, { at: 1, color: bg[1] }] } };
    }
    return { material: use('assets/reference.mp4', 'video'), fit: 'cover', in: m.shots[k]?.start ?? 0 };
  };
  const segments: Segment[] = m.shots.map((_shot, k) => {
    const fill = plan.shots[k] as ShotFill;
    const segment: Segment = { id: 'shot-' + two(k + 1), frames: lengths[k] ?? 1, base: baseOf(fill, k) };
    const into = k > 0 ? m.boundaries[k - 1] : undefined;
    // Footage that is kept carries its own transition; new content gets the measured one.
    const keptBoth = 'keep' in fill && k > 0 && 'keep' in (plan.shots[k - 1] as ShotFill);
    if (into && !keptBoth) {
      const spec = transitionSpec(into, toFrames, Math.min(lengths[k - 1] ?? 1, lengths[k] ?? 1));
      if (spec) segment.in = spec;
    }
    return segment;
  });
  const tracks: Track[] = plan.shots.flatMap((fill, k) => [
    ...('card' in fill ? cardItems('shot-' + two(k + 1), fill.card, lengths[k] ?? 1) : []),
    ...(fill.items?.length ? itemTracks('shot-' + two(k + 1), fill.items, use, lengths[k] ?? 1) : []),
    ...(fill.words?.length ? wordTracks('shot-' + two(k + 1), fill.words, places[k] ?? [], (f) => at(toFrames((m.shots[k]?.start ?? 0) + f)) - (starts[k] ?? 0), lengths[k] ?? 1) : []),
  ]);
  if (bar && plan.bar?.length) tracks.push(...barTracks(bar, plan.bar, segments, total));
  for (const n of [emptyWords(plan.shots as unknown as Record<string, unknown>[], places), barNote(bar, plan.bar)]) if (n) notes.push(n);
  const lines = plan.captions ?? [];
  if (captionCues.length && lines.some((l, i) => l.trim() && beats[i]?.shown)) {
    const layout = captionLayout(captionCues);
    const first = segments[0]?.id ?? 'shot-01';
    // As the reference's lines looked (its plate, outline or plain letters); without that measured, an outline and a
    // soft shadow keep a line legible on light and dark footage alike.
    const look = captionStyle(read.text?.captionLook, plan, layout.size);
    const lit = highlightColour(read.text?.captionLook, look.color);
    // Only a beat the reference showed is drawn; a beat it only said keeps the picture as it was.
    const cues = beats.flatMap((b, i) => {
      const text = (lines[i] ?? '').trim();
      if (!text || !b.shown) return [];
      // The next line may start where this one ends; a cue never runs into the next one.
      const from = flow ? (flow.starts[i] ?? 0) : b.start;
      const to = Math.min(flow ? (flow.ends[i] ?? from) : b.end, flow ? (flow.starts[i + 1] ?? total) : total, total);
      const marks = marked[i]?.marks ?? [];
      return to > from ? [{ text, during: { segment: first, from, to }, ...(marks.length ? { spans: markSpans(marks, lit) } : {}) }] : [];
    });
    // Captions can follow the spoken word only when the sound's words are known.
    const follows = Boolean(input.wordsFile && plan.sound);
    // As the reference's lines came on screen: built up there, built up here, unless the fill says otherwise.
    const measured = read.text?.captionLook?.reveal;
    const built = plan.captionReveal === 'words' || (plan.captionReveal === undefined && measured !== undefined && measured.kind !== 'whole' && measured.confidence >= 0.6);
    tracks.push({
      id: 'captions', type: 'caption', box: layout.box,
      style: {
        ...look,
        ...(follows && plan.captionSpoken ? { spoken: { color: (plan.captionSpoken === true ? undefined : plan.captionSpoken.color) ?? '#ffd84a', ...(plan.captionSpoken !== true && plan.captionSpoken.pastColor ? { past: { color: plan.captionSpoken.pastColor } } : {}) } } : {}),
      },
      ...(follows && (plan.captionSpoken || built) ? { words: true as const } : {}),
      ...(follows && built ? { reveal: 'words' as const } : {}),
      cues,
    });
    notes.push(cues.length + ' caption lines placed on the reference\'s caption beats (band at ' + Math.round((layout.box[1] + layout.box[3] / 2) * 100) + '% of the height).');
  }
  (plan.beds ?? []).forEach((bed, i) => {
    const [a, b] = bed.shots;
    const first = plan.shots[a - 1];
    const from = bed.in ?? (first && 'footage' in first && first.footage === bed.footage ? (first.in ?? 0) : 0);
    const frames = lengths.slice(a - 1, b).reduce((n, x) => n + x, 0);
    tracks.push({ id: 'bed-' + (i + 1), type: 'audio', material: use(bed.footage, 'video'), bed: true, ...(from ? { in: from } : {}), ...(bed.audio !== undefined ? { gain: bed.audio } : {}), during: { segment: 'shot-' + two(a), from: 0, to: frames } });
  });
  if (plan.sound) {
    const id = use(plan.sound, 'audio');
    const material = materials.find((x) => x.id === id);
    if (material && input.wordsFile) material.words = input.wordsFile;
    // The voice the engine mixed is as long as the video; a file of the plan's own may be longer and then ends softly.
    // The layers of the mix (timeline/mix.ts): the voice with the frames its lines are spoken on, or the plan's sound as music.
    const spokenLines = flow && input.spoken ? input.spoken.frames.flatMap((n, i): [number, number][] => (n > 0 ? [[flow.starts[i] ?? 0, Math.min(total, (flow.starts[i] ?? 0) + n)]] : [])) : [];
    tracks.push(input.wordsFile ? { id: 'sound', type: 'audio', material: id, role: 'voice', lines: spokenLines } : { id: 'sound', type: 'audio', material: id, role: 'music', fadeOut: SOUND_FADE_SECONDS });
  }
  if (input.music && input.music !== plan.sound) {
    tracks.push({ id: 'music', type: 'audio', material: use(input.music, 'audio'), role: 'music', fadeOut: SOUND_FADE_SECONDS });
    notes.push('The fill\'s sound (' + input.music + ') lies under the voice: ' + -UNDER_VOICE_DB + ' dB lower while a line is spoken, at its own level in the pauses.');
  }
  const dialogue = (input.dialogue ?? []).filter((i) => (lines[i] ?? '').trim());
  if (dialogue.length) notes.push(dialogue.length + ' line(s) are said by the person of a clip (' + dialogue.map((i) => 'captions[' + i + ']').join(', ') + '): the voice-over does not read them, and their clips are heard at full level.');
  if ((plan.captionSpoken || plan.captionReveal === 'words') && !input.wordsFile) notes.push('captionSpoken and captionReveal need a voice with words; they were left out. Use --speak.');
  const kept = plan.shots.filter((s) => 'keep' in s).length;
  if (kept) notes.push(kept + ' shot(s) keep the reference\'s own footage; copy the reference to assets/reference.mp4 in the project.');
  const unshown = lines.flatMap((l, i) => (l.trim() && beats[i] && !beats[i]?.shown && !(input.dialogue ?? []).includes(i) ? [i] : []));
  if (unshown.length) notes.push(unshown.length + ' line(s) belong to beats the reference only said (' + unshown.map((i) => 'captions[' + i + ']').join(', ') + '): ' + (input.spoken ? 'they are spoken and not drawn.' : 'without a voice (--speak) they are neither shown nor heard.'));
  const marks = [...new Set((read.text?.cues ?? []).filter((c) => c.role === 'watermark').map((c) => c.text))];
  if (marks.length) notes.push('The reference\'s watermark (' + marks.slice(0, 3).join(', ') + ') is not re-created.');
  const project: Project = {
    version: 1, canvas: { width: even(m.source.width), height: even(m.source.height), fps }, materials, segments, tracks,
    note: plan.note ?? 'retargeted from a measured reference: its shots, transitions and caption beats, with new content',
  };
  if (Math.abs(m.source.fps - fps) > 1) notes.push('The reference runs at ' + Number(m.source.fps.toFixed(2)) + ' frames a second; the project is made at ' + fps + ', which halves the cost and keeps every cut, caption and word where it is in time.');
  if (flow) notes.push('Time was re-flowed to the spoken lines: ' + refTotal + ' frames in the reference, ' + total + ' now.');
  return { project, problems, notes, ...(flow ? { timing: { starts: flow.starts, total, map: flow.map, slots, reference: refTotal } } : {}) };
};
