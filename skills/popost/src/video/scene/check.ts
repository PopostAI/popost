/**
 * A scene opened in the renderer: does it load, does a script fail, does its content stay inside the canvas, do the
 * marked places hold their text, is anything drawn at all. The static rules (lint.ts) say what a scene may not do;
 * this says what this scene actually does. Every problem names the scene and gives one fix, because the one who
 * reads it is usually the model that wrote the scene.
 */
import type { Runtime } from '../../runtime';
import { buildPage } from '../compile/index';
import { error, warning } from '../project/check-common';
import { openSession, SceneLoadError } from '../render/session';
import type { SceneSpill, SceneText } from '../page/contract';
import type { Problem, Project, Resolved } from '../types';
import { fillOfPng } from '../measure/fill';
import { readFacts, referenceLines, type ReferenceFacts } from '../template/facts';
import { repeatsOf, type ReferenceLine, type Repeat } from './copied';
import { itemsOver, type ItemsOver } from './items';
import { emptierProblem, emptyProblem, lateProblem, lateTexts, readBy, sceneNumbersProblem, sceneRepeatsProblem, textNumbersProblem, textRepeatsProblem, unseenIn, unseenProblem, visibleCharacters, type Shot } from './findings';
import { libraryOfFile } from './library';
import { figuresIn, projectTexts, untraced, valuesIn } from './numbers';

/** The scene segments of a timeline: index, file, and the frames they are on. */
export const sceneSegments = (r: Resolved): { k: number; src: string; start: number; end: number }[] =>
  r.segments.flatMap((s, k) => (s.base.kind === 'scene' ? [{ k, src: s.base.src, start: s.start, end: s.end }] : []));

/** What the check measured of one scene segment. */
export interface SceneSummary {
  /** The segment as problems name it ("segments[3]"), its id, its scene file and its length in seconds. */
  at: string;
  id: string;
  scene: string;
  seconds: number;
  /** The frames of its three pictures: at a quarter, a half and three quarters of the shot. */
  frames: number[];
  /**
   * The share of the half-way picture that stands out from its ground, 0..1 (measure/fill.ts), the boxes of the video
   * and image items over the scene counted whole; absent when it was not read.
   */
  fill?: number;
  /** The video and image items laid over the scene in the half-way picture: how many, and the share of the canvas they cover, 0..1; absent when none is. */
  items?: { count: number; cover: number };
  /** The same share of the middle of the reference shot it re-creates, from the project's record (template/facts.ts); absent without one. */
  referenceFill?: number;
  /** With options.shotsDir: the three pictures' files there, as typed, in the order of frames. */
  pictures?: string[];
}

export interface SceneCheck {
  problems: Problem[];
  /** Screenshots (PNG) of every scene at a quarter, a half and three quarters of its time, for whoever wants to look. */
  shots: { k: number; frame: number; png: Buffer }[];
  scenes: SceneSummary[];
}

export interface SceneCheckOptions {
  /** The directory the pictures are kept in, as typed (scene check --shots): a warning names the picture to open. */
  shotsDir?: string;
  /** Texts that count as sources besides the project's files (scene write gives the customer's brief). */
  sources?: readonly string[];
}

/** The file name of a kept picture: the segment, numbered from 1 as the shots are, and the frame. */
export const shotFileName = (k: number, frame: number): string => 'segment-' + String(k + 1).padStart(2, '0') + '-f' + frame + '.png';

const at = (k: number): string => 'segments[' + k + '].base.scene';

/** A line the screen helper (assets/video/screen.js) wrote: "popost-screen: <level>: <message> | Fix: <fix>". */
const SCREEN_LINE = /^popost-screen: (error|warning): ([\s\S]*?) \| Fix: ([\s\S]*)$/;

/** A message a scene reported: the screen helper's own problem with its level and fix, else an error of the scene. */
const reported = (k: number, src: string, message: string): Problem => {
  const m = message.match(SCREEN_LINE);
  if (m) return (m[1] === 'warning' ? warning : error)(at(k), 'The screen in "' + src + '": ' + (m[2] ?? ''), m[3] ?? '');
  return error(at(k), 'The scene "' + src + '" reported an error: ' + message.slice(0, 240), 'Correct the script or the path it names; paths are relative to the scene file.');
};

