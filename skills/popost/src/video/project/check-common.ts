/** What the checks of segments and tracks share: the context, Problem builders, material references and boxes. Spans: check-span.ts. */
import type { Box, FootageInfo, Material, MotionSpec, Problem, Project, WordsInfo } from '../types';
import { motionFrames } from '../presets/motion';
import type { Timeline } from '../timeline/spans';
import type { TrackWords } from '../timeline/words';

export interface CheckContext {
  project: Project;
  tl: Timeline;
  materials: ReadonlyMap<string, Material>;
  fps: number;
  /** What the build step read from each video material's file; a material that is not in it was not read (its checks are skipped). */
  footage: Readonly<Record<string, FootageInfo>>;
  /** What the build step read from each words file, by material id; a material that is not in it was not read. */
  wordsRead: Readonly<Record<string, WordsInfo>>;
  /** Every audio track whose material names a words file, with its words on the timeline when they were read. */
  words: TrackWords[];
}

export const error = (at: string, message: string, fix: string, allowed?: string[]): Problem => ({ level: 'error', at, message, fix, ...(allowed ? { allowed } : {}) });
export const warning = (at: string, message: string, fix: string, allowed?: string[]): Problem => ({ level: 'warning', at, message, fix, ...(allowed ? { allowed } : {}) });

type Kind = Material['kind'];
const KIND_NOTE: Readonly<Record<string, string>> = { voice: ' (voices are not supported in this version)', speech: ' (speech is not supported in this version)' };
const EXTENSION: Readonly<Record<string, string>> = { image: '.webp', video: '.mp4', audio: '.m4a', font: '.woff2' };
const article = (what: string): string => (/^[aeiou]/.test(what) ? 'an ' : 'a ');

/** A reference from a base or a track to a material: it must exist, be of a needed kind and have a file. */
export const materialRef = (ctx: CheckContext, id: string, at: string, need: Kind | readonly Kind[], user: string): Problem[] => {
  const kinds: readonly Kind[] = typeof need === 'string' ? [need] : need;
  const what = kinds.join(' or ');
  const ofKind = ctx.project.materials.filter((m) => kinds.includes(m.kind)).map((m) => m.id);
  const m = ctx.materials.get(id);
  if (!m) return [error(at, user + ' refers to material "' + id + '", which does not exist.', 'Use the id of ' + article(what) + what + ' material, or add { "id": "' + id + '", "kind": "' + (kinds[0] ?? 'image') + '", "file": "assets/..." } to materials.', ofKind)];
  if (!kinds.includes(m.kind)) return [error(at, user + ' needs ' + article(what) + what + ' material, but "' + id + '" is ' + article(m.kind) + m.kind + ' material' + (KIND_NOTE[m.kind] ?? '') + '.', 'Use the id of ' + article(what) + what + ' material.', ofKind)];
  if (!m.file) return [error(at, 'Material "' + id + '" has no file yet, so ' + user + ' cannot be rendered.', 'Set "file" on material "' + id + '" to a file in the project directory, for example "assets/' + id + (EXTENSION[m.kind] ?? '') + '".')];
  return [];
};

/** 'none' is instant whatever its frames say. */
export const motionLength = (m: MotionSpec | undefined, fps: number): number => (m && m.preset !== 'none' ? (m.frames ?? motionFrames(m.preset, fps)) : 0);

/** A box may reach past the canvas a little (rounding); beyond that the part outside is cut off. */
const EPS = 1e-6;

export const checkBox = (box: Box, id: string, at: string): Problem[] => {
  const [x, y, w, h] = box;
  return x < -EPS || y < -EPS || x + w > 1 + EPS || y + h > 1 + EPS
    ? [warning(at + '.box', 'The box of "' + id + '" [' + box.join(', ') + '] reaches outside the canvas; the part outside is cut off.', 'Keep x, y >= 0, x + width <= 1 and y + height <= 1.')]
    : [];
};
