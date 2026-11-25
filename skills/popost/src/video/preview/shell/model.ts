/**
 * Pure helpers of the shell: frame arithmetic between the project and a measured file, labels, row packing and
 * lookups. No DOM, so they can be tested in Node.
 */
import type { Boundary, Box, Canvas, Measure, MotionEvent, Resolved, ResolvedItem, ResolvedMotion, ResolvedSegment, ResolvedTransition } from '../../types';
import type { PreviewState } from '../protocol';

export type Source = 'render' | 'reference';

export type Selection =
  | { kind: 'segment'; id: string }
  | { kind: 'slot'; id: string; name: string }
  | { kind: 'item'; id: string }
  | { kind: 'audio'; id: string }
  | { kind: 'boundary'; source: Source; index: number }
  | { kind: 'event'; source: Source; shot: number; index: number };

const DIRECTED = new Set(['wipe', 'slide', 'whip']);

/** Frame rate of the timeline: the project's, else the first measurement's. */
export const timelineFps = (s: PreviewState): number =>
  s.resolved?.canvas.fps ?? s.measure?.measure.source.fps ?? s.referenceMeasure?.measure.source.fps ?? 30;

/** A frame of a measured file (at its own rate) as a frame of the timeline; fractional, for drawing. */
export const toTimeline = (f: number, sourceFps: number, fps: number): number => (f * fps) / sourceFps;

/** The frame of a measured file shown at timeline frame n: the one under the middle of frame n. */
export const toSource = (n: number, fps: number, sourceFps: number): number => Math.floor(((n + 0.5) * sourceFps) / fps);

/** Length of the timeline in frames: the project's, else the longest measurement's. */
export const timelineFrames = (s: PreviewState): number => {
  if (s.resolved) return s.resolved.frames;
  const fps = timelineFps(s);
  const lengths = [s.measure, s.referenceMeasure].map((m) => (m ? Math.round(toTimeline(m.measure.source.frames, m.measure.source.fps, fps)) : 0));
  return Math.max(0, ...lengths);
};

export const clampFrame = (n: number, frames: number): number => Math.min(Math.max(0, frames - 1), Math.max(0, Math.round(n)));

export const segmentAt = (r: Resolved, n: number): ResolvedSegment | undefined => r.segments.find((s) => n >= s.start && n < s.end);

/** Items on screen at frame n (frames start .. end-1), nearest last. */
export const itemsAt = (r: Resolved, n: number): ResolvedItem[] => r.items.filter((i) => n >= i.start && n < i.end);

export const transitionLabel = (t: ResolvedTransition): string =>
  [t.kind, t.frames + 'f', DIRECTED.has(t.kind) ? t.direction : '', t.kind === 'slide' ? t.mode : '', t.kind === 'fade' ? 'via ' + t.via : '',
    t.side && t.side !== 'both' ? t.side : '', t.strength !== undefined && t.strength !== 1 ? 'x' + t.strength : ''].filter(Boolean).join(' ');

export const motionLabel = (m: ResolvedMotion): string =>
  m.preset + ' ' + m.frames + 'f' + (m.preset === 'slide' || m.preset === 'wipe' ? ' ' + m.direction : '');

export const boundaryLabel = (b: Boundary): string =>
  [b.kind, b.kind === 'cut' ? '' : b.end - b.start - 1 + 'f', b.direction ?? '', b.mode ?? '', b.via ? 'via ' + b.via : '', b.confidence.toFixed(2)].filter(Boolean).join(' ');

export const eventLabel = (e: MotionEvent): string => [e.kind, e.how ?? '', e.direction ?? ''].filter(Boolean).join(' ');

/** Every motion event of a measurement with its shot and index, in time order. */
export const allEvents = (m: Measure): { shot: number; index: number; event: MotionEvent }[] =>
  m.shots.flatMap((s, shot) => s.events.map((event, index) => ({ shot, index, event }))).sort((a, b) => a.event.start - b.event.start || a.shot - b.shot);

/** Events whose change runs at timeline frame n. */
export const eventsAt = (m: Measure, n: number, fps: number): MotionEvent[] => {
  const f = toSource(n, fps, m.source.fps);
  return m.shots.flatMap((s) => s.events.filter((e) => f >= e.start && f < e.end));
};

/**
 * Greedy rows for intervals (start .. end-1): each goes into the first row whose last interval ended before it.
 * Rows past maxRows are folded into the last row, so a crowded lane stays readable in height.
 */
export const packRows = <T>(spans: readonly { start: number; end: number; value: T }[], maxRows: number): { row: number; start: number; end: number; value: T }[] => {
  const ends: number[] = [];
  return spans.map((s) => {
    const free = ends.findIndex((e) => e <= s.start);
    const row = free >= 0 ? free : Math.min(ends.length, maxRows - 1);
    ends[row] = Math.max(ends[row] ?? 0, s.end);
    return { row, ...s };
  });
};

/** Second ticks of the ruler: a step from a fixed list so that there are at most about 12 labels. */
export const rulerTicks = (frames: number, fps: number): { frame: number; label: string }[] => {
  const seconds = frames / fps;
  const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => seconds / s <= 12) ?? 600;
  const count = Math.floor(seconds / step);
  return Array.from({ length: count + 1 }, (_, i) => ({ frame: Math.round(i * step * fps), label: String(Number((i * step).toFixed(1))) + 's' }));
};

/**
 * The guide drawn by the safe-area overlay. Portrait: what the short-video apps leave free of their captions and
 * buttons, about 8% at the top, 20% at the bottom, 6% on the left and 12% on the right (the column of buttons).
 * Landscape and square: the 5% title-safe margin of broadcast practice.
 */
export const safeArea = (c: Canvas): Box => (c.height > c.width ? [0.06, 0.08, 0.82, 0.72] : [0.05, 0.05, 0.9, 0.9]);

export const formatTime = (n: number, fps: number): string => (n / fps).toFixed(2) + ' s';

export const sameSelection = (a: Selection | null, b: Selection | null): boolean => JSON.stringify(a) === JSON.stringify(b);

const measureOf = (s: PreviewState, source: Source): Measure | undefined => (source === 'render' ? s.measure : s.referenceMeasure)?.measure;

/** The value a selection points at (resolved values for the project, measured values for a measurement). */
export const selectionValue = (s: PreviewState, sel: Selection): unknown => {
  switch (sel.kind) {
    case 'slot': return undefined;
    case 'segment': return s.resolved?.segments.find((x) => x.id === sel.id);
    case 'item': return s.resolved?.items.find((x) => x.id === sel.id);
    case 'audio': return s.resolved?.audio.find((x) => x.id === sel.id);
    case 'boundary': return measureOf(s, sel.source)?.boundaries[sel.index];
    case 'event': return measureOf(s, sel.source)?.shots[sel.shot]?.events[sel.index];
  }
};

/** A short title for a selection. */
export const selectionTitle = (sel: Selection): string => {
  switch (sel.kind) {
    case 'slot': return sel.name;
    case 'segment': case 'item': case 'audio': return sel.kind + ' ' + sel.id;
    case 'boundary': return sel.source + ' boundary ' + (sel.index + 1);
    case 'event': return sel.source + ' event ' + (sel.shot + 1) + '.' + (sel.index + 1);
  }
};
