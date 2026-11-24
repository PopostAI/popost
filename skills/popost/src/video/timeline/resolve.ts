/**
 * Project -> Resolved: absolute frames for segments, transitions, items and audio, every default filled in.
 * The frame conventions are those in the header of types.ts.
 */
import type {
  FootageFacts, FootageInfo, FootageSpec, Material, Project, Resolved, ResolvedAudio, ResolvedBase, ResolvedFootage, ResolvedItem,
  ResolvedPlay, ResolvedSegment, ResolvedTransition, Segment, TransitionSpec,
} from '../types';
import { checkProject, formatProblems } from '../project/check';
import { TRANSITION_DEFAULTS, transitionFrames } from '../presets/transition';
import { fillColor, isGradient } from '../presets/fill';
import { fullMove } from '../presets/camera';
import { spanFrames, timelineOf, wholeVideo, type Timeline } from './spans';
import { resolveItems } from './items';
import { trackWords, type TrackWords, type WordsTable } from './words';

export { resolveMotion } from './items';
export type { WordsTable } from './words';

/** What the build step read from each video material's file, by material id (types.ts FootageInfo). */
export type FootageTable = Readonly<Record<string, FootageInfo>>;

interface Ctx { project: Project; tl: Timeline; materials: ReadonlyMap<string, Material>; fps: number; footage: FootageTable }

/** A material's file as a URL path relative to the project directory ("assets/a.webp"). */
export const materialSrc = (m: Material | undefined): string => {
  if (!m?.file) throw new Error('resolve: material "' + (m?.id ?? '?') + '" has no file. Set "file" on the material.');
  return m.file.replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.').join('/');
};

const material = (ctx: Ctx, id: string): Material | undefined => ctx.materials.get(id);

const factsOf = (ctx: Ctx, id: string): FootageFacts => {
  const f = ctx.footage[id];
  if (!f || 'error' in f)
    throw new Error('resolve: video material "' + id + '" needs the frame rate and frame count of its file' + (f ? ' (' + f.error + ')' : '') +
      '. buildPage reads them with probe(); a direct caller passes them: resolve(project, { "' + id + '": { width, height, fps, frames, hasAudio } }).');
  return f;
};

const playOf = (spec: FootageSpec, id: string, start: number): ResolvedPlay => ({ material: id, start, in: spec.in ?? 0, speed: spec.speed ?? 1 });

export const resolveTransition = (spec: TransitionSpec | undefined, boundary: number, fps: number): ResolvedTransition | undefined => {
  if (!spec || spec.transition === 'cut') return undefined;
  const kind = spec.transition;
  const d = TRANSITION_DEFAULTS[kind];
  const frames = spec.frames ?? transitionFrames(kind, fps);
  const side = spec.side ?? 'both';
  // The span straddles the boundary, or lies wholly after it ('after') or before it ('before'): header of types.ts.
  const a = side === 'both' ? boundary - Math.floor(frames / 2) : side === 'after' ? boundary : boundary - frames;
  return {
    kind,
    a,
    frames,
    boundary,
    direction: spec.direction ?? d.direction,
    mode: spec.mode ?? d.mode,
    via: spec.via ?? d.via,
    // A one-sided effect settles ('after') or builds up ('before') by default.
    ease: spec.ease ?? (side === 'after' ? 'out' : side === 'before' ? 'in' : d.ease),
    side,
    strength: spec.strength ?? 1,
  };
};

const resolveBase = (ctx: Ctx, s: Segment, start: number): ResolvedBase => {
  if ('color' in s.base) return { kind: 'color', color: fillColor(s.base.color), ...(isGradient(s.base.color) ? { gradient: s.base.color } : {}) };
  if ('material' in s.base) {
    const m = material(ctx, s.base.material);
    const cam = s.base.camera;
    const rate = cam && !('moves' in cam) ? cam : {};
    const moves = cam && 'moves' in cam ? { moves: cam.moves.map((mv) => fullMove(mv, start)) } : {};
    const g = s.base.ground;
    const ground = g === undefined ? {} : { ground: { color: fillColor(g), ...(isGradient(g) ? { gradient: g } : {}) } };
    const view = { fit: s.base.fit ?? 'cover', ...ground, zoom: rate.zoom ?? 0, pan: rate.pan ?? [0, 0], ...moves } as const;
    if (m?.kind === 'video') return { kind: 'video', play: playOf(s.base, m.id, start), ...view };
    return { kind: 'image', src: materialSrc(m), ...view };
  }
  if (!('scene' in s.base)) throw new Error('resolve: segment "' + s.id + '" has no base.');
  return { kind: 'scene', src: s.base.scene.replace(/\\/g, '/'), ...(s.base.slots ? { slots: s.base.slots } : {}) };
};

const resolveSegment = (ctx: Ctx, s: Segment, k: number): ResolvedSegment => {
  const start = ctx.tl.starts[k] ?? 0;
  const transition = k === 0 ? undefined : resolveTransition(s.in, start, ctx.fps);
  return { id: s.id, index: k, start, end: start + (ctx.tl.lengths[k] ?? 0), base: resolveBase(ctx, s, start), ...(transition ? { transition } : {}) };
};

