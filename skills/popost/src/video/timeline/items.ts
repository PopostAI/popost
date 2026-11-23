/**
 * Project tracks -> resolved items: visual tracks one each, caption tracks one text item per cue ("<track id>#<n>"),
 * every default filled in, in drawing order. Shared by resolve.
 */
import type {
  CaptionTrack, ItemLook, Material, MotionSpec, ResolvedItem, ResolvedMotion, Span, VisualTrack,
} from '../types';
import { MOTION_DEFAULTS, motionFrames } from '../presets/motion';
import { fullShadow, quoteFamilies, textStyle, type FullTextStyle } from '../presets/text-styles';
import { fillColor, isGradient } from '../presets/fill';
import { LOOP_DEFAULTS } from '../presets/loop';
import type { SpanFrames, Timeline } from './spans';
import { pickWords, placeSpan, type TrackWords } from './words';
import { cueWords } from './cue-words';

export interface ItemCtx {
  tl: Timeline;
  materials: ReadonlyMap<string, Material>;
  fps: number;
  src: (m: Material | undefined) => string;
  /** Ids of the font materials, quoted where a style names them. */
  fonts: ReadonlySet<string>;
  /** The words of every audio track that has them (timeline/words.ts), for phrase spans and captions that follow them. */
  words: readonly TrackWords[];
}

/** Frames of a span (a segment's or a phrase's); throws naming what could not be placed. */
const placeOf = (ctx: ItemCtx, span: Span, what: string): SpanFrames => {
  const frames = placeSpan(ctx.tl, ctx.words, span);
  if (frames) return frames;
  if (span.phrase === undefined) throw new Error('resolve: ' + what + ' is placed in segment "' + (span.segment ?? '') + '", which does not exist.');
  throw new Error('resolve: ' + what + ' is anchored to the phrase "' + span.phrase + '", but the words it is in were not read. buildPage reads them; a direct caller passes them: ' +
    'resolve(project, footage, { "<audio material id>": <its words file> }).');
};

/** A style without "spoken", for text that follows no words (check warns that it has no effect). */
const withoutSpoken = (s: FullTextStyle): FullTextStyle =>
  (s.spoken === undefined ? s : (Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'spoken')) as FullTextStyle));

const styleOf = (ctx: ItemCtx, style: Parameters<typeof textStyle>[0]): FullTextStyle => {
  const s = textStyle(style);
  return ctx.fonts.size === 0 ? s : { ...s, font: quoteFamilies(s.font, ctx.fonts) };
};

/** An item's shadow when it gives only some values, as fractions of the canvas' smaller side. */
export const ITEM_SHADOW_DEFAULTS = { blur: 0.02, x: 0.006, y: 0.01 } as const;

export const resolveMotion = (m: MotionSpec | undefined, phase: 'enter' | 'exit', fps: number): ResolvedMotion => {
  const preset = m?.preset ?? 'none';
  const d = MOTION_DEFAULTS[preset];
  return {
    preset,
    frames: preset === 'none' ? 0 : (m?.frames ?? motionFrames(preset, fps)),
    ease: m?.ease ?? d.ease[phase],
    overshoot: m?.overshoot ?? d.overshoot,
    direction: m?.direction ?? d.direction,
    distance: m?.distance ?? d.distance,
  };
};

/** rotate, opacity, border, shadow and loop, written only when they differ from the default. */
const lookOf = (t: ItemLook): Partial<ResolvedItem> => ({
  ...(t.rotate ? { rotate: t.rotate } : {}),
  ...(t.opacity !== undefined && t.opacity !== 1 ? { opacity: t.opacity } : {}),
  ...(t.border && t.border.width > 0 ? { border: t.border } : {}),
  ...(t.shadow ? { shadow: fullShadow(t.shadow, ITEM_SHADOW_DEFAULTS) } : {}),
  ...(t.loop ? { loop: { preset: t.loop.preset, period: t.loop.period, amount: t.loop.amount ?? LOOP_DEFAULTS[t.loop.preset] } } : {}),
});

const playOf = (t: { in?: number; speed?: number }, id: string, start: number) => ({ material: id, start, in: t.in ?? 0, speed: t.speed ?? 1 });

