/**
 * The zod schema of video.json (types.ts Project). parseProject turns schema errors into Problems; unknown fields
 * become warnings (they are ignored), so a project written for a later version still parses.
 */
import { z } from 'zod';
import { LOOP_PRESETS, MOTION_PRESETS, TRANSITION_KINDS } from '../types';
import type { Base, CameraSpec, Problem, Project } from '../types';
import { TEXT_STYLE_NAMES } from '../presets/text-styles';
import { issueProblems, unknownKeyProblems, type KeyTable } from './issues';

const NAMED_COLORS = ['transparent', 'black', 'white', 'red', 'green', 'blue', 'yellow', 'orange', 'purple', 'pink', 'gray', 'grey'];
const COLOR_RE = /^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(rgb|rgba|hsl|hsla)\([^()]*\))$/i;
export const isColor = (s: string): boolean => COLOR_RE.test(s.trim()) || NAMED_COLORS.includes(s.trim().toLowerCase());

const color = z.string().refine(isColor, {
  error: 'is not a colour this engine reads',
  params: { allowed: ['#rrggbb', '#rgb', '#rrggbbaa', 'rgb(r, g, b)', 'rgba(r, g, b, a)', ...NAMED_COLORS], fix: 'Write the colour as hex, for example "#ffffff".' },
});
const id = z.string().min(1).max(64).regex(/^\S+$/, { error: 'must not contain spaces' });
const fraction = z.number().min(0).max(1);
const ease = z.enum(['linear', 'in', 'out', 'in-out']);
const direction = z.enum(['left', 'right', 'up', 'down']);
const pair = z.tuple([z.number().min(-1).max(1), z.number().min(-1).max(1)]);

export const GradientSchema = z.object({
  type: z.enum(['linear', 'radial']),
  angle: z.number().min(-360).max(360).optional(),
  stops: z.array(z.object({ at: fraction, color })).min(2).max(16),
});
/** A colour or a gradient (types.ts Fill). */
const fill = z.union([color, GradientSchema]);

/** A shadow; the limits are in the unit of its context (the font size, or the canvas' smaller side). */
const shadowSchema = (blur: number, offset: number) => z.object({
  color,
  blur: z.number().min(0).max(blur).optional(),
  x: z.number().min(-offset).max(offset).optional(),
  y: z.number().min(-offset).max(offset).optional(),
});

export const CanvasSchema = z.object({
  width: z.number().int().min(16).max(8192),
  height: z.number().int().min(16).max(8192),
  fps: z.number().int().min(1).max(120),
});

export const MaterialSchema = z.object({
  id,
  kind: z.enum(['image', 'video', 'audio', 'font', 'voice', 'speech']),
  file: z.string().min(1).optional(),
  prompt: z.string().optional(),
  note: z.string().optional(),
  words: z.string().min(1).optional(),
});

export const TransitionSchema = z.object({
  transition: z.enum(TRANSITION_KINDS),
  frames: z.number().int().min(1).max(600).optional(),
  direction: z.enum(['left', 'right', 'up', 'down', 'center-out', 'edges-in']).optional(),
  mode: z.enum(['push', 'cover', 'reveal']).optional(),
  via: z.enum(['black', 'white']).optional(),
  ease: ease.optional(),
  side: z.enum(['both', 'after', 'before']).optional(),
  strength: z.number().min(0).max(2).optional(),
});

/** Scales below 1 parse; check refuses them with a fix (an edge would show). */
export const CameraMoveSchema = z.object({
  from: z.number().int().min(0),
  to: z.number().int().min(1),
  scale: z.tuple([z.number().gt(0).max(20), z.number().gt(0).max(20)]),
  focus: z.tuple([fraction, fraction]).optional(),
  shift: z.tuple([pair, pair]).optional(),
  ease: ease.optional(),
});