const SIDE: Readonly<Record<SceneSpill['side'], string>> = { left: 'left side', right: 'right side', top: 'top', bottom: 'bottom' };

/** A marked text that is not drawn whole: out of its own element's box, or cut off by an element around it. */
const spillProblem = (k: number, src: string, o: SceneSpill): Problem => {
  const place = 'The text of the place "' + o.slot + '" ("' + o.text + '")';
  if (o.ancestor === undefined) {
    return warning(at(k), place + ' does not fit its box in "' + src + '": its glyphs run ' + o.px + ' px past the ' + SIDE[o.side] + ' of the element.',
      'Make the element larger (or give it no fixed ' + (o.side === 'left' || o.side === 'right' ? 'width' : 'height') + '), the text smaller or shorter, or let it wrap.');
  }
  return warning(at(k), place + ' is cut off in "' + src + '": it fits its own element, but ' + o.ancestor + ' around it hides what lies outside it (overflow), and the glyphs run ' + o.px + ' px past its ' + SIDE[o.side] + '.',
    'Make ' + o.ancestor + ' larger or give it no fixed ' + (o.side === 'left' || o.side === 'right' ? 'width' : 'height') + ', or make the text smaller or shorter.');
};

/** Script files a scene loads by a relative address (not inline, not a data URL). */
const scriptFiles = (html: string): string[] =>
  [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)].map((m) => (m[1] ?? m[2] ?? m[3] ?? '').trim()).filter((s) => s !== '' && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(s));

/**
 * Script files that scenes name and the project does not have, each at its segment. A browser only says that a script
 * failed to load; here the file is named, and when it is a library the Skill can supply, so is the command that puts
 * it there.
 */
