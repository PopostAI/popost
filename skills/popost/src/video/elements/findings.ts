/**
 * What the reading of the frames lets the checks of a fill and of a project say. (a) A shot whose change in is an
 * effect of its own must be drawn by a scene that covers it: a preset there, or a fill that is not a scene, is a
 * warning that names the effect and the picture of its frames. (b) The words of the platform's and the author's layers
 * (a watermark, an account line, as the text reader read them) shown by a scene or a caption are the reference's
 * platform or author. (c) A shot keeps its layout: one read as full-frame footage or a recording built as a designed
 * scene with small pictures, or a designed picture shown as full-frame material, is a warning. The facts come from the
 * template (template check) or from the project's record of it (video check). Pure, but for reading scene files.
 */
import type { Runtime } from '../../runtime';
import { warning } from '../project/check-common';
import type { RetargetPlan } from '../retarget/index';
import type { ReferenceFacts } from '../template/facts';
import type { TemplatePackage } from '../template/types';
import type { Box, Problem, Project, Track } from '../types';
import { captionFillProblems, captionProjectProblems } from './caption-reading';
import { extrasOf, extrasOfFacts, type ReadingExtras } from './main';
import { motionFillProblems, motionProjectProblems, sizeFillProblems, sizeProjectProblems } from './picture';

/** What the checks need of a shot's reading; picture: the path to show for the picture of the effect's frames. */
/** beats: the fill's caption beats (from 0) that fall in the shot. */
export interface ShotReadingFacts extends ReadingExtras { layout?: string; frame?: 'full' | 'designed'; beats?: number[]; effect?: { description: string; picture?: string; by: 'this' | 'before'; frames: number } }
export interface ReadingFacts { shots: ShotReadingFacts[]; dropped: string[] }

/** The facts of a template's reading; picture: how a path kept in the template (from its directory) is shown. */
/** The beats of the template's captions (shown ones) whose middle falls in each shot, by the shots' frames. */
const cache = new WeakMap<TemplatePackage, number[][]>();
const beatsOf = (pkg: TemplatePackage): number[][] => {
  const hit = cache.get(pkg);
  if (hit) return hit;
  const out = beatsByShot(pkg);
  cache.set(pkg, out);
  return out;
};
const beatsByShot = (pkg: TemplatePackage): number[][] => {
  const beats = pkg.template.captions?.beats ?? [];
  let from = 0;
  return pkg.template.shots.map((s) => {
    const [a, b] = [from, from + s.frames];
    from = b;
    return beats.flatMap((x, i) => (x.shown !== false && (x.start + x.end) / 2 >= a && (x.start + x.end) / 2 < b ? [i] : []));
  });
};

export const readingOfTemplate = (pkg: TemplatePackage, picture: (p: string) => string): ReadingFacts => ({
  shots: pkg.template.shots.map((s, k) => ({
    ...(s.elements ? { layout: s.elements.layout, ...extrasOf(s.elements) } : {}), beats: beatsOf(pkg)[k] ?? [], ...(s.elements?.frame ? { frame: s.elements.frame } : {}),
    ...(s.effect ? { effect: { description: s.effect.description, ...(s.effect.picture ? { picture: picture(s.effect.picture) } : {}), by: s.effect.by, frames: s.effect.frames } } : {}),
  })),
  dropped: pkg.dropped ?? [],
});

/** The facts of a project's record of its template; picture: how a path kept in the record (from the project directory) is shown. */
export const readingOfFacts = (f: ReferenceFacts, picture: (p: string) => string): ReadingFacts => ({
  shots: f.shots.map((s) => ({
    ...(typeof s.layout === 'string' ? { layout: s.layout } : {}), ...extrasOfFacts(s), ...(s.frame ? { frame: s.frame } : {}),
    ...(s.effect ? { effect: { ...s.effect, ...(s.effect.picture ? { picture: picture(s.effect.picture) } : {}) } } : {}),
  })),
  dropped: Array.isArray(f.dropped) ? f.dropped.filter((x) => typeof x === 'string') : [],
});

/** Whether the reading has anything these checks use. */
export const hasReading = (rf: ReadingFacts): boolean => rf.dropped.length > 0 || rf.shots.some((s) => s.layout || s.effect || s.main || s.motion || s.highlight || s.reveal);