/** Both camera forms in one object, so that unknown fields are found; the refine keeps them apart. */
export const CameraObjectSchema = z.object({
  zoom: z.number().min(-1).max(1).optional(),
  pan: pair.optional(),
  moves: z.array(CameraMoveSchema).min(1).max(64).optional(),
});
const CameraSchema = CameraObjectSchema.refine((c) => c.moves === undefined || (c.zoom === undefined && c.pan === undefined), {
  error: 'has rates (zoom, pan) and moves together; a camera is one or the other',
  params: { allowed: ['zoom', 'pan', 'moves'], fix: 'Keep "moves" and remove "zoom" and "pan", or the other way round.' },
}).transform((c): CameraSpec => (c.moves ? { moves: c.moves } : { ...(c.zoom !== undefined ? { zoom: c.zoom } : {}), ...(c.pan ? { pan: c.pan } : {}) }));

/** in / speed / audio of a video material (types.ts FootageSpec). */
const footage = {
  in: z.number().int().min(0).optional(),
  speed: z.number().min(0.25).max(4).optional(),
  audio: z.custom<false | number>((v) => v === false || (typeof v === 'number' && v >= -60 && v <= 24), {
    error: 'must be false (no sound) or a gain in dB from -60 to 24',
    params: { allowed: ['false', '-60 .. 24'], fix: 'Write "audio": 0 for the footage\'s own level, false for none, or remove "audio": the footage then sounds only in a project with no audio track.' },
  }).optional(),
};

/** One flat object with exactly one of material / color / scene, turned into the Base union. */
export const BaseObjectSchema = z.object({
  material: id.optional(),
  fit: z.enum(['cover', 'contain']).optional(),
  ground: fill.optional(),
  camera: CameraSchema.optional(),
  ...footage,
  color: fill.optional(),
  scene: z.string().min(1).optional(),
  slots: z.record(z.string(), z.string()).optional(),
  offset: z.number().min(0).optional(),
});
const FOOTAGE_KEYS = ['in', 'speed', 'audio'] as const;
const BaseSchema = BaseObjectSchema.refine(
  (b) => [b.material, b.color, b.scene].filter((v) => v !== undefined).length === 1,
  { error: 'needs exactly one of "material", "color" and "scene"', params: { allowed: ['material', 'color', 'scene'], fix: 'Write { "color": "#101014" } or { "material": "<image material id>" }.' } },
).transform((b): Base => {
  if (b.material !== undefined) {
    const play = { ...(b.in !== undefined ? { in: b.in } : {}), ...(b.speed !== undefined ? { speed: b.speed } : {}), ...(b.audio !== undefined ? { audio: b.audio } : {}) };
    return { material: b.material, ...(b.fit ? { fit: b.fit } : {}), ...(b.ground !== undefined ? { ground: b.ground } : {}), ...(b.camera ? { camera: b.camera } : {}), ...play };
  }
  if (b.color !== undefined) return { color: b.color };
  return { scene: b.scene ?? '', ...(b.slots ? { slots: b.slots } : {}), ...(b.offset !== undefined ? { offset: b.offset } : {}) };
});

export const SegmentSchema = z.object({
  id,
  frames: z.number().int().optional(),
  base: BaseSchema,
  in: TransitionSchema.optional(),
  note: z.string().optional(),
});

export const MotionSchema = z.object({
  preset: z.enum(MOTION_PRESETS),
  frames: z.number().int().min(0).max(600).optional(),
  ease: ease.optional(),
  overshoot: fraction.optional(),
  direction: direction.optional(),
  distance: z.number().min(0).max(2).optional(),
});

