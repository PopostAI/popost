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
import { duckOf, heardSpan, joinSpans } from './mix';
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
  return { kind: 'scene', src: s.base.scene.replace(/\\/g, '/'), ...(s.base.slots ? { slots: s.base.slots } : {}), ...(s.base.offset !== undefined ? { offset: s.base.offset } : {}) };
};

const resolveSegment = (ctx: Ctx, s: Segment, k: number): ResolvedSegment => {
  const start = ctx.tl.starts[k] ?? 0;
  const transition = k === 0 ? undefined : resolveTransition(s.in, start, ctx.fps);
  return { id: s.id, index: k, start, end: start + (ctx.tl.lengths[k] ?? 0), base: resolveBase(ctx, s, start), ...(transition ? { transition } : {}) };
};

/** An audio track on the timeline, with what the mix needs to know of it. */
interface TrackSound { sound: ResolvedAudio; role?: 'voice' | 'music'; bed: boolean; fixed: boolean; lines: [number, number][]; material: string }

const trackSounds = (ctx: Ctx): TrackSound[] =>
  ctx.project.tracks.flatMap((t): TrackSound[] => {
    if (t.type !== 'audio') return [];
    const span = t.during ? spanFrames(ctx.tl, t.during) : wholeVideo(ctx.tl);
    if (!span) throw new Error('resolve: audio "' + t.id + '" is placed in a segment that does not exist.');
    const from = t.bed ? { from: { frame: t.in ?? 0, fps: factsOf(ctx, t.material).fps } } : t.in ? {from:{frame:t.in,fps:ctx.fps}} : {};
    const sound: ResolvedAudio = { id: t.id, src: materialSrc(material(ctx, t.material)), start: span.start, ...(t.during ? { end: span.end } : {}), gain: t.gain ?? 0, ...from, ...(t.fadeOut ? { fadeOut: t.fadeOut } : {}) };
    // A voice's lines are counted from the track's start; what lies past its end is not heard.
    const lines = t.role === 'voice' ? (t.lines ?? []).flatMap(([a, b]): [number, number][] => { const x: [number, number] = [span.start + a, Math.min(span.end, span.start + b)]; return x[1] > x[0] ? [x] : []; }) : [];
    return [{ sound, ...(t.role ? { role: t.role } : {}), bed: t.bed === true, fixed: t.gain !== undefined, lines, material: t.material }];
  });

const itemSounds = (ctx: Ctx, items: readonly ResolvedItem[]): ResolvedAudio[] => {
  const byId = new Map(items.map((it) => [it.id, it] as const));
  return ctx.project.tracks.flatMap((t): ResolvedAudio[] => {
    if (t.type === 'audio' || t.type === 'caption' || t.sound === undefined) return [];
    const item = byId.get(t.id);
    return item ? [{ id: t.id + '.sound', src: materialSrc(material(ctx, t.sound)), start: item.start, gain: 0 }] : [];
  });
};

/**
 * A use of footage that sounds: its sound, whether its level is the fill's own ("audio"), and when a person in it
 * speaks. carried: a bed plays its sound, so the use itself adds none (its person is still heard, through the bed).
 */
interface ClipSound { sound: ResolvedAudio; fixed: boolean; speech: [number, number][]; carried?: true }

/**
 * The footage's own sound of every base and video item. "audio" gives its gain, false none. Without "audio": under a
 * bed the bed carries the sound; else a clip made with speech always sounds (its person is heard), and another clip
 * sounds unless a sound of the project's own (an audio track without a role) lies over it. It plays at the footage's
 * speed.
 */
