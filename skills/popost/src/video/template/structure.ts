/**
 * The structure of a template: read from a measured reference (templateFrom), and turned back into the inputs a
 * retarget takes (retargetInputs), so that a filled template goes through the same code as a retarget and there is one
 * implementation of the timing. structureMeasure is the template's own structure as a measurement, on any clock a
 * fill ends up with, for scoring a render of the fill.
 */
import { referenceBeats, type ReferenceBeats } from '../describe/beats';
import type { KindRange } from '../describe/speech-kind';
import { cameraAim } from '../describe/aim';
import type { Inset } from '../describe/inset';
import { shotLooks } from '../describe/kind';
import { projectFps } from '../retarget/fps';
import { retarget, type ShotFill } from '../retarget/index';
import { barPlaces, titlePlaces, type WordPlace } from '../retarget/titles';
import type { Transcript } from '../speech/types';
import type { Boundary, Box, CameraMeasure, CaptionTrack, Measure, ShotMeasure, TextStyle, Track } from '../types';
import type { Band } from './capacity';
import type { CaptionHighlight, TextCue, TextTrack } from '../text/types';
import { scriptOf } from './capacity';
import { CARD_MIN_SECONDS, TEMPLATE_FORMAT, TEMPLATE_VERSION, type SourceKind, type Template, type TemplateCaptions, type TemplateShot, type TemplateTransition } from './types';

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;
const pct = (v: number): string => Math.round(v * 100) + '%';

/**
 * A shot whose picture keeps changing is footage: the median share of pixels that change between samples a tenth of a
 * second apart (the rhythm curve) is at least this. On the development set, screen recordings and filmed shots sit at
 * 0.03 to 0.56 and still pictures, cards and slow camera moves on a still at 0.001 to 0.02.
 */
const FOOTAGE_CHANGE = 0.02;
/** A shot whose largest colour covers at least this share of the picture, and that does not keep changing, is a colour. */
const FLAT_SHARE = 0.9;

/** The rhythm samples that lie wholly inside a shot, away from its two boundaries. */
const changeInside = (s: ShotMeasure, m: Measure): number[] => {
  const step = Math.max(1, m.rhythm.step);
  const lo = Math.ceil(s.start / step) + 1;
  const hi = Math.floor(s.end / step) - 1;
  return hi > lo ? m.rhythm.change.slice(lo, hi) : [];
};

export const sourceKindOf = (s: ShotMeasure, m: Measure): { kind: SourceKind; change: number } => {
  const change = median(changeInside(s, m));
  if (s.camera.kind === 'unsteady' || change >= FOOTAGE_CHANGE) return { kind: 'footage', change };
  return { kind: (s.palette[0]?.share ?? 0) >= FLAT_SHARE ? 'colour' : 'picture', change };
};

const cameraText = (c: CameraMeasure): string => {
  if (c.kind !== 'move') return c.kind === 'unknown' ? '' : 'camera ' + (c.kind === 'static' ? 'still' : c.kind);
  const parts: string[] = [];
  if (Math.abs(c.zoomPerS) >= 0.005) parts.push((c.zoomPerS > 0 ? 'push ' : 'pull ') + (Math.abs(c.zoomPerS) * 100).toFixed(1) + '%/s');
  const [px, py] = c.panPerS;
  if (Math.hypot(px, py) >= 0.005) parts.push('pan ' + (Math.abs(px) >= Math.abs(py) ? (px > 0 ? 'right' : 'left') : py > 0 ? 'down' : 'up'));
  return parts.length ? 'camera ' + parts.join(', ') : 'camera still';
};