/** lead and hold: at most a minute at 120 fps either way. */
const SHIFT = 7200;
export const SpanObjectSchema = z.object({
  segment: id.optional(),
  from: z.number().int().optional(),
  to: z.number().int().optional(),
  phrase: z.string().min(1).optional(),
  occurrence: z.number().int().min(1).optional(),
  of: id.optional(),
  lead: z.number().int().min(-SHIFT).max(SHIFT).optional(),
  hold: z.number().int().min(-SHIFT).max(SHIFT).optional(),
});
/** A span is placed by a segment or by a phrase; check reports the rest (from / to on a phrase span, a missing words file). */
export const SpanSchema = SpanObjectSchema.refine((s) => s.segment !== undefined || s.phrase !== undefined, {
  error: 'needs "segment" (frames counted from a segment\'s start) or "phrase" (the words of a sound)',
  params: { allowed: ['segment', 'phrase'], fix: 'Add "segment": "<segment id>", or "phrase": "<words of the script>" when an audio track has a words file.' },
});

export const StrokeSchema = z.object({ color, width: z.number().min(0).max(1) });
export const BackgroundSchema = z.object({ color, padding: z.number().min(0).max(5).optional(), radius: z.number().min(0).max(5).optional() });
export const TextShadowSchema = shadowSchema(2, 2);
export const TextSpanSchema = z.object({
  from: z.number().int().min(0),
  to: z.number().int().min(1),
  color: color.optional(),
  weight: z.number().int().min(100).max(1000).optional(),
  background: BackgroundSchema.optional(),
  italic: z.boolean().optional(),
});
const textSpans = z.array(TextSpanSchema).max(200);
export const SpokenPastSchema = z.object({ color: color.optional(), opacity: fraction.optional() });
/** The look of the token being spoken (types.ts SpokenStyle); scale is a small pop, at most 1.3. */
export const SpokenSchema = z.object({
  color: color.optional(),
  background: BackgroundSchema.optional(),
  weight: z.number().int().min(100).max(1000).optional(),
  scale: z.number().min(1).max(1.3).optional(),
  past: SpokenPastSchema.optional(),
});
export const TextStyleSchema = z.object({
  font: z.string().min(1).optional(),
  size: z.number().gt(0).max(1).optional(),
  weight: z.number().int().min(100).max(1000).optional(),
  color: color.optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  stroke: StrokeSchema.optional(),
  background: BackgroundSchema.optional(),
  italic: z.boolean().optional(),
  shadow: TextShadowSchema.optional(),
  letterSpacing: z.number().min(-0.5).max(2).optional(),
  lineHeight: z.number().min(0.5).max(4).optional(),
  opacity: fraction.optional(),
  spans: textSpans.optional(),
  spoken: SpokenSchema.optional(),
});

export const BorderSchema = z.object({ color, width: z.number().min(0).max(0.5) });
export const ItemShadowSchema = shadowSchema(0.5, 0.5);
/** amount's range depends on the preset; check reports it. */
export const LoopSchema = z.object({ preset: z.enum(LOOP_PRESETS), period: z.number().int().min(2).max(36000), amount: z.number().optional() });

const box = z.tuple([z.number(), z.number(), z.number().gt(0), z.number().gt(0)]);
const itemCommon = {
  id,
  during: SpanSchema,
  box,
  enter: MotionSchema.optional(),
  exit: MotionSchema.optional(),
  sound: id.optional(),
  z: z.number().optional(),
  note: z.string().optional(),
  rotate: z.number().min(-3600).max(3600).optional(),
  opacity: fraction.optional(),
  border: BorderSchema.optional(),
  shadow: ItemShadowSchema.optional(),
  loop: LoopSchema.optional(),
};
const textStyle = z.union([z.enum(TEXT_STYLE_NAMES), TextStyleSchema]);
const mask = z.enum(['ellipse']);