const itemContent = (ctx: ItemCtx, t: VisualTrack, start: number): Partial<ResolvedItem> => {
  switch (t.type) {
    case 'text':
      return { text: t.text, style: withoutSpoken(styleOf(ctx, t.style)) };
    case 'image':
      return { src: ctx.src(ctx.materials.get(t.material)), fit: t.fit ?? 'contain', radius: t.radius ?? 0, ...(t.mask ? { mask: t.mask } : {}) };
    case 'shape':
      return { shape: t.shape, color: fillColor(t.color), ...(isGradient(t.color) ? { gradient: t.color } : {}), radius: t.radius ?? 0 };
    case 'video':
      return { play: playOf(t, t.material, start), fit: t.fit ?? 'contain', radius: t.radius ?? 0, ...(t.mask ? { mask: t.mask } : {}) };
  }
};

const visualItem = (ctx: ItemCtx, t: VisualTrack): Omit<ResolvedItem, 'z'> => {
  const span = placeOf(ctx, t.during, 'item "' + t.id + '"');
  return {
    id: t.id,
    type: t.type,
    start: span.start,
    end: span.end,
    box: t.box,
    enter: resolveMotion(t.enter, 'enter', ctx.fps),
    exit: resolveMotion(t.exit, 'exit', ctx.fps),
    ...itemContent(ctx, t, span.start),
    ...lookOf(t),
  };
};

/** The words a caption track follows, or undefined when it follows none; throws when they were not read. */
const followed = (ctx: ItemCtx, t: CaptionTrack): TrackWords['tokens'] => {
  if (t.words === undefined || t.words === false) return undefined;
  const tokens = pickWords(ctx.words, t.words)?.tokens;
  if (!tokens) throw new Error('resolve: caption track "' + t.id + '" follows the words, but they were not read. buildPage reads them; a direct caller passes them: resolve(project, footage, { "<audio material id>": <its words file> }).');
  return tokens;
};

/**
 * One text item per cue, with the track's box, style, entrance and exit; a cue's spans replace the style's. A track
 * that follows the words gives each cue its tokens (timeline/cue-words.ts); with reveal 'words' a 'type' entrance is
 * replaced by the words.
 */
const cueItems = (ctx: ItemCtx, t: CaptionTrack): Omit<ResolvedItem, 'z'>[] => {
  const tokens = followed(ctx, t);
  const full = styleOf(ctx, t.style);
  const style = tokens ? full : withoutSpoken(full);
  const reveal = tokens !== undefined && t.reveal === 'words';
  const enter = resolveMotion(reveal && t.enter?.preset === 'type' ? undefined : t.enter, 'enter', ctx.fps);
  const exit = resolveMotion(t.exit, 'exit', ctx.fps);
  return t.cues.map((cue, index) => {
    const span = placeOf(ctx, cue.during, 'cue ' + index + ' of caption track "' + t.id + '"');
    const item: Omit<ResolvedItem, 'z'> = {
      id: t.id + '#' + index, type: 'text', start: span.start, end: span.end, box: t.box, enter, exit,
      text: cue.text, style: cue.spans ? { ...style, spans: cue.spans } : style, cue: { track: t.id, index },
    };
    if (!tokens) return item;
    return { ...item, words: cueWords(cue.text, span.start, span.end, tokens).words, ...(reveal ? { reveal: 'words' as const } : {}) };
  });
};

/** Items in drawing order (z, then file order, then cue order); the resolved z is the rank, 0 = farthest. */
export const resolveItems = (ctx: ItemCtx, tracks: readonly (VisualTrack | CaptionTrack | { type: 'audio' })[]): ResolvedItem[] =>
  tracks
    .flatMap((t, i) => {
      if (t.type === 'audio') return [];
      const items = t.type === 'caption' ? cueItems(ctx, t) : [visualItem(ctx, t)];
      return items.map((item, j) => ({ item, key: t.z ?? i, i, j }));
    })
    .sort((a, b) => a.key - b.key || a.i - b.i || a.j - b.j)
    .map((x, rank): ResolvedItem => ({ ...x.item, z: rank }));