const noteOf = (s: ShotMeasure, kind: SourceKind, change: number): string => {
  const what = kind === 'footage' ? 'footage: the picture keeps changing (' + pct(change) + ' of it per tenth of a second)'
    : kind === 'colour' ? 'a flat colour (' + (s.palette[0]?.hex ?? s.background) + ' covers ' + pct(s.palette[0]?.share ?? 0) + ')'
    : 'a still picture (' + pct(change) + ' of it changes per tenth of a second)';
  return [what, cameraText(s.camera), s.events.length ? s.events.length + ' motion event' + (s.events.length === 1 ? '' : 's') : '', s.background ? 'ground ' + s.background : '']
    .filter(Boolean).join('; ');
};

const transitionOf = (b: Boundary | undefined, toFrames: (n: number) => number): TemplateTransition | undefined => {
  if (!b || b.kind === 'cut') return undefined;
  // retarget's conversion exactly: the measured span (frames strictly between the pure frames), at the canvas rate.
  return { transition: b.kind, frames: toFrames(b.end - b.start - 1), ...(b.direction ? { direction: b.direction } : {}), ...(b.mode ? { mode: b.mode } : {}), ...(b.via ? { via: b.via } : {}) };
};

/** The beats of a described reference (src/describe/beats.ts), in its own frames: what templateFrom, slots and the card share. */
export const sourceBeats = (m: Measure, text: TextTrack | undefined, transcript: Transcript | undefined, kinds?: readonly KindRange[]): ReferenceBeats =>
  referenceBeats({ ...(text ? { text } : {}), ...(transcript ? { transcript } : {}), total: m.source.frames, boundaries: m.boundaries.map((b) => b.frame), ...(kinds ? { kinds } : {}) });

/**
 * Where a caption line sits when the source showed none (every beat was only said): low in the frame, at an ordinary
 * size. Nothing is drawn there unless a fill's beat is shown; the band gives the lines a capacity.
 */
const UNSEEN_LINE = { centre: 0.85, size: 0.05 };

const withoutExamples = (h: CaptionHighlight): CaptionHighlight => {
  const { examples: _examples, ...rest } = h;
  return rest;
};

const captionsOf = (m: Measure, read: ReferenceBeats, toFrames: (n: number) => number, total: number): TemplateCaptions | undefined => {
  if (!read.beats.length) return undefined;
  // What was behind the source's caption letters (a plate, an outline, plain letters): the band's style follows it, and
  // so does the colour of the words a fill marks (its highlight). The highlight's examples are the source's own words,
  // which a template keeps apart (reference-text.json), so they stay out.
  const measured = read.text?.captionLook;
  const look = measured?.highlight?.examples ? { ...measured, highlight: withoutExamples(measured.highlight) } : measured;
  const placed = read.captions.length ? read.captions : [{ text: '', start: 0, end: 1, box: [0.08, UNSEEN_LINE.centre, 0.84, 0] as Box, role: 'caption' as const, size: UNSEEN_LINE.size, samples: 1, confidence: 1 }];
  // The band is whatever retarget makes of these cues: asked with one shown beat and a line for it.
  const probe = retarget({ measure: m, text: { step: 1, sampled: 0, cues: placed, ...(look ? { captionLook: look } : {}) }, beats: [{ start: 0, end: 1 }], plan: { shots: m.shots.map(() => ({ color: '#000000' })), captions: ['x'] } });
  const band = probe.project?.tracks.find((t): t is CaptionTrack => t.type === 'caption');
  if (!band || typeof band.style !== 'object') return undefined;
  return {
    box: band.box,
    style: band.style as TextStyle,
    line: { centre: median(placed.map((c) => c.box[1] + c.box[3] / 2)), size: median(placed.map((c) => c.size)) },
    beats: read.beats.map((b) => ({ start: toFrames(b.start), end: Math.min(toFrames(b.end), total), ...(b.shown ? {} : { shown: false as const }), ...(b.speech ? { speech: b.speech } : {}) })),
    script: scriptOf(read.captions.length ? read.captions.map((c) => c.text).join('') : read.beats.map((b) => b.text).join('')),
    ...(look ? { look } : {}),
  };
};