export const TextTrackSchema = z.object({
  ...itemCommon,
  type: z.literal('text'),
  text: z.string().min(1),
  style: textStyle.optional(),
});
export const ImageTrackSchema = z.object({ ...itemCommon, type: z.literal('image'), material: id, fit: z.enum(['cover', 'contain']).optional(), radius: fraction.optional(), mask: mask.optional() });
export const ShapeTrackSchema = z.object({ ...itemCommon, type: z.literal('shape'), shape: z.enum(['rect', 'ellipse']), color: fill, radius: fraction.optional() });
export const VideoTrackSchema = z.object({ ...itemCommon, type: z.literal('video'), material: id, fit: z.enum(['cover', 'contain']).optional(), ...footage, radius: fraction.optional(), mask: mask.optional() });
export const AudioTrackSchema = z.object({
  id,
  type: z.literal('audio'),
  material: id,
  gain: z.number().min(-60).max(24).optional(),
  during: SpanSchema.optional(),
  note: z.string().optional(),
  bed: z.literal(true).optional(),
  in: z.number().int().min(0).optional(),
});
/** Empty cue text parses; check reports it with the cue's place. */
export const CueSchema = z.object({ text: z.string(), during: SpanSchema, spans: textSpans.optional(), note: z.string().optional() });
export const CaptionTrackSchema = z.object({
  id,
  type: z.literal('caption'),
  box,
  style: textStyle.optional(),
  enter: MotionSchema.optional(),
  exit: MotionSchema.optional(),
  z: z.number().optional(),
  cues: z.array(CueSchema).min(1).max(5000),
  words: z.union([id, z.boolean()]).optional(),
  reveal: z.enum(['words']).optional(),
  note: z.string().optional(),
});
const TrackSchema = z.discriminatedUnion('type', [TextTrackSchema, ImageTrackSchema, ShapeTrackSchema, VideoTrackSchema, AudioTrackSchema, CaptionTrackSchema]);

export const ProjectSchema = z.object({
  version: z.literal(1),
  canvas: CanvasSchema,
  language: z.string().optional(),
  materials: z.array(MaterialSchema).default([]),
  segments: z.array(SegmentSchema).min(1),
  tracks: z.array(TrackSchema).default([]),
  note: z.string().optional(),
});

const keys = (s: { shape: Record<string, unknown> }): string[] => Object.keys(s.shape);
const KEY_TABLE: KeyTable = {
  root: keys(ProjectSchema),
  canvas: keys(CanvasSchema),
  material: keys(MaterialSchema),
  segment: keys(SegmentSchema),
  transition: keys(TransitionSchema),
  camera: keys(CameraObjectSchema),
  move: keys(CameraMoveSchema),
  gradient: keys(GradientSchema),
  stop: ['at', 'color'],
  base: { material: ['material', 'fit', 'ground', 'camera', ...FOOTAGE_KEYS], color: ['color'], scene: ['scene', 'slots', 'offset'] },
  motion: keys(MotionSchema),
  span: keys(SpanObjectSchema),
  style: keys(TextStyleSchema),
  stroke: keys(StrokeSchema),
  background: keys(BackgroundSchema),
  shadow: keys(ItemShadowSchema),
  textSpan: keys(TextSpanSchema),
  border: keys(BorderSchema),
  loop: keys(LoopSchema),
  cue: keys(CueSchema),
  spoken: keys(SpokenSchema),
  past: keys(SpokenPastSchema),
  tracks: { text: keys(TextTrackSchema), image: keys(ImageTrackSchema), shape: keys(ShapeTrackSchema), video: keys(VideoTrackSchema), audio: keys(AudioTrackSchema), caption: keys(CaptionTrackSchema) },
};

// Compile-time proof that what the schema outputs is a Project.
const asProject = (p: z.output<typeof ProjectSchema>): Project => p;

/**
 * Parses a video.json value. Errors mean no project; warnings (unknown fields, which are ignored) come with it.
 */
export const parseProject = (json: unknown): { project?: Project; problems: Problem[] } => {
  const result = ProjectSchema.safeParse(json, { reportInput: true });
  const warnings = unknownKeyProblems(json, KEY_TABLE);
  if (!result.success) return { problems: [...issueProblems(result.error.issues), ...warnings] };
  return { project: asProject(result.data), problems: warnings };
};