const resolveAudio = (ctx: Ctx, items: readonly ResolvedItem[]): ResolvedAudio[] => {
  const tracks = ctx.project.tracks.flatMap((t): ResolvedAudio[] => {
    if (t.type !== 'audio') return [];
    const span = t.during ? spanFrames(ctx.tl, t.during) : wholeVideo(ctx.tl);
    if (!span) throw new Error('resolve: audio "' + t.id + '" is placed in a segment that does not exist.');
    const from = t.bed ? { from: { frame: t.in ?? 0, fps: factsOf(ctx, t.material).fps } } : {};
    return [{ id: t.id, src: materialSrc(material(ctx, t.material)), start: span.start, ...(t.during ? { end: span.end } : {}), gain: t.gain ?? 0, ...from }];
  });
  const byId = new Map(items.map((it) => [it.id, it] as const));
  const sounds = ctx.project.tracks.flatMap((t): ResolvedAudio[] => {
    if (t.type === 'audio' || t.type === 'caption' || t.sound === undefined) return [];
    const item = byId.get(t.id);
    return item ? [{ id: t.id + '.sound', src: materialSrc(material(ctx, t.sound)), start: item.start, gain: 0 }] : [];
  });
  return [...tracks, ...sounds];
};

/**
 * The footage's own sound of every base and video item: at the gain its "audio" gives, never with false, and with
 * no "audio" at 0 dB when the project has no audio track (FootageSpec.audio). It plays at the footage's speed.
 */
const footageAudio = (ctx: Ctx, segments: readonly ResolvedSegment[], items: readonly ResolvedItem[]): ResolvedAudio[] => {
  const fromBases = segments.flatMap((s, k) => {
    const spec = ctx.project.segments[k]?.base;
    return s.base.kind === 'video' && spec && 'material' in spec ? [{ id: s.id, spec: spec as FootageSpec, play: s.base.play, end: s.end }] : [];
  });
  // A project with a sound of its own (a voice-over, music) keeps footage silent unless a use says otherwise.
  const ownSound = ctx.project.tracks.some((t) => t.type === 'audio' && !t.bed);
  // Under a bed (the sound of a clip running on under the shots cut from it) those shots do not sound a second time.
  const beds = ctx.project.tracks.flatMap((t) => { const s = t.type === 'audio' && t.bed ? (t.during ? spanFrames(ctx.tl, t.during) : wholeVideo(ctx.tl)) : undefined; return s ? [s] : []; });
  const bedded = (frame: number): boolean => beds.some((s) => frame >= s.start && frame < s.end);
  const byId = new Map(items.map((it) => [it.id, it] as const));
  const fromItems = ctx.project.tracks.flatMap((t) => {
    const it = byId.get(t.id);
    return t.type === 'video' && it?.play ? [{ id: t.id, spec: t as FootageSpec, play: it.play, end: it.end }] : [];
  });
  return [...fromBases, ...fromItems].flatMap((u): ResolvedAudio[] => {
    const gain = u.spec.audio ?? (ownSound || bedded(u.play.start) ? false : 0);
    const facts = factsOf(ctx, u.play.material);
    if (gain === false || !facts.hasAudio) return [];
    const src = materialSrc(material(ctx, u.play.material));
    return [{ id: u.id + '.audio', src, start: u.play.start, end: u.end, gain, from: { frame: u.play.in, fps: facts.fps }, ...(u.play.speed !== 1 ? { speed: u.play.speed } : {}) }];
  });
};

/** The video materials the timeline shows, with their source rate and length. */
const footageTable = (ctx: Ctx, segments: readonly ResolvedSegment[], items: readonly ResolvedItem[]): Record<string, ResolvedFootage> => {
  const ids = new Set([...segments.flatMap((s) => (s.base.kind === 'video' ? [s.base.play.material] : [])), ...items.flatMap((it) => (it.play ? [it.play.material] : []))]);
  return Object.fromEntries([...ids].map((id) => {
    const f = factsOf(ctx, id);
    return [id, { src: materialSrc(material(ctx, id)), fps: f.fps, frames: f.frames }] as const;
  }));
};

/** The words of the audio tracks on the timeline, for the preview. */
const wordsOut = (words: readonly TrackWords[]): NonNullable<Resolved['words']> =>
  words.flatMap((w) => (w.tokens ? [{ track: w.track, tokens: w.tokens.map((t) => ({ text: t.text, start: t.start, end: t.end, confidence: t.confidence })) }] : []));

/**
 * Resolves a project that passed check; throws an Error listing the problems of one that would not. footage: what
 * the build step read from each video material's file (needed when the project shows a video material). words: what
 * it read from each words file (needed for phrase spans and captions that follow the words; compile/words.ts). The
 * frame pictures' directory is not known here; the build step adds it (compile/footage.ts).
 */
export const resolve = (project: Project, footage: FootageTable = {}, words: WordsTable = {}): Resolved => {
  const errors = checkProject(project, { footage, words }).filter((p) => p.level === 'error');
  if (errors.length > 0) throw new Error('resolve: the project has ' + errors.length + ' error(s); fix them first (check lists them).\n' + formatProblems(errors));
  const ctx: Ctx = {
    project,
    tl: timelineOf(project),
    materials: new Map(project.materials.map((m) => [m.id, m] as const).reverse()),
    fps: project.canvas.fps,
    footage,
  };
  const fonts = new Set(project.materials.flatMap((m) => (m.kind === 'font' ? [m.id] : [])));
  const spoken = trackWords(project, ctx.tl, words);
  const items = resolveItems({ tl: ctx.tl, materials: ctx.materials, fps: ctx.fps, src: materialSrc, fonts, words: spoken }, project.tracks);
  const heard = wordsOut(spoken);
  const segments = project.segments.map((s, k) => resolveSegment(ctx, s, k));
  return {
    canvas: { ...project.canvas },
    frames: ctx.tl.total,
    segments,
    items,
    audio: [...resolveAudio(ctx, items), ...footageAudio(ctx, segments, items)],
    footage: footageTable(ctx, segments, items),
    fonts: project.materials.flatMap((m) => (m.kind === 'font' && m.file ? [{ family: m.id, src: materialSrc(m) }] : [])),
    ...(heard.length ? { words: heard } : {}),
  };
};