const missingScripts = async (rt: Runtime, projectDir: string, scenes: readonly { k: number; src: string }[]): Promise<Problem[]> => {
  const root = rt.path.resolve(rt.cwd, projectDir);
  const out: Problem[] = [];
  for (const s of scenes) {
    const sceneFile = rt.path.resolve(root, s.src);
    const html = await rt.fs.readText(sceneFile).catch(() => '');
    for (const src of scriptFiles(html)) {
      const file = rt.path.resolve(rt.path.dirname(sceneFile), src.split(/[?#]/)[0] ?? src);
      if ((await rt.fs.stat(file)) !== null) continue;
      const library = libraryOfFile(src);
      out.push(error(at(s.k), 'The scene "' + s.src + '" loads the script "' + src + '", and there is no such file in the project (the address is relative to the scene file).',
        library ? 'Run: popost video scene library ' + projectDir + ' --name ' + library + '   (it puts the file into the project)' : 'Put the file into the project, correct the address, or write the script inline.'));
    }
  }
  return out;
};

/** What was read of one scene segment, for the findings that compare segments and for the numbers. */
interface Looked {
  shot: Shot;
  frames: number[];
  /** Its texts half-way through and in its last frame. */
  half: SceneText[];
  end: SceneText[];
}

type Session = Awaited<ReturnType<typeof openSession>>;
type Segment = ReturnType<typeof sceneSegments>[number];

/** The texts of one scene at a frame (applied without a screenshot). */
const textsAt = async (session: Session, s: Segment, frame: number): Promise<SceneText[]> =>
  (await session.scenes({ frame, segment: s.k }))[0]?.texts ?? [];

/**
 * For each text that arrives too late, the second of the shot from which it is seen: the first of a few frames between
 * the frame it was not seen in yet (from) and the end that shows it. Only these texts cost frames.
 */
const whenSeen = async (session: Session, s: Segment, late: readonly SceneText[], from: number, fps: number): Promise<{ text: string; seen: number }[]> => {
  const last = s.end - 1;
  const samples = [...new Set([1, 2, 3, 4].map((i) => from + Math.round(((last - from) * i) / 5)))].filter((f) => f > from && f < last);
  const seen = new Map<number, number>();
  for (const frame of samples) {
    if (late.every((t) => seen.has(t.index))) break;
    const texts = await textsAt(session, s, frame);
    for (const t of late) if (!seen.has(t.index) && texts.some((x) => x.index === t.index && x.visible)) seen.set(t.index, frame);
  }
  return late.map((t) => ({ text: t.text, seen: ((seen.get(t.index) ?? last) - s.start) / fps }));
};

/**
 * The texts of the list a viewer has too little time to read: not visible yet at the second readBy names (half the
 * shot, or 1.5 s before its end in a shot longer than 3 s), with the frame looked at. In a short shot that is the
 * half-way frame, already read.
 */
const tooLate = async (session: Session, s: Segment, shot: Shot, arriving: readonly SceneText[], halfFrame: number, fps: number): Promise<{ texts: SceneText[]; frame: number }> => {
  const frame = Math.min(s.end - 1, s.start + Math.ceil(readBy(shot.seconds) * fps - 1e-6));
  if (frame <= halfFrame) return { texts: [...arriving], frame: halfFrame };
  return { texts: unseenIn(arriving, await textsAt(session, s, frame)), frame };
};

/**
 * What a viewer finds in one shot: its texts half-way through and at its end, a text that comes so late that it stays
 * too briefly to be read (with when it comes and how long it stays), and how much of the middle picture stands out
 * from its ground (the clips and pictures laid over the scene, over, counted whole): against its reference shot's when
 * the record has it, else against a fixed floor. Not visible half-way but visible at the end is the cheap first filter:
 * only those texts cost more.
 */
const viewShot = async (session: Session, s: Segment, shot: Shot, frames: number[], middle: Buffer | undefined, over: ItemsOver, fps: number, picture: string, reference?: { shot: number; fill: number }) => {
  const halfFrame = frames[1] ?? s.start;
  const half = await textsAt(session, s, halfFrame), end = await textsAt(session, s, s.end - 1);
  const arriving = lateTexts(half, end);
  const short = arriving.length ? await tooLate(session, s, shot, arriving, halfFrame, fps) : { texts: [], frame: halfFrame };
  const late = short.texts.length ? lateProblem(shot, await whenSeen(session, s, short.texts, short.frame, fps), picture) : undefined;
  const fill = middle ? fillOfPng(middle, over.regions) : undefined;
  const empty = fill === undefined ? undefined : reference ? emptierProblem(shot, fill, reference, picture, over.count) : emptyProblem(shot, fill, visibleCharacters(half), picture, over.count);
  return { looked: { shot, frames, half, end } satisfies Looked, late, fill, empty };
};

/** A text of a scene over its two frames: visible when it is in either. */
const overShot = (l: Looked): SceneText[] =>
  l.end.map((t) => ({ ...t, visible: t.visible || l.half.some((h) => h.index === t.index && h.visible) }));

/** Texts a short shot never shows that a longer segment with the same scene file does, by the short shot's segment. */
const unseenProblems = (looked: readonly Looked[], picture: (k: number, frame: number) => string): Map<number, Problem> =>
  new Map(looked.flatMap((l): [number, Problem][] => {
    const longer = looked.filter((o) => o.shot.src === l.shot.src && o.shot.seconds > l.shot.seconds).sort((a, b) => b.shot.seconds - a.shot.seconds)[0];
    const p = longer ? unseenProblem(l.shot, overShot(l), longer.shot, overShot(longer), picture(l.shot.k, l.frames[1] ?? 0)) : undefined;
    return p ? [[l.shot.k, p]] : [];
  }));

/** The captions and text items shown in the segments checked, with where each is in the project. */
const projectTextsShown = (project: Project, r: Resolved, ks: readonly number[]): { place: string; noun: string; text: string; id: string }[] =>
  r.items.flatMap((item) => {
    const k = r.segments.findIndex((s) => item.start >= s.start && item.start < s.end);
    const seg = r.segments[k];
    if (item.type !== 'text' || !item.text || !seg || !ks.includes(k)) return [];
    const track = project.tracks.findIndex((t) => t.id === (item.cue ? item.cue.track : item.id));
    const place = track < 0 ? 'items.' + item.id : item.cue ? 'tracks[' + track + '].cues[' + item.cue.index + '].text' : 'tracks[' + track + '].text';
    return [{ place, noun: item.cue ? 'caption' : 'text', text: item.text, id: seg.id }];
  });

/** Each repeat once: an element's text holds the texts of the elements inside it, so one found inside another is left out. */
const once = (repeats: readonly Repeat[]): Repeat[] => {
  const lower = repeats.map((r) => r.shown.toLowerCase());
  return repeats.filter((_r, i) => !lower.some((x, j) => j !== i && x.includes(lower[i] ?? '') && (x !== lower[i] || j < i)));
};

/**
 * Numbers the scenes show in their last frame, and the captions and text items show, that no text file of the
 * project holds. With the reference's lines (the project's record), the figures among them that the reference showed,
 * and the phrases these texts repeat from it, are reported as the reference's content instead. The files are read
 * only when something may be reported.
 */
const numberProblems = async (rt: Runtime, root: string, looked: readonly Looked[], shown: ReturnType<typeof projectTextsShown>, o: SceneCheckOptions, picture: (k: number, frame: number) => string, reference: readonly ReferenceLine[]): Promise<Problem[]> => {
  const visible = (l: Looked): string[] => l.end.filter((t) => t.visible).map((t) => t.text);
  if (!reference.length && ![...looked.flatMap(visible), ...shown.map((t) => t.text)].some((t) => figuresIn(t).length > 0)) return [];
  const files = await projectTexts(rt, root);
  const sources = [...files.map((f) => f.text), ...(o.sources ?? [])];
  const values = valuesIn(sources);
  const none = files.length === 0 && !(o.sources ?? []).some((s) => s.trim());
  const repeats = reference.length ? repeatsOf(reference, sources, values) : undefined;
  /** The figures of some texts that no source holds and the reference did not show, and what they repeat of the reference. */
  const split = (texts: readonly string[]) => {
    const figures = untraced(texts, values);
    const copied = repeats ? repeats.figures(figures) : [];
    return { invented: figures.filter((f) => !copied.some((c) => c.figure === f)), repeated: once([...copied, ...(repeats ? texts.flatMap(repeats.phrases) : [])]) };
  };
  const scenes = looked.flatMap((l) => {
    const s = split(visible(l)), seen = picture(l.shot.k, l.frames[2] ?? 0);
    return [sceneNumbersProblem(l.shot, s.invented, seen, none), sceneRepeatsProblem(l.shot, s.repeated, seen)];
  });
  const texts = shown.map((t) => ({ t, s: split([t.text]) }));
  const invented = texts.map(({ t, s }) => textNumbersProblem(t.place, t.noun, t.text, t.id, s.invented, none)).filter((p) => p !== undefined).slice(0, 6);
  const repeated = texts.map(({ t, s }) => textRepeatsProblem(t.place, t.noun, t.text, t.id, s.repeated)).filter((p) => p !== undefined).slice(0, 6);
  return [...scenes, ...invented, ...repeated].filter((p): p is Problem => p !== undefined);
};

/**
 * Checks every scene of a project (or only those of the segments named). Problems of the project itself come first:
 * with one of those nothing is opened. projectDir: as the user typed it.
 */
export const checkScenes = async (rt: Runtime, projectDir: string, only?: number[], o: SceneCheckOptions = {}): Promise<SceneCheck> => {
  const built = await buildPage(rt, projectDir);
  const blocking = built.problems.filter((p) => p.level === 'error');
  if (blocking.length || !built.resolved || !built.project) return { problems: built.problems, shots: [], scenes: [] };
  const resolved = built.resolved, project = built.project;
  const wanted = sceneSegments(resolved).filter((s) => !only || only.includes(s.k));
  if (!wanted.length) return { problems: built.problems, shots: [], scenes: [] };
  const shots: SceneCheck['shots'] = [];
  const scenes: SceneSummary[] = [];
  const absent = await missingScripts(rt, projectDir, wanted);
  if (absent.length) return { problems: [...built.problems, ...absent], shots, scenes };
  const problems: Problem[] = [...built.problems];
  const session = await openSession(rt, projectDir, { reuse: false }).catch((e: unknown) => e as Error);
  // A scene that did not load is reported at its own segment, whichever segments were asked for.
  if (session instanceof SceneLoadError) return { problems: [...problems, ...session.problems], shots, scenes };
  if (session instanceof Error) {
    return { problems: [...problems, error('(page)', 'The page could not be opened: ' + session.message.split('\n')[0], 'Read the message: it names the picture or font that failed to load.')], shots, scenes };
  }
  // The project's record of its reference (template fill writes it): its shots' fill and its on-screen text.
  const facts: ReferenceFacts | undefined = await readFacts(rt, rt.path.resolve(rt.cwd, projectDir));
  const picture = (k: number, frame: number): string =>
    o.shotsDir ? 'picture ' + rt.path.join(o.shotsDir, shotFileName(k, frame)) : 'frame ' + frame + ', which --shots keeps as ' + shotFileName(k, frame);
  const looked: Looked[] = [];
  const empties = new Map<number, Problem>();
  const late = new Set<number>();
  try {
    const { width, height, fps } = session.resolved.canvas;
    for (const s of wanted) {
      const before = session.errors().length;
      const length = s.end - s.start;
      const frames = [0.25, 0.5, 0.75].map((p) => Math.min(s.end - 1, s.start + Math.floor(length * p)));
      for (const frame of frames) shots.push({ k: s.k, frame, png: await session.frame(frame) });
      // By segment: several segments may show one file, each with its own slots.
      const fact = (await session.scenes({ segment: s.k }))[0];
      const thrown = [...new Set(session.errors().slice(before))];
      if (s === wanted[0]) thrown.unshift(...new Set(session.errors().slice(0, before)));
      for (const message of thrown.slice(0, 8)) problems.push(reported(s.k, s.src, message));
      const shot: Shot = { k: s.k, id: resolved.segments[s.k]?.id ?? String(s.k), src: s.src, seconds: length / fps };
      const shotsDir = o.shotsDir;
      const summary: SceneSummary = { at: 'segments[' + s.k + ']', id: shot.id, scene: s.src, seconds: Math.round(shot.seconds * 100) / 100, frames, ...(shotsDir ? { pictures: frames.map((f) => rt.path.join(shotsDir, shotFileName(s.k, f))) } : {}) };
      scenes.push(summary);
      if (!fact || fact.elements === 0) { problems.push(error(at(s.k), 'The scene "' + s.src + '" has nothing in its <body>.', 'Write the elements of the picture into the page.')); continue; }
      if (fact.width > width + 1 || fact.height > height + 1) problems.push(warning(at(s.k), 'The content of "' + s.src + '" needs ' + fact.width + 'x' + fact.height + ' pixels; the canvas is ' + width + 'x' + height + ', so what lies outside is cut off.', 'Give html and body exactly ' + width + 'px by ' + height + 'px with overflow: hidden, and keep every element inside.'));
      for (const sp of [...fact.overflowing, ...fact.clipped].slice(0, 6)) problems.push(spillProblem(s.k, s.src, sp));
      const mine = shots.filter((x) => x.k === s.k);
      if (mine.length === 3 && mine.every((x) => x.png.equals(mine[0]?.png ?? x.png)) && (mine[0]?.png.length ?? 0) < 4000) problems.push(warning(at(s.k), 'The scene "' + s.src + '" shows the same flat picture at a quarter, a half and three quarters of its time.', 'Check that its elements are visible (opacity, position, colour against the ground) and that its motion starts inside the shot.'));
      const known = facts?.shots.find((x) => x.segment === shot.id);
      const reference = known && typeof known.fill === 'number' ? { shot: known.index, fill: known.fill } : undefined;
      const over = itemsOver(session.resolved, frames[1] ?? s.start);
      const viewed = await viewShot(session, s, shot, frames, mine[1]?.png, over, fps, picture(s.k, frames[1] ?? 0), reference);
      looked.push(viewed.looked);
      if (viewed.fill !== undefined) summary.fill = Math.round(viewed.fill * 1000) / 1000;
      if (over.count) summary.items = { count: over.count, cover: Math.round(over.cover * 1000) / 1000 };
      if (reference) summary.referenceFill = reference.fill;
      if (viewed.late) { problems.push(viewed.late); late.add(s.k); }
      if (viewed.empty) empties.set(s.k, viewed.empty);
    }
  } finally {
    await session.close();
  }
  const unseen = unseenProblems(looked, picture);
  // A text that comes late, or never, is why the middle of its shot is empty: that warning says so, with its fix.
  problems.push(...[...empties].filter(([k]) => !late.has(k) && !unseen.has(k)).map(([, p]) => p), ...unseen.values());
  problems.push(...(await numberProblems(rt, rt.path.resolve(rt.cwd, projectDir), looked, projectTextsShown(project, resolved, wanted.map((s) => s.k)), o, picture, referenceLines(facts))));
  return { problems, shots, scenes };
};
