/**
 * What a project keeps of its reference. template fill writes reference.facts.json into the project: which template it
 * was filled from, the facts of every reference shot that a check compares a segment with (its length, what it most
 * likely is, how much of its middle picture is not ground), the caption band and the size of its letters, and the
 * reference's on-screen text by shot. The facts are copied, not pointed to, so the project stays whole when the
 * template moves. A project made by hand has no record, and every check works without one.
 */
import type { Runtime } from '../../runtime';
import { looksText } from '../describe/kind';
import type { Box, Canvas, Measure, Project } from '../types';
import type { TextTrack } from '../text/types';
import { extrasOf, type ReadingExtras } from '../elements/main';
import type { SourceKind, TemplatePackage, TemplateShot } from './types';

/** The record's file in the project directory, beside reference.measure.json. */
export const FACTS_FILE = 'reference.facts.json';
export const FACTS_FORMAT = 'popost-video-reference-facts';
export const FACTS_VERSION = 1;

export interface ShotFacts extends ReadingExtras {
  /** The shot's place in the template, from 0, and the id of the segment template fill made of it. */
  index: number;
  segment: string;
  /** Its length in frames on the template's clock, the reference's (a spoken fill may make the segment longer). */
  frames: number;
  /** What filled it in the reference, and what it most likely is with the facts it rests on (describe/kind.ts), when they said. */
  source: SourceKind;
  looks?: string;
  /** The share of its middle picture that is not ground, 0..1 (measure/fill.ts), when describe measured it. */
  fill?: number;
  /** The text the reference showed in it, each line once; absent when no reader read the reference's text. */
  text?: string[];
  /**
   * What the reading of the frames said (template.json elements): the layout, whether it is full-frame footage or a
   * designed picture, and an effect of its own into the shot, with the picture of its frames (from the project
   * directory), which scene draws it ("this" segment's or the one "before") and its length in frames.
   */
  layout?: string;
  frame?: 'full' | 'designed';
  effect?: { description: string; picture?: string; by: 'this' | 'before'; frames: number };
}

export interface ReferenceFacts {
  format: typeof FACTS_FORMAT;
  version: typeof FACTS_VERSION;
  /** The template: its directory from the project directory, its name, and where it came from (a label and the hash of its measurement). */
  template: { dir?: string; name: string; label: string; measure: string };
  canvas: Canvas;
  /** The caption band, the font size of its letters, and the reference's caption lines (their centre and height), fractions of the canvas. */
  captions?: { box: Box; style: { size?: number }; line: { centre: number; size: number } };
  shots: ShotFacts[];
  /** The words of the reference's platform and author layers (a watermark, an account line), which a re-make never shows. */
  dropped?: string[];
}

const tidy = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * The on-screen text of a described reference by shot: each cue goes to the shot it is on screen longest in, each line
 * once per shot, in the order the cues appeared. For template save (reference-text.json).
 */
export const shotTexts = (m: Measure, text: TextTrack): string[][] => {
  const out = m.shots.map((): string[] => []);
  for (const c of [...text.cues].sort((a, b) => a.start - b.start)) {
    const line = tidy(c.text);
    const overlap = m.shots.map((s) => Math.min(c.end, s.end) - Math.max(c.start, s.start));
    const k = overlap.indexOf(Math.max(...overlap));
    const list = out[k];
    if (line && list && (overlap[k] ?? 0) > 0 && !list.includes(line)) list.push(line);
  }
  return out;
};

const two = (n: number): string => String(n).padStart(2, '0');

/** What a shot's reading gives the record: its layout, its frame, and an effect of its own with its picture from the project directory. */
const readingFacts = (rt: Runtime, pkg: TemplatePackage, s: TemplateShot, projectDir: string): Pick<ShotFacts, 'layout' | 'frame' | 'effect' | 'main' | 'motion' | 'highlight' | 'reveal'> => {
  const e = s.effect;
  const picture = e?.picture && pkg.dir ? rt.path.relative(projectDir, rt.path.resolve(pkg.dir, e.picture)) : undefined;
  return {
    ...(s.elements ? { layout: s.elements.layout, ...extrasOf(s.elements) } : {}), ...(s.elements?.frame ? { frame: s.elements.frame } : {}),
    ...(e ? { effect: { description: e.description, ...(picture ? { picture } : {}), by: e.by, frames: e.frames } } : {}),
  };
};

/** The record of a template for the project template fill made of it in projectDir. */
export const factsOf = (rt: Runtime, pkg: TemplatePackage, project: Project, projectDir: string): ReferenceFacts => {
  const t = pkg.template;
  const c = t.captions;
  return {
    format: FACTS_FORMAT, version: FACTS_VERSION,
    template: { ...(pkg.dir ? { dir: rt.path.relative(projectDir, pkg.dir) || '.' } : {}), name: t.name, label: t.source.label, measure: t.source.measure },
    canvas: t.canvas,
    ...(c ? { captions: { box: c.box, style: c.style.size === undefined ? {} : { size: c.style.size }, line: c.line } } : {}),
    shots: t.shots.map((s, k): ShotFacts => ({
      index: k, segment: project.segments[k]?.id ?? 'shot-' + two(k + 1), frames: s.frames, source: s.source,
      ...(s.looks ? { looks: looksText(s.looks) } : {}), ...(s.fill === undefined ? {} : { fill: s.fill }),
      ...(pkg.text ? { text: pkg.text[k] ?? [] } : {}), ...readingFacts(rt, pkg, s, projectDir),
    })),
    ...(pkg.dropped?.length ? { dropped: pkg.dropped } : {}),
  };
};

/** Writes the record of a template into the project directory. */
export const writeFacts = (rt: Runtime, pkg: TemplatePackage, project: Project, projectDir: string): Promise<void> =>
  rt.fs.writeFile(rt.path.join(projectDir, FACTS_FILE), JSON.stringify(factsOf(rt, pkg, project, projectDir), null, 2) + '\n');

/** The record of a project (projectDir absolute), or undefined when it has none or the file is not one. */
export const readFacts = async (rt: Runtime, projectDir: string): Promise<ReferenceFacts | undefined> => {
  const raw = await rt.fs.readText(rt.path.join(projectDir, FACTS_FILE)).then((t) => JSON.parse(t) as Partial<ReferenceFacts>).catch(() => undefined);
  return raw?.format === FACTS_FORMAT && raw.version === FACTS_VERSION && Array.isArray(raw.shots) && raw.canvas ? (raw as ReferenceFacts) : undefined;
};

/** The reference's lines with the shot each was on screen in: what the new video must not repeat as its own. */
export const referenceLines = (f: ReferenceFacts | undefined): { shot: number; text: string }[] =>
  (f?.shots ?? []).flatMap((s) => (Array.isArray(s.text) ? s.text.filter((x) => typeof x === 'string').map((text) => ({ shot: s.index, text })) : []));
