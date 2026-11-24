/**
 * Example scenes with declared parameters: effects that are often drawn by hand and come out wrong (an object that leads
 * a reveal, a card that turns in depth, doors that fold, a wipe in streaks). Each is one HTML file of the Skill
 * (assets/video/examples/NAME.html), a scene like any other: it draws itself from the time given to render(seconds),
 * with no clock of its own and no randomness. Its parameters stand in the file as a JSON block (script
 * #popost-params): "params" declares each one (name, type, default, range or options, what it does) and "values" holds
 * what this copy sets. This module reads the block, checks values against it and writes a copy with them; a preview
 * renders the copy alone, as a one-shot project in a temporary directory, into one sheet of frames.
 */
import type { Runtime } from '../../runtime';
import { withTempDir } from '../host';
import { writeSheets } from '../look/sheets';
import { error } from '../project/check-common';
import { renderVideo } from '../render/index';
import type { Problem } from '../types';

export const EXAMPLES = ['object-reveal', 'card-flip', 'folding-doors', 'streak-wipe'] as const;
export type ExampleName = (typeof EXAMPLES)[number];

export interface ExampleParam {
  name: string;
  type: 'number' | 'choice' | 'colour';
  default: number | string;
  /** number: its range and its unit. */
  min?: number;
  max?: number;
  unit?: string;
  /** choice: what it may be. */
  options?: (number | string)[];
  what: string;
}

export interface SceneExample { name: string; about: string; params: ExampleParam[]; html: string }

export class ExampleError extends Error {
  override name = 'ExampleError';
}

const BLOCK = /<script type="application\/json" id="popost-params">([\s\S]*?)<\/script>/;
const VALUES = /"values": \{[^\n]*\}/;
const SIZE = 'width: 1280px; height: 720px;';

export const exampleFile = (name: string): string => 'assets/video/examples/' + name + '.html';

/** An example of the Skill with its declared parameters. */
export const readExample = async (rt: Runtime, name: string): Promise<SceneExample> => {
  if (!(EXAMPLES as readonly string[]).includes(name)) throw new ExampleError('There is no example scene named "' + name + '". Known: ' + EXAMPLES.join(', ') + '.');
  const file = rt.path.join(rt.skillRoot, exampleFile(name));
  const html = await rt.fs.readText(file).catch(() => { throw new ExampleError('The file ' + exampleFile(name) + ' of the popost Skill is missing. Reinstall popost (npm install -g popost).'); });
  const block = BLOCK.exec(html)?.[1];
  const parsed = block ? (JSON.parse(block) as { about?: string; params?: ExampleParam[] }) : undefined;
  if (!parsed || !Array.isArray(parsed.params) || !VALUES.test(html) || !html.includes(SIZE)) throw new ExampleError('The example ' + exampleFile(name) + ' has no parameter block the Skill can read. Reinstall popost.');
  return { name, about: parsed.about ?? '', params: parsed.params, html };
};

const COLOUR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** One value as typed ("0.3", "wedge") against its declaration: the value to write, or what is wrong with it. */
const valueOf = (p: ExampleParam, typed: string): { value: number | string } | { problem: Problem } => {
  const at = 'set.' + p.name;
  if (p.type === 'number') {
    const v = Number(typed);
    if (typed.trim() === '' || !Number.isFinite(v) || v < (p.min ?? -Infinity) || v > (p.max ?? Infinity))
      return { problem: error(at, '"' + p.name + '" is a number from ' + p.min + ' to ' + p.max + (p.unit ? ' (' + p.unit + ')' : '') + ': ' + p.what + '. Got "' + typed + '".', 'Write for example --set ' + p.name + '=' + p.default + '.') };
    return { value: v };
  }
  if (p.type === 'choice') {
    const hit = (p.options ?? []).find((o) => String(o) === typed.trim());
    if (hit === undefined) return { problem: error(at, '"' + p.name + '" is one of the values listed: ' + p.what + '. Got "' + typed + '".', 'Write for example --set ' + p.name + '=' + p.default + '.', (p.options ?? []).map(String)) };
    return { value: hit };
  }
  if (typed.trim() !== String(p.default) && !COLOUR.test(typed.trim())) return { problem: error(at, '"' + p.name + '" is a colour such as #ffffff, or "' + p.default + '": ' + p.what + '. Got "' + typed + '".', 'Write for example --set ' + p.name + '=#ffffff.') };
  return { value: typed.trim() };
};