const quote = (t: string, n = 60): string => '"' + (t.length > n ? t.slice(0, n - 1) + '…' : t).replace(/"/g, "'") + '"';
const pct = (v: number): string => Math.round(v * 100) + '%';
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** The share of the frame some boxes cover, overlaps counted twice (enough to tell small pictures from a full frame). */
const coverOf = (boxes: readonly Box[]): number => Math.min(1, boxes.reduce((n, b) => n + Math.max(0, b[2]) * Math.max(0, b[3]), 0));
/** Pictures over a designed scene this large or larger fill the frame. */
const FILLS = 0.6;

// ---------------------------------------------------------------------------------------------------------------------
// (a) an effect of its own

/** Which shot draws an effect, and the change it is: "Shot 2 begins with an effect of its own, as the reading saw it: ". */
const effectOwner = (e: NonNullable<ShotReadingFacts['effect']>, owner: number, into: number, noun = 'Shot'): string =>
  e.by === 'this' ? noun + ' ' + owner + ' begins with an effect of its own, as the reading saw it: '
    : noun + ' ' + owner + ' runs on into an effect of its own, as the reading saw the change into ' + noun.toLowerCase() + ' ' + into + ': ';
const effectText = (e: NonNullable<ShotReadingFacts['effect']>): string => quote(e.description, 240) + (e.picture ? ' (its frames: ' + e.picture + ')' : '');
const effectFix = (e: NonNullable<ShotReadingFacts['effect']>, owner: string, into: string): string =>
  e.by === 'this'
    ? 'Draw it in the scene of ' + owner + ' from its first frame: the picture before it, the moving object and the picture it reveals, as its frames show; template fill cuts at the start of the effect, so that scene covers all of it.'
    : 'Draw it at the end of the scene of ' + owner + ', whose motion runs on into ' + into + ': the moving object and the picture it reveals, as its frames show; template fill cuts at the end of the effect, so that scene runs on over the first frames of ' + into + '.';

const effectFillProblems = (rf: ReadingFacts, fill: RetargetPlan): Problem[] =>
  rf.shots.flatMap((s, k) => {
    const e = s.effect, o = e?.by === 'before' ? k - 1 : k;
    const shot: unknown = fill.shots[o];
    if (!e || !isObject(shot) || 'scene' in shot) return [];
    const kind = ['footage', 'picture', 'color', 'card', 'keep'].find((x) => x in shot) ?? 'fill';
    return [warning('shots[' + o + ']', effectOwner(e, o + 1, k + 1) + effectText(e) + '. A ' + kind + ' cannot draw it, and the engine cuts there.',
      'Fill shots[' + o + '] with a scene. ' + effectFix(e, 'shots[' + o + ']', 'shots[' + k + ']'))];
  });

const effectProjectProblems = (rf: ReadingFacts, project: Project): Problem[] =>
  rf.shots.flatMap((s, k) => {
    const e = s.effect, o = e?.by === 'before' ? k - 1 : k;
    const seg = project.segments[k], own = project.segments[o];
    if (!e || !seg || !own) return [];
    const out: Problem[] = [];
    if (seg.in && seg.in.transition !== 'cut')
      out.push(warning('segments[' + k + '].in', 'The change into segment "' + seg.id + '" is the preset "' + seg.in.transition + '"; the reading saw an effect of its own there: ' + effectText(e) + '. A preset does not make it.',
        'Remove "in" (a cut). ' + effectFix(e, 'segment "' + own.id + '"', 'segment "' + seg.id + '"') + ' Running template fill again does both.'));
    if (!('scene' in own.base))
      out.push(warning('segments[' + o + '].base', effectOwner(e, o + 1, k + 1, 'Segment') + effectText(e) + '; segment "' + own.id + '" is not a scene, so nothing draws it.',
        'Make segment "' + own.id + '" a scene. ' + effectFix(e, 'segment "' + own.id + '"', 'segment "' + seg.id + '"')));
    else if ((own.frames ?? 0) < e.frames)
      out.push(warning('segments[' + o + '].frames', 'Segment "' + own.id + '" draws an effect of ' + e.frames + ' frames (' + effectText(e) + ') and is ' + (own.frames ?? 0) + ' frames long.', 'Run template fill again: it moves the cut so that the scene covers the effect.'));
    return out;
  });

// ---------------------------------------------------------------------------------------------------------------------
// (b) the platform's and the author's words

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const HANDLE = /@[\p{L}\p{N}_.]{2,}/gu;
const DOMAIN = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/gi;
const norm = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ' ').trim();