/** The template of a measured reference (and its on-screen text and speech, and the frame around its content, when they were read). */
export const templateFrom = (o: { measure: Measure; text?: TextTrack; transcript?: Transcript; inset?: Inset; name: string; label: string; hash: string; kinds?: readonly KindRange[] }): Template => {
  const m = o.measure;
  const fps = projectFps(m.source.fps);
  const ratio = fps / m.source.fps;
  const toFrames = (n: number): number => Math.round(n * ratio);
  const total = toFrames(m.source.frames);
  const starts = m.shots.map((s) => toFrames(s.start));
  const read = sourceBeats(m, o.text, o.transcript, o.kinds);
  // Where the source laid words over each shot, on the template's clock from the shot's start.
  const places = titlePlaces(m, read.text);
  const shots = m.shots.map((s, k): TemplateShot => {
    const { kind, change } = sourceKindOf(s, m);
    const into = transitionOf(k > 0 ? m.boundaries[k - 1] : undefined, toFrames);
    const moving = s.camera.kind === 'move' ? { camera: { zoom: r4(s.camera.zoomPerS), pan: [r4(s.camera.panPerS[0]), r4(s.camera.panPerS[1])] as [number, number] } } : {};
    // The text with the roles describe gave it (undefined without a reader: then its facts are unknown).
    const looks = shotLooks(s, read.text?.cues, read.text?.step);
    const aim = cameraAim(s, m.source.fps);
    const words = (places[k] ?? []).map(({ place: p }): WordPlace => ({ box: p.box, size: p.size, from: toFrames(s.start + p.from) - (starts[k] ?? 0), to: toFrames(s.start + p.to) - (starts[k] ?? 0) }));
    return { frames: Math.max(1, (starts[k + 1] ?? total) - (starts[k] ?? 0)), ...(into ? { in: into } : {}), source: kind, note: noteOf(s, kind, change), ...moving, ...(aim ? { aim } : {}), ...(looks ? { looks } : {}), ...(typeof s.fill === 'number' ? { fill: s.fill } : {}), ...(words.length ? { words } : {}) };
  });
  const captions = captionsOf(m, read, toFrames, total);
  const bar = barPlaces(m, read.text);
  return {
    format: TEMPLATE_FORMAT, version: TEMPLATE_VERSION, name: o.name, source: { label: o.label, measure: o.hash },
    canvas: { width: even(m.source.width), height: even(m.source.height), fps },
    frames: shots.reduce((n, s) => n + s.frames, 0), shots, ...(captions ? { captions } : {}), ...(o.inset ? { inset: o.inset } : {}),
    ...(bar ? { bar: { places: bar.places, marked: bar.marked } } : {}),
  };
};

/** Where each shot starts on the template's clock. */
export const startsOf = (t: Template): number[] => {
  const out: number[] = [];
  let at = 0;
  for (const s of t.shots) {
    out.push(at);
    at += s.frames;
  }
  return out;
};

/** Where the last shot ends: the shots' own lengths, as startsOf counts them. */
const endOf = (t: Template): number => t.shots.reduce((n, s) => n + s.frames, 0);

/**
 * Where each shot starts in a fill: the template's starts, except that the cut into a shot whose change is an effect
 * of its own (TemplateShot.effect) moves so that the scene drawing it covers the whole effect: back to the effect's
 * first frame when the shot's own scene draws it, on to the frame after its last when the scene of the shot before
 * runs on over it. Every shot keeps a frame at least.
 */
export const fillStarts = (t: Template): number[] => {
  const starts = startsOf(t);
  const total = endOf(t);
  const out: number[] = [];
  starts.forEach((S, k) => {
    const e = t.shots[k]?.effect;
    const moved = !e || k === 0 ? S : e.by === 'this' ? S - Math.floor(e.frames / 2) : S + Math.ceil(e.frames / 2);
    const lo = k === 0 ? 0 : (out[k - 1] ?? 0) + 1, hi = (starts[k + 1] ?? total) - 1;
    out.push(k === 0 ? 0 : Math.max(lo, Math.min(hi, moved)));
  });
  return out;
};