const clipSounds = (ctx: Ctx, segments: readonly ResolvedSegment[], items: readonly ResolvedItem[], tracks: readonly TrackSound[]): ClipSound[] => {
  const fromBases = segments.flatMap((s, k) => {
    const spec = ctx.project.segments[k]?.base;
    return s.base.kind === 'video' && spec && 'material' in spec ? [{ id: s.id, spec: spec as FootageSpec, play: s.base.play, end: s.end }] : [];
  });
  // A sound of the project's own (an audio track that is neither a bed nor a layer of the mix) keeps footage silent unless a use says otherwise.
  const ownSound = tracks.some((t) => !t.bed && !t.role);
  // Under a bed (the sound of a clip running on under the shots cut from it) those shots do not sound a second time.
  const beds = tracks.filter((t) => t.bed).map((t) => ({ start: t.sound.start, end: t.sound.end ?? ctx.tl.total }));
  const bedded = (frame: number): boolean => beds.some((s) => frame >= s.start && frame < s.end);
  const byId = new Map(items.map((it) => [it.id, it] as const));
  const fromItems = ctx.project.tracks.flatMap((t) => {
    const it = byId.get(t.id);
    return t.type === 'video' && it?.play ? [{ id: t.id, spec: t as FootageSpec, play: it.play, end: it.end }] : [];
  });
  return [...fromBases, ...fromItems].flatMap((u): ClipSound[] => {
    const facts = factsOf(ctx, u.play.material);
    const use = { start: u.play.start, end: u.end, inSeconds: u.play.in / facts.fps, speed: u.play.speed };
    const speech = (facts.speech ?? []).flatMap((line) => { const span = heardSpan(line, use, ctx.fps); return span ? [span] : []; });
    const carried = u.spec.audio === undefined && bedded(u.play.start);
    const gain = u.spec.audio ?? (carried ? false : speech.length ? 0 : ownSound ? false : 0);
    if (!facts.hasAudio || (gain === false && !(carried && speech.length))) return [];
    const src = materialSrc(material(ctx, u.play.material));
    return [{ sound: { id: u.id + '.audio', src, start: u.play.start, end: u.end, gain: gain === false ? 0 : gain, from: { frame: u.play.in, fps: facts.fps }, ...(u.play.speed !== 1 ? { speed: u.play.speed } : {}) }, fixed: u.spec.audio !== undefined, speech, ...(gain === false ? { carried: true as const } : {}) }];
  });
};

/**
 * The sound of the timeline, in layers (mix.ts). A clip in which a person speaks is heard at its level and gives way
 * to nothing. Every other clip's own sound, and a bed, gives way to the lines of the voice-over and to the lines other
 * clips say; music (an audio track with that role) gives way to every speech. A level a fill or a track fixes itself
 * ("audio", "gain") stays as it is.
 */
const mixedAudio = (ctx: Ctx, segments: readonly ResolvedSegment[], items: readonly ResolvedItem[]): Pick<Resolved, 'audio' | 'speech'> => {
  const tracks = trackSounds(ctx);
  const clips = clipSounds(ctx, segments, items, tracks);
  const voice = joinSpans(tracks.flatMap((t) => t.lines));
  const dialogue = clips.filter((c) => c.speech.length).map((c) => ({ id: c.sound.id, spans: joinSpans(c.speech) }));
  const under = (spans: readonly (readonly [number, number])[], a: ResolvedAudio): ResolvedAudio => {
    const duck = duckOf(spans.filter(([s, e]) => e > a.start && s < (a.end ?? ctx.tl.total)), ctx.fps);
    return duck ? { ...a, duck } : a;
  };
  const saidBy = (not?: string): [number, number][] => dialogue.filter((d) => d.id !== not).flatMap((d) => d.spans);
  const fromTracks = tracks.map((t) => {
    const speaks = t.bed && (factsOf(ctx, t.material).speech?.length ?? 0) > 0;
    if (t.fixed || t.role === 'voice' || speaks || !(t.role === 'music' || t.bed)) return t.sound;
    return under([...voice, ...saidBy()], t.sound);
  });
  const fromClips = clips.filter((c) => !c.carried).map((c) => (c.fixed || c.speech.length ? c.sound : under([...voice, ...saidBy(c.sound.id)], c.sound)));
  const heard = voice.length || dialogue.length ? { speech: { voice, dialogue } } : {};
  return { audio: [...fromTracks, ...itemSounds(ctx, items), ...fromClips], ...heard };
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
    ...mixedAudio(ctx, segments, items),
    footage: footageTable(ctx, segments, items),
    fonts: project.materials.flatMap((m) => (m.kind === 'font' && m.file ? [{ family: m.id, src: materialSrc(m) }] : [])),
    ...(heard.length ? { words: heard } : {}),
  };
};