interface DroppedKey { text: string; line?: string; marks: string[] }

/** What a re-make's text is searched for: the whole line when it is long enough to be someone's (two words, or four CJK characters), and its handles and addresses. */
const keysOf = (text: string): DroppedKey => {
  const n = norm(text), cjk = (text.match(CJK) ?? []).length;
  const marks = [...(text.match(HANDLE) ?? []), ...(text.match(DOMAIN) ?? [])].map((x) => x.normalize('NFKC').toLowerCase());
  // A handle or an address alone is matched as itself, never as the words it is made of.
  const line = cjk >= 4 ? n : text.trim().split(/\s+/).length >= 2 ? ' ' + n + ' ' : undefined;
  return { text, ...(line ? { line } : {}), marks };
};

/** What of the dropped words a text shows. */
const shownOf = (text: string, keys: readonly DroppedKey[]): string[] => {
  const n = ' ' + norm(text) + ' ', low = text.normalize('NFKC').toLowerCase();
  const found = [...new Set(keys.flatMap((d) => (d.line && n.includes(d.line) ? [d.text] : d.marks.filter((m) => low.includes(m)))))];
  // Each once: a handle found inside a line found is left out.
  return found.filter((x, i) => !found.some((y, j) => j !== i && y.toLowerCase().includes(x.toLowerCase()) && y.length > x.length));
};

const PLATFORM = 'this is the reference\'s platform or author, which a re-make never shows';
const PLATFORM_FIX = 'Remove it. The new video names an account or an address only when the request or a source gives one.';
const droppedProblem = (at: string, what: string, shown: readonly string[]): Problem =>
  warning(at, what + ' shows ' + shown.map((x) => quote(x)).join(', ') + ', which the reference showed in its platform\'s or author\'s layers (a watermark, an account line): ' + PLATFORM + '.', PLATFORM_FIX);

/** The texts a fill shows itself, with their places. */
const fillTexts = (fill: RetargetPlan): { at: string; text: string }[] => [
  ...(fill.captions ?? []).map((text, i) => ({ at: 'captions[' + i + ']', text })),
  ...(Array.isArray(fill.bar) ? fill.bar.map((text, j) => ({ at: 'bar[' + j + ']', text })) : []),
  ...fill.shots.flatMap((raw, k) => {
    const s: unknown = raw;
    if (!isObject(s)) return [];
    const words = Array.isArray(s.words) ? s.words.map((text, j) => ({ at: 'shots[' + k + '].words[' + j + ']', text })) : [];
    const slots = isObject(s.slots) ? Object.entries(s.slots).map(([name, text]) => ({ at: 'shots[' + k + '].slots.' + name, text })) : [];
    const card = isObject(s.card) ? [{ at: 'shots[' + k + '].card.title', text: s.card.title }, ...(Array.isArray(s.card.lines) ? s.card.lines.map((text, j) => ({ at: 'shots[' + k + '].card.lines[' + j + ']', text })) : [])] : [];
    return [...words, ...slots, ...card];
  }),
].filter((x): x is { at: string; text: string } => typeof x.text === 'string');

const droppedFillProblems = (rf: ReadingFacts, fill: RetargetPlan, scenes: ReadonlyMap<string, string>): Problem[] => {
  const keys = rf.dropped.map(keysOf);
  if (!keys.length) return [];
  const own = fillTexts(fill).flatMap((t) => { const shown = shownOf(t.text, keys); return shown.length ? [droppedProblem(t.at, t.at + ' ' + quote(t.text), shown)] : []; });
  const drawn = fill.shots.flatMap((raw, k) => {
    const s: unknown = raw;
    const file = isObject(s) && typeof s.scene === 'string' ? s.scene : undefined;
    const shown = file ? shownOf(pageText(scenes.get(file) ?? ''), keys) : [];
    return file && shown.length ? [droppedProblem('shots[' + k + '].scene', 'The scene "' + file + '"', shown)] : [];
  });
  return [...own, ...drawn];
};