/** The shots' lengths in a fill (fillStarts). */
export const fillLengths = (t: Template): number[] => {
  const starts = fillStarts(t);
  const total = endOf(t);
  return starts.map((s, k) => Math.max(1, (starts[k + 1] ?? total) - s));
};

const STILL: CameraMeasure = { kind: 'static', zoomPerS: 0, panPerS: [0, 0], confidence: 1 };
const cameraOf = (s: TemplateShot): CameraMeasure =>
  s.camera ? { kind: 'move', zoomPerS: s.camera.zoom ?? 0, panPerS: s.camera.pan ?? [0, 0], confidence: 1 } : STILL;

/** A boundary at frame S as a perfect measurement of a transition of F frames reads it (types.ts header); F < 2 is a cut. */
const boundaryAt = (S: number, spec: TemplateTransition | undefined, frames: number): Boundary => {
  if (!spec || spec.transition === 'cut' || frames < 2) return { frame: S, kind: 'cut', start: S - 1, end: S, confidence: 1 };
  const a = S - Math.floor(frames / 2);
  return { frame: S, kind: spec.transition, start: a - 1, end: a + frames, ...(spec.direction ? { direction: spec.direction } : {}), ...(spec.mode ? { mode: spec.mode } : {}), ...(spec.via ? { via: spec.via } : {}), confidence: 1 };
};

/** Frames of the transition into shot k as a fill gets it: retarget's rule (at least 2, at most the shorter shot). */
export const transitionFrames = (spec: TemplateTransition | undefined, room: number): number =>
  !spec || spec.transition === 'cut' ? 0 : Math.min(Math.max(2, spec.frames ?? 0), room);

const measureOf = (t: Template, starts: number[], total: number, boundaries: Boundary[]): Measure => ({
  version: 1,
  source: { width: t.canvas.width, height: t.canvas.height, fps: t.canvas.fps, frames: total, duration: total / t.canvas.fps, hasAudio: false },
  boundaries,
  shots: t.shots.map((s, k) => ({ index: k, start: starts[k] ?? 0, end: starts[k + 1] ?? total, camera: cameraOf(s), background: '', palette: [], events: [] })),
  rhythm: { step: 1, change: [] },
  signature: { every: 1, width: 0, height: 0, count: 0, data: '' },
});

/**
 * The inputs retarget takes, rebuilt from the template. The measurement has the template's shots and its transitions
 * at their measured length (retarget limits them by the shots around them, as it does for a reference). The beats are
 * given as they are; the caption cues are the shown beats, each a line of zero height at the source's median centre
 * with the source's median size, so that retarget derives exactly the band it derived from the reference. The places
 * of laid-on words are title cues without words, each inside its shot, so that retarget finds the same places.
 */
export const retargetInputs = (t: Template): { measure: Measure; text?: TextTrack; beats?: { start: number; end: number; shown: boolean; speech?: 'on-camera' }[] } => {
  const starts = startsOf(t);
  // An effect of its own is a cut where the scene that draws it covers it (fillStarts); "in" is absent there.
  const cuts = fillStarts(t);
  const boundaries = t.shots.slice(1).map((s, j) => boundaryAt(cuts[j + 1] ?? 0, s.in, s.in?.frames ?? 0));
  const measure = measureOf(t, cuts, t.frames, boundaries);
  const titles: TextCue[] = [
    ...t.shots.flatMap((s, k) => (s.words ?? []).map((p): TextCue => ({ text: '', start: (starts[k] ?? 0) + p.from, end: (starts[k] ?? 0) + p.to, box: p.box, role: 'title', size: p.size, samples: 1, confidence: 1 }))),
    // The bar's words through the video, each marked on the shots that mark it.
    ...(t.bar?.places ?? []).map((p, j): TextCue => ({
      text: '', start: 0, end: t.frames, box: p.box, role: 'label', size: p.size, samples: 1, confidence: 1,
      bar: { row: 0, at: j, of: t.bar?.places.length ?? 0, highlighted: (t.bar?.marked ?? []).flatMap((m, k): [number, number][] => (m === j ? [[starts[k] ?? 0, starts[k + 1] ?? t.frames]] : [])) },
    })),
  ];
  const c = t.captions;
  if (!c) return titles.length ? { measure, text: { step: 1, sampled: 0, cues: titles }, beats: [] } : { measure };
  const box: Box = [0.08, c.line.centre, 0.84, 0];
  const cues: TextCue[] = c.beats.filter((b) => b.shown !== false).map((b) => ({ text: '', start: b.start, end: b.end, box, role: 'caption', size: c.line.size, samples: 1, confidence: 1 }));
  return { measure, text: { step: 1, sampled: 0, cues: [...cues, ...titles], ...(c.look ? { captionLook: c.look } : {}) }, beats: c.beats.map((b) => ({ start: b.start, end: b.end, shown: b.shown !== false, ...(b.speech ? { speech: b.speech } : {}) })) };
};

