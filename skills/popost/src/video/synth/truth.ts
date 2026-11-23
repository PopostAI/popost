/**
 * What a perfect measurement of a project's render would say, worked out from the resolved timeline alone.
 * Used as the reference side of the synthetic round trip.
 */
import type { Boundary, CameraMeasure, Measure, MotionEvent, Resolved, ResolvedItem, ResolvedMotion, ShotMeasure } from '../types';

const HOW: Record<ResolvedMotion['preset'], MotionEvent['how']> = {
  none: 'instant', fade: 'fade', pop: 'scale', 'scale-in': 'scale', slide: 'slide', wipe: 'wipe', type: 'wipe', blur: 'fade',
};

const event = (item: ResolvedItem, phase: 'enter' | 'exit'): MotionEvent => {
  const m = phase === 'enter' ? item.enter : item.exit;
  const frames = m.preset === 'none' ? 1 : m.frames;
  // An item is on screen on frames start .. end-1. An animated exit plays on its last frames; an instant one shows
  // on the first frame without the item, which is frame "end".
  const start = phase === 'enter' ? item.start : m.preset === 'none' ? item.end : item.end - frames;
  const how = HOW[m.preset];
  // A typed line unfolds to the right whatever the spec says. Entering or leaving, the direction is the way the
  // element (slide) or the edge (wipe) travels, as in src/presets/motion.ts.
  const way = m.preset === 'type' ? 'right' : m.direction;
  const directed = how === 'slide' || how === 'wipe';
  return {
    start, end: start + frames, box: item.box, kind: phase === 'enter' ? 'appear' : 'disappear', how,
    ...(directed ? { direction: way } : {}),
    ease: m.preset === 'none' ? 'instant' : m.preset === 'type' ? 'linear' : m.ease,
    ...(m.preset === 'pop' ? { overshoot: m.overshoot } : {}),
    ...(item.color ? { colour: item.color } : item.style ? { colour: item.style.color } : {}),
    confidence: 1,
  };
};

export const truthBoundaries = (resolved: Resolved): Boundary[] =>
  resolved.segments.slice(1).map((s): Boundary => {
    const t = s.transition;
    if (!t) return { frame: s.start, kind: 'cut', start: s.start - 1, end: s.start, confidence: 1 };
    return {
      frame: t.boundary, kind: t.kind, start: t.a - 1, end: t.a + t.frames,
      ...(t.kind === 'wipe' || t.kind === 'slide' || t.kind === 'whip' ? { direction: t.direction } : {}),
      ...(t.kind === 'slide' ? { mode: t.mode } : {}),
      ...(t.kind === 'fade' ? { via: t.via } : {}),
      confidence: 1,
    };
  });

const camera = (segment: Resolved['segments'][number], fps: number): CameraMeasure => {
  const base = segment.base;
  if (base.kind === 'color' || base.kind === 'scene') return { kind: 'static', zoomPerS: 0, panPerS: [0, 0], confidence: 1 };
  if (base.moves?.length) {
    // Moves with keyframes: the mean rate over the shot, and each move in absolute frames (resolve() has already put
    // the segment's start into from and to: presets/camera.ts fullMove).
    const first = base.moves[0]?.scale[0] ?? 1, last = base.moves[base.moves.length - 1]?.scale[1] ?? 1;
    const seconds = (segment.end - segment.start) / fps;
    return {
      kind: 'move', zoomPerS: Math.round(((last / first - 1) / seconds) * 1e4) / 1e4, panPerS: [0, 0], confidence: 1,
      moves: base.moves.map((mv) => ({ start: mv.from, end: mv.to, scale: mv.scale, focus: mv.focus })),
    };
  }
  return base.zoom !== 0 || base.pan[0] !== 0 || base.pan[1] !== 0
    ? { kind: 'move', zoomPerS: base.zoom, panPerS: base.pan, confidence: 1 }
    : { kind: 'static', zoomPerS: 0, panPerS: [0, 0], confidence: 1 };
};

/** The shots, boundaries and motion events a render of this timeline contains. Rhythm and signature are left empty. */
export const truthMeasure = (resolved: Resolved): Measure => {
  const shots: ShotMeasure[] = resolved.segments.map((s) => ({
    index: s.index, start: s.start, end: s.end, camera: camera(s, resolved.canvas.fps),
    background: s.base.kind === 'color' ? s.base.color : '',
    palette: s.base.kind === 'color' ? [{ hex: s.base.color, share: 1 }] : [],
    events: [],
  }));
  const segmentEnds = new Set(resolved.segments.map((s) => s.end));
  for (const item of resolved.items) {
    for (const phase of ['enter', 'exit'] as const) {
      // An item that simply stops where a segment ends (or the video ends) goes with the cut or the transition:
      // there is no event of its own to see.
      if (phase === 'exit' && item.exit.preset === 'none' && segmentEnds.has(item.end)) continue;
      const ev = event(item, phase);
      const shot = shots.find((s) => ev.start >= s.start && ev.start < s.end);
      if (shot) shot.events.push(ev);
    }
  }
  for (const s of shots) s.events.sort((a, b) => a.start - b.start || a.box[1] - b.box[1]);
  const { width, height, fps } = resolved.canvas;
  return {
    version: 1,
    source: { width, height, fps, frames: resolved.frames, duration: resolved.frames / fps, hasAudio: resolved.audio.length > 0 },
    boundaries: truthBoundaries(resolved), shots,
    rhythm: { step: 1, change: [] },
    signature: { every: 1, width: 16, height: 16, count: 0, data: '' },
  };
};