const droppedProjectProblems = (rf: ReadingFacts, project: Project, scenes: ReadonlyMap<string, string>): Problem[] => {
  const keys = rf.dropped.map(keysOf);
  if (!keys.length) return [];
  const tracks = project.tracks.flatMap((t, i): Problem[] => {
    if (t.type === 'caption') return t.cues.flatMap((c, j) => { const shown = shownOf(c.text, keys); return shown.length ? [droppedProblem('tracks[' + i + '].cues[' + j + '].text', 'The caption ' + quote(c.text), shown)] : []; });
    if (t.type !== 'text') return [];
    const shown = shownOf(t.text, keys);
    return shown.length ? [droppedProblem('tracks[' + i + '].text', 'The text "' + t.id + '"', shown)] : [];
  });
  const drawn = project.segments.flatMap((s, k) => {
    if (!('scene' in s.base)) return [];
    const shown = shownOf([pageText(scenes.get(s.base.scene) ?? ''), ...Object.values(s.base.slots ?? {})].join('\n'), keys);
    return shown.length ? [droppedProblem('segments[' + k + '].base.scene', 'The scene "' + s.base.scene + '" of segment "' + s.id + '"', shown)] : [];
  });
  return [...tracks, ...drawn];
};

// ---------------------------------------------------------------------------------------------------------------------
// (c) the layout

const LAYOUT_FIX = 'Keep the layout kind and find the closest real material of the new subject for it (another page, another recording, popost video capture), never another layout because the same kind of content is missing.';
const DESIGN_FIX = 'Keep the layout kind: make the shot a scene that draws the reference\'s ground and frame, with the material in its place as an item over the scene (video-scenes.md, "Footage inside a scene").';

const layoutProblem = (at: string, s: ShotReadingFacts, k: number, built: string): Problem =>
  s.frame === 'full'
    ? warning(at, 'Shot ' + (k + 1) + ' was read as ' + quote(s.layout ?? 'full-frame footage') + ', full frame; it is built as ' + built + '.', LAYOUT_FIX)
    : warning(at, 'Shot ' + (k + 1) + ' was read as ' + quote(s.layout ?? 'a designed picture') + ', a designed picture with smaller pictures on it; it is built as ' + built + '.', DESIGN_FIX);

/** What a fill makes of a shot, as far as the layout goes: full-frame material, a designed picture, or not known (a scene without items). */
const fillFrame = (s: Record<string, unknown>): { frame?: 'full' | 'designed'; built: string } => {
  const items = Array.isArray(s.items) ? s.items.filter(isObject).map((i) => i.box).filter((b): b is Box => Array.isArray(b) && b.length === 4) : [];
  if (items.length) return coverOf(items) >= FILLS ? { frame: 'full', built: 'a scene with pictures over most of the frame' } : { frame: 'designed', built: 'a designed scene whose pictures cover ' + pct(coverOf(items)) + ' of the frame' };
  if ('card' in s || 'color' in s) return { frame: 'designed', built: 'a ' + ('card' in s ? 'card' : 'flat colour') };
  if (('footage' in s || 'picture' in s) && s.fit !== 'contain') return { frame: 'full', built: 'its material full frame' };
  return { built: '' };
};

const frameFillProblems = (rf: ReadingFacts, fill: RetargetPlan): Problem[] =>
  rf.shots.flatMap((s, k) => {
    const shot: unknown = fill.shots[k];
    if (!s.frame || !isObject(shot)) return [];
    const f = fillFrame(shot);
    return f.frame && f.frame !== s.frame ? [layoutProblem('shots[' + k + ']', s, k, f.built)] : [];
  });

const isPicture = (t: Track, id: string): t is Extract<Track, { type: 'video' | 'image' }> => (t.type === 'video' || t.type === 'image') && t.during.segment === id;