/**
 * The template's own structure as a perfect measurement would read a render of a fill: the shots and transitions the
 * template says, on the clock the fill ends up with (clock.map moves a template frame, as the speech re-flow does).
 */
export const structureMeasure = (t: Template, clock?: { map: (frame: number) => number; total: number }): Measure => {
  const total = clock ? clock.total : t.frames;
  const starts = fillStarts(t).map((s) => (clock ? clock.map(s) : s));
  const lengths = starts.map((s, k) => Math.max(1, (starts[k + 1] ?? total) - s));
  const boundaries = t.shots.slice(1).map((s, j) => boundaryAt(starts[j + 1] ?? 0, s.in, transitionFrames(s.in, Math.min(lengths[j] ?? 1, lengths[j + 1] ?? 1))));
  return measureOf(t, starts, total, boundaries);
};

/** Frames a footage fill of shot k must supply from its "in" at speed 1: the shot, and the part of the transition out of it in which it is still seen. */
export const footageNeed = (t: Template, k: number, lengths: number[] = fillLengths(t)): number => {
  const next = t.shots[k + 1];
  const out = transitionFrames(next?.in, Math.min(lengths[k] ?? 1, lengths[k + 1] ?? 1));
  return (lengths[k] ?? 1) + Math.ceil(out / 2);
};

type TextItem = Extract<Track, { type: 'text' }>;
const isText = (t: Track): t is TextItem => t.type === 'text';
const bandOf = (t: Template, item: TextItem | undefined): Band | undefined =>
  item && typeof item.style === 'object' ? { canvas: t.canvas, box: item.box, style: item.style } : undefined;

/**
 * How a card fill is laid out on this template's canvas, asked of retarget itself: a card with a dozen lines in the
 * first shot long enough for one. Returns the box and style of its title and of a line, and how many lines stay on
 * the canvas; undefined when retarget makes no cards.
 */
export const cardLayout = (t: Template): { title: Band; line: Band; lines: number } | undefined => {
  const k = t.shots.findIndex((s) => s.frames >= CARD_MIN_SECONDS * t.canvas.fps);
  if (k < 0) return undefined;
  const card = { card: { title: 'x', lines: Array.from({ length: 12 }, () => 'x') } } as unknown as ShotFill;
  const r = retarget({ measure: retargetInputs(t).measure, plan: { shots: t.shots.map((_s, j) => (j === k ? card : { color: '#000000' })) } });
  const texts = (r.project?.tracks ?? []).filter(isText);
  const lines = texts.filter((x) => /-line\d+$/.test(x.id));
  const title = bandOf(t, texts.find((x) => x.id.endsWith('-title')));
  const line = bandOf(t, lines[0]);
  return title && line ? { title, line, lines: lines.filter((x) => x.box[1] >= 0 && x.box[1] + x.box[3] <= 1 + 1e-6).length } : undefined;
};