export interface SetExample { html: string; values: Record<string, number | string>; problems: Problem[] }

/**
 * A copy of an example with values set ("name=value" each) and the canvas size written in. values: every parameter as
 * the copy runs with it, the defaults included. A name the example does not declare, or a value outside its range, is a
 * problem and nothing is set.
 */
export const setExample = (ex: SceneExample, set: readonly string[], size: [number, number] = [1280, 720]): SetExample => {
  const problems: Problem[] = [];
  const given: Record<string, number | string> = {};
  for (const pair of set) {
    const eq = pair.indexOf('='), name = eq < 0 ? pair : pair.slice(0, eq);
    const p = ex.params.find((x) => x.name === name);
    if (eq < 0 || !p) { problems.push(error('set.' + name, eq < 0 ? '--set takes name=value; got "' + pair + '".' : 'The example "' + ex.name + '" has no parameter "' + name + '".', 'Use one of its parameters, for example --set ' + (ex.params[0]?.name ?? 'name') + '=' + (ex.params[0]?.default ?? 'value') + '.', ex.params.map((x) => x.name))); continue; }
    const v = valueOf(p, pair.slice(eq + 1));
    if ('problem' in v) problems.push(v.problem); else given[name] = v.value;
  }
  const values = Object.fromEntries(ex.params.map((p) => [p.name, given[p.name] ?? p.default]));
  const html = ex.html.replace(VALUES, () => '"values": ' + JSON.stringify(given)).replace(SIZE, 'width: ' + size[0] + 'px; height: ' + size[1] + 'px;');
  return { html, values, problems };
};

export interface PreviewOptions {
  /** The scene's HTML (a copy made by setExample, or any scene that needs no file of a project). */
  html: string;
  /** The sheet to write (a JPEG), how many seconds of the scene it covers and in how many frames. */
  out: string;
  seconds: number;
  frames: number;
  size: [number, number];
  /** The width of one frame on the sheet, in pixels. */
  tile?: number;
}

export const PREVIEW_FPS = 30;

/**
 * One sheet of frames of a scene on its own: a project of one shot is written into a temporary directory, rendered and
 * removed. The frames are spread evenly over the seconds asked for, the first and the last included, each with its time.
 */
export const previewScene = (rt: Runtime, o: PreviewOptions): Promise<{ file: string; seconds: number[]; columns: number; rows: number }> =>
  withTempDir(rt, 'popost-scene-example-', async (dir) => {
    const total = Math.max(2, Math.round(o.seconds * PREVIEW_FPS) + 1);
    await rt.fs.mkdir(rt.path.join(dir, 'scenes'));
    await rt.fs.writeFile(rt.path.join(dir, 'scenes', 'example.html'), o.html);
    await rt.fs.writeFile(rt.path.join(dir, 'video.json'), JSON.stringify({
      version: 1, canvas: { width: o.size[0], height: o.size[1], fps: PREVIEW_FPS }, materials: [],
      segments: [{ id: 'example', frames: total, base: { scene: 'scenes/example.html' } }], tracks: [],
    }));
    const video = rt.path.join(dir, 'example.mp4');
    await renderVideo(rt, { projectDir: dir, out: video, reuse: false });
    const n = Math.min(Math.max(2, o.frames), total);
    const frames = [...new Set(Array.from({ length: n }, (_v, i) => Math.round((i * (total - 1)) / (n - 1))))];
    const out = rt.path.resolve(rt.cwd, o.out);
    const w = await writeSheets(rt, video, [{ file: rt.path.basename(out), frames }], { width: o.tile ?? 320, outDir: rt.path.dirname(out) });
    const sheet = w.sheets[0];
    if (!sheet) throw new ExampleError('No frame of the scene could be drawn.');
    return { file: sheet.file, seconds: sheet.seconds, columns: sheet.columns, rows: sheet.rows };
  });