const frameProjectProblems = (rf: ReadingFacts, project: Project): Problem[] =>
  rf.shots.flatMap((s, k) => {
    const seg = project.segments[k];
    if (!s.frame || !seg) return [];
    const items = project.tracks.filter((t) => isPicture(t, seg.id)).map((t) => ('box' in t ? t.box : [0, 0, 0, 0] as Box));
    const b = seg.base;
    const f = items.length ? (coverOf(items) >= FILLS ? { frame: 'full', built: 'pictures over most of the frame' } : { frame: 'designed', built: 'a designed picture whose pictures cover ' + pct(coverOf(items)) + ' of the frame' })
      : 'color' in b ? { frame: 'designed', built: 'a flat colour' }
      : 'material' in b && b.fit !== 'contain' ? { frame: 'full', built: 'its material full frame' } : undefined;
    return f && f.frame !== s.frame ? [layoutProblem('segments[' + k + '].base', s, k, f.built)] : [];
  });

/** The full/designed comparison above is a special case of the main picture's size and place (picture.ts): where it speaks, it speaks alone. */
const withoutDuplicates = (special: Problem[], general: Problem[]): Problem[] => [...special, ...general.filter((g) => !special.some((p) => p.at === g.at))];

const layoutFillProblems = (rf: ReadingFacts, fill: RetargetPlan, scenes: ReadonlyMap<string, string>): Problem[] =>
  withoutDuplicates(frameFillProblems(rf, fill), sizeFillProblems(rf, fill, scenes));

const layoutProjectProblems = (rf: ReadingFacts, project: Project, scenes: ReadonlyMap<string, string>): Problem[] =>
  withoutDuplicates(frameProjectProblems(rf, project), sizeProjectProblems(rf, project, scenes));

// ---------------------------------------------------------------------------------------------------------------------

/** The text of an HTML page as a reader sees it, roughly: scripts and styles left out. */
export const pageText = (html: string): string =>
  html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');

/** The HTML of every scene file named, by its path as named (relative to dir); a file that cannot be read is left out. */
export const sceneSources = async (rt: Runtime, dir: string, files: readonly string[]): Promise<Map<string, string>> => {
  const out = new Map<string, string>();
  for (const f of new Set(files)) {
    const html = await rt.fs.readText(rt.path.resolve(dir, f)).catch(() => undefined);
    if (html !== undefined) out.set(f, html);
  }
  return out;
};

/** The HTML of the scene files of a project's segments (projectDir absolute). */
export const projectSceneSources = (rt: Runtime, projectDir: string, project: Project): Promise<Map<string, string>> =>
  sceneSources(rt, projectDir, (Array.isArray(project.segments) ? project.segments : []).flatMap((s) => {
    const b: unknown = s?.base;
    return isObject(b) && typeof b.scene === 'string' && !b.scene.startsWith('..') ? [b.scene] : [];
  }));

/** What the reading says of a fill (template check, template fill); scenes: the HTML of its scene files when they were read. */
export const fillReadingProblems = (rf: ReadingFacts, fill: RetargetPlan, scenes: ReadonlyMap<string, string> = new Map()): Problem[] =>
  Array.isArray(fill.shots) ? [...effectFillProblems(rf, fill), ...layoutFillProblems(rf, fill, scenes), ...motionFillProblems(rf, fill, scenes), ...captionFillProblems(rf, fill), ...droppedFillProblems(rf, fill, scenes)] : [];

/** What the reading says of a project (video check, template check with the project); scenes: the HTML of its scene files. */
export const projectReadingProblems = (rf: ReadingFacts, project: Project, scenes: ReadonlyMap<string, string>): Problem[] =>
  Array.isArray(project.segments) && Array.isArray(project.tracks) ? [...effectProjectProblems(rf, project), ...layoutProjectProblems(rf, project, scenes), ...motionProjectProblems(rf, project, scenes), ...captionProjectProblems(rf, project), ...droppedProjectProblems(rf, project, scenes)] : [];

/** The shot a warning is about: shots[k] in a fill, segments[k] in a project. */
const shotOf = (at: string): string | undefined => /^(?:shots|segments)\[(\d+)\]/.exec(at)?.[1];

/** The project's warnings that no fill warning already says, in the same words or for the same shot with the same fix. */
export const notSaidBy = (fill: readonly Problem[], project: readonly Problem[]): Problem[] =>
  project.filter((p) => !fill.some((f) => f.message === p.message || (p.fix !== undefined && f.fix === p.fix && shotOf(p.at) !== undefined && shotOf(f.at) === shotOf(p.at))));
