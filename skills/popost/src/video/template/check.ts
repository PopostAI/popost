/**
 * checkFill: what a program can say about a fill before anything is built. Every problem names the slot by position,
 * the limit, and one fix: a caption over its capacity, a footage file that is missing or too short, a wrong count, a
 * fill a slot does not accept, two colours side by side that would hide a cut, and (with the files at hand) a picture
 * or footage that cover would crop, that would be blown up or that contain would leave on a bare ground (fit.ts), and
 * one picture that fills many shots (a slide show).
 */
import { sha256File } from '../../core/util';
import type { Runtime } from '../../runtime';
import { captionOptionProblems, FILL_KINDS, fillValueProblems, type RetargetPlan } from '../retarget/index';
import type { Problem } from '../types';
import { probe } from '../media/ffmpeg';
import { deltaE, hexToRgb, toLab } from '../measure/colour';
import { error, warning } from '../project/check-common';
import { isOutside } from '../project/check';
import { pictureSlotNames } from '../scene/lint';
import { charsOf, scriptOf, usageOf } from './capacity';
import { fitProblems, itemFitProblems } from './fit';
import { itemSpan, shotItemProblems } from '../retarget/items';
import { barProblems, wordProblems } from '../retarget/titles';
import { unmark } from '../retarget/marks';
import { fillLengths, footageNeed } from './structure';
import type { Capacity, FillKind, TemplatePackage } from './types';
import { fillReadingProblems, hasReading, readingOfTemplate, sceneSources } from '../elements/findings';

const PLAN_KEYS = ['shots', 'captions', 'sound', 'say', 'voice', 'speed', 'captionSpoken', 'captionReveal', 'captionColor', 'captionOutline', 'bar', 'note'];
const PICTURES = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.svg'];
const PAGES = ['.html', '.htm'];
/** Two flat colours closer than this (CIE76 ΔE) hide the change between them from the eye and from the measurement. */
const CLOSE_COLOURS = 10;
const EXAMPLE: Record<FillKind, string> = {
  footage: '{ "footage": "assets/clip.mp4", "in": 0 }', picture: '{ "picture": "assets/picture.webp" }', color: '{ "color": "#101014" }', card: '{ "card": { "title": "..." } }',
  scene: '{ "scene": "scenes/shot-01.html", "slots": { "title": "..." } }',
};

type Shot = Record<string, unknown>;
const quote = (t: string): string => '"' + t.replace(/"/g, "'") + '"';
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const kindsOf = (s: unknown): string[] => (isObject(s) ? FILL_KINDS.filter((k) => k in s) : []);

const shapeProblems = (fill: unknown): Problem[] => {
  if (!isObject(fill)) return [error('(root)', 'A fill is a JSON object with "shots" and "captions".', 'Write { "shots": [ ... ], "captions": [ ... ] }.')];
  const out = Object.keys(fill).filter((k) => !PLAN_KEYS.includes(k)).map((k) => warning(k, 'A fill has no key "' + k + '"; it is ignored.', 'Remove it, or use one of the allowed keys.', PLAN_KEYS));
  if (!Array.isArray(fill.shots)) out.push(error('shots', 'The fill needs "shots": a list with one entry per shot of the template.', 'Add "shots": [ ... ].'));
  if (fill.captions !== undefined && !(Array.isArray(fill.captions) && fill.captions.every((x) => typeof x === 'string')))
    out.push(error('captions', '"captions" must be a list of strings, one per caption beat.', 'Write "captions": ["first line", "second line", ...].'));
  return out;
};

const countProblems = (pkg: TemplatePackage, fill: RetargetPlan): Problem[] => {
  const n = pkg.template.shots.length;
  const beats = pkg.template.captions?.beats.length ?? 0;
  const out: Problem[] = [];
  if (fill.shots.length !== n)
    out.push(error('shots', 'The fill has ' + fill.shots.length + ' shots; the template has ' + n + '. They are matched by position.', fill.shots.length < n ? 'Add ' + (n - fill.shots.length) + ' more entries (TEMPLATE.md lists the shots).' : 'Remove the last ' + (fill.shots.length - n) + ' entries.'));
  const lines = fill.captions;
  if (lines === undefined && beats) out.push(warning('captions', 'The fill has no "captions"; the template has ' + beats + ' caption beats, which stay empty.', 'Add "captions": [ ' + beats + ' lines ].'));
  if (lines && lines.length > beats) out.push(error('captions', 'The fill has ' + lines.length + ' caption lines; the template has ' + beats + ' beats. They are matched by position.', beats ? 'Remove ' + (lines.length - beats) + ' lines, or join short lines.' : 'Remove "captions": this template has no caption band.'));
  if (lines && lines.length < beats) out.push(warning('captions', 'The fill has ' + lines.length + ' caption lines; the template has ' + beats + ' beats. The last ' + (beats - lines.length) + ' stay without a caption.', 'Add lines, or leave it if the ending should be silent.'));
  return out;
};

const valueProblems = (s: Shot, at: string): Problem[] => {
  const out: Problem[] = [];
  const file = s.footage ?? s.picture ?? s.scene;
  if (file !== undefined && (typeof file !== 'string' || !file.trim())) out.push(error(at, 'The file of a shot is a path relative to the project, such as "assets/clip.mp4".', 'Write the path as a string.'));
  else if (typeof file === 'string' && isOutside(file)) out.push(error(at, quote(file) + ' lies outside the project directory.', 'Copy it under assets/ and write its path relative to the project, for example "assets/' + (file.split(/[\\/]/).pop() ?? file) + '".'));
  if (s.in !== undefined && !(Number.isInteger(s.in) && (s.in as number) >= 0)) out.push(error(at + '.in', '"in" is the first frame of the clip, a whole number from 0; it is ' + JSON.stringify(s.in) + '.', 'Write for example "in": 0.'));
  if (s.speed !== undefined && !(typeof s.speed === 'number' && s.speed >= 0.25 && s.speed <= 4)) out.push(error(at + '.speed', '"speed" is from 0.25 to 4; it is ' + JSON.stringify(s.speed) + '.', 'Write a number from 0.25 to 4, or remove it for normal speed.'));
  if ('color' in s && (typeof s.color !== 'string' || !s.color.trim())) out.push(error(at + '.color', 'A colour is a CSS colour such as "#101014".', 'Write "color": "#101014".'));
  if ('card' in s && !(isObject(s.card) && typeof s.card.title === 'string' && s.card.title.trim())) out.push(error(at + '.card.title', 'A card needs a title.', 'Write "card": { "title": "a few words" }.'));
  if ('scene' in s && s.slots !== undefined && !(isObject(s.slots) && Object.values(s.slots).every((v) => typeof v === 'string')))
    out.push(error(at + '.slots', '"slots" gives the scene\'s data-slot places new content: an object from a slot name to a text (or a picture path).', 'Write "slots": { "title": "new words" }, or remove it.'));
  return [...out, ...fillValueProblems(s, at)];
};

/** A card's title and lines against what a card holds on this canvas (slots.card). */
const cardProblems = (pkg: TemplatePackage, s: Shot, k: number): Problem[] => {
  const c = pkg.slots.card;
  if (!c || !isObject(s.card)) return [];
  const at = 'shots[' + k + '].card';
  const over = (text: string, cap: Capacity, where: string, what: string): Problem[] =>
    usageOf(text, cap) <= 1 + 1e-9 ? [] : [error(where, what + ' has ' + charsOf(text).length + ' characters; it holds ' + cap.cjk + ' full-width or ' + cap.latin + ' Latin characters on ' + cap.lines + ' line' + (cap.lines === 1 ? '' : 's') + '.', 'Shorten it, for example to ' + quote(shortened(text, cap)) + '.')];
  const lines = Array.isArray(s.card.lines) ? s.card.lines.filter((l): l is string => typeof l === 'string') : [];
  return [
    ...(typeof s.card.title === 'string' ? over(s.card.title, c.title, at + '.title', 'The title of the card in shot ' + (k + 1)) : []),
    ...(lines.length > c.lines ? [error(at + '.lines', 'The card in shot ' + (k + 1) + ' has ' + lines.length + ' lines; ' + c.lines + ' fit on the canvas.', 'Keep the first ' + c.lines + ' lines, or join short ones.')] : []),
    ...lines.flatMap((l, j) => over(l, c.line, at + '.lines[' + j + ']', 'Line ' + (j + 1) + ' of the card in shot ' + (k + 1))),
  ];
};

/**
 * A shot's laid-on words against its places (slots.json shots[k].words): no more lines than places, each about as
 * long as its place holds. The limit is estimated from the box, so a longer line is a warning; the layout check says
 * whether it fits.
 */
const wordSlotProblems = (pkg: TemplatePackage, s: Shot, k: number): Problem[] => {
  const slots = pkg.slots.shots[k]?.words ?? [];
  const at = 'shots[' + k + ']';
  const shape = wordProblems(s, at, slots.length);
  if (shape.length || !Array.isArray(s.words)) return shape;
  return (s.words as string[]).flatMap((w, j) => {
    const slot = slots[j], text = unmark(w).text;
    if (!slot || usageOf(text, slot.max) <= 1 + 1e-9) return [];
    return [warning(at + '.words[' + j + ']', 'Line ' + (j + 1) + ' of the words of shot ' + (k + 1) + ' has ' + charsOf(text).length + ' characters; its place holds about ' + slot.max.cjk + ' full-width or ' + slot.max.latin + ' Latin characters on one line.', 'Shorten it, for example to ' + quote(shortened(text, slot.max)) + '.')];
  });
};

/** The fill's bar against the template's (slots.json bar): no more words than places, each about as long as its place holds. */
const barSlotProblems = (pkg: TemplatePackage, fill: RetargetPlan): Problem[] => {
  const places = pkg.slots.bar?.words ?? [];
  const shape = barProblems(fill.bar, places.length);
  if (shape.length || !Array.isArray(fill.bar)) return shape;
  return fill.bar.flatMap((w, j) => {
    const slot = places[j];
    if (!slot || typeof w !== 'string' || usageOf(w, slot.max) <= 1 + 1e-9) return [];
    return [warning('bar[' + j + ']', 'Word ' + (j + 1) + ' of the bar has ' + charsOf(w).length + ' characters; its place holds about ' + slot.max.cjk + ' full-width or ' + slot.max.latin + ' Latin characters.', 'Shorten it, for example to ' + quote(shortened(w, slot.max)) + '.')];
  });
};

const shotProblems = (pkg: TemplatePackage, s: unknown, k: number): Problem[] => {
  const slot = pkg.slots.shots[k];
  if (!slot) return [];
  const at = 'shots[' + k + ']';
  const kinds = kindsOf(s);
  const example = EXAMPLE[slot.accepts[0] ?? 'color'];
  if (kinds.length !== 1)
    return [error(at, 'Shot ' + (k + 1) + ' is filled by exactly one of ' + slot.accepts.join(', ') + '; this one has ' + (kinds.length ? kinds.join(' and ') : 'none') + '.', 'For example ' + example + '.', slot.accepts)];
  const kind = kinds[0] as string;
  // A scene draws the whole shot itself, so every slot takes one; slots.json lists the fills the source suggests.
  if (kind === 'scene') return valueProblems(s as Shot, at);
  if (kind === 'keep') return [error(at + '.keep', '"keep" shows the reference\'s own footage, and a template has no reference.', 'Fill shot ' + (k + 1) + ' with ' + slot.accepts.join(', ') + ', for example ' + example + '.', slot.accepts)];
  if (!(slot.accepts as string[]).includes(kind))
    return [error(at, 'Shot ' + (k + 1) + ' is ' + slot.seconds + ' s; it accepts ' + slot.accepts.join(', ') + ', not ' + kind + (kind === 'card' ? ' (a card needs at least 1 s to be read)' : '') + '.', 'Use ' + example + '.', slot.accepts)];
  return [...valueProblems(s as Shot, at), ...cardProblems(pkg, s as Shot, k)];
};

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const labOf = (c: string): [number, number, number] | undefined => {
  if (!HEX.test(c)) return undefined;
  const h = c.length === 4 ? '#' + [...c.slice(1)].map((x) => x + x).join('') : c;
  return toLab(hexToRgb(h));
};

/** Two colour shots side by side whose colours are too close: the cut between them would not show. */
const colourProblems = (fill: RetargetPlan): Problem[] =>
  fill.shots.flatMap((s, k) => {
    const prev: unknown = fill.shots[k - 1], cur: unknown = s;
    if (!isObject(prev) || !isObject(cur) || typeof prev.color !== 'string' || typeof cur.color !== 'string') return [];
    const a = labOf(prev.color), b = labOf(cur.color);
    const d = a && b ? deltaE(a, b) : prev.color.trim().toLowerCase() === cur.color.trim().toLowerCase() ? 0 : Infinity;
    if (d >= CLOSE_COLOURS) return [];
    const other = a && a[0] < 50 ? '#f2f2f2' : '#141414';
    return [error('shots[' + k + '].color', 'Shots ' + k + ' and ' + (k + 1) + ' are colours ' + prev.color + ' and ' + cur.color + ', too close (ΔE ' + d.toFixed(1) + ', at least ' + CLOSE_COLOURS + ' is needed): the change between them would not show, and the template\'s cut there would be lost.',
      'Give shots[' + k + '] a clearly different colour, for example "' + other + '".')];
  });

const BREAK = /[\s,.;:!?，。、；：！？]/;

/** The longest start of a line that fits, cut back to a word or clause break when one lies in its second half. */
const shortened = (line: string, cap: Pick<Capacity, 'cjk' | 'latin'>): string => {
  const chars = charsOf(line);
  let n = 0;
  while (n < chars.length && usageOf(chars.slice(0, n + 1).join(''), cap) <= 1 + 1e-9) n++;
  const cut = chars.slice(0, n);
  const brk = cut.map((c, i) => (BREAK.test(c) ? i : -1)).filter((i) => i >= n / 2).pop();
  return (brk !== undefined && brk > 0 ? cut.slice(0, brk) : cut).join('').replace(/[\s,.;:，。、；：]+$/u, '');
};

const captionProblems = (pkg: TemplatePackage, fill: RetargetPlan): Problem[] => {
  const cap = pkg.slots.captions?.capacity;
  const beats = pkg.template.captions?.beats.length ?? 0;
  const lines = fill.captions ?? [];
  if (!cap) return [];
  return lines.slice(0, beats).flatMap((line, i) => {
    if (usageOf(line, cap) <= 1 + 1e-9) return [];
    const chars = charsOf(line).length;
    const script = scriptOf(line);
    const holds = script === 'cjk' ? cap.cjk : cap.latin;
    const short = shortened(line, cap);
    const rest = charsOf(line).slice(charsOf(short).length).join('').replace(/^[\s,.;:，。、；：]+/u, '');
    const j = [i + 1, i - 1].find((x) => x >= 0 && x < beats && x < lines.length && usageOf((lines[x] ?? '') + (script === 'cjk' ? '' : ' ') + rest, cap) <= 1);
    return [error('captions[' + i + ']',
      'Caption line ' + (i + 1) + ' has ' + chars + ' characters; this slot holds ' + holds + ' ' + (script === 'cjk' ? 'full-width' : 'Latin') + ' characters (' + cap.cjk + ' full-width or ' + cap.latin + ' Latin, ' + cap.lines + ' line' + (cap.lines === 1 ? '' : 's') + ' of the caption band' + (cap.measured ? '' : ', estimated') + ').',
      'Shorten it by ' + Math.max(1, chars - charsOf(short).length) + ' or more characters, for example to ' + quote(short) + (j !== undefined ? ', or split it over two beats: move ' + quote(rest) + ' to captions[' + j + ']' : '') + '.')];
  });
};

/** A line shorter than this share of the reference's text in its beat is reported: such a line is usually a cut, not a choice. */
const FRAGMENT = 0.4;
/** A beat whose reference text is shorter than this is not compared: its lines are short anyway. */
const FRAGMENT_FROM = 5;

/**
 * Lines far shorter than what the reference said or showed in their beats (in the same script): cut down to fit a
 * budget, they no longer say anything whole. An empty line and a beat the readers were unsure of are left alone.
 */
const fragmentProblems = (pkg: TemplatePackage, fill: RetargetPlan): Problem[] =>
  (fill.captions ?? []).flatMap((line, i): Problem[] => {
    const example = pkg.slots.captions?.lines[i]?.unsure ? undefined : pkg.slots.captions?.lines[i]?.example;
    const n = charsOf(line).length;
    if (!example || !n || example.chars < FRAGMENT_FROM || n >= FRAGMENT * example.chars || scriptOf(line) !== scriptOf(example.text)) return [];
    const said = charsOf(example.text).length > 24 ? charsOf(example.text).slice(0, 24).join('') + '…' : example.text;
    return [warning('captions[' + i + ']',
      'The line has ' + n + ' characters; the reference has ' + example.chars + ' in this beat (' + quote(said) + '). A line this much shorter is usually cut to fit, and no longer says anything whole.',
      'Say something whole: move words from a neighbouring line into this beat, or split one sentence over two beats; never cut a line to a fragment.')];
  });

/** One picture filling more than this many shots, or more than this share of the video, makes a slide show. */
const STILL_SHOTS = 2;
const STILL_SHARE = 1 / 3;

const listOf = (xs: string[]): string => (xs.length > 1 ? xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1] : xs[0] ?? '');

/**
 * A still that fills several shots: the same picture (the same bytes, whatever its name) as the fill of more than two
 * shots or of more than a third of the video. Missing files are reported by fileProblems.
 */
const stillProblems = async (rt: Runtime, pkg: TemplatePackage, fill: RetargetPlan, dir: string, lengths?: number[]): Promise<Problem[]> => {
  const frames = lengths ?? pkg.template.shots.map((s) => s.frames);
  const total = frames.reduce((a, b) => a + b, 0);
  const fps = pkg.template.canvas.fps;
  const same = new Map<string, { name: string; shots: number[] }>();
  for (const [k, raw] of fill.shots.entries()) {
    const s = raw as Shot;
    if (k >= frames.length || kindsOf(s).length !== 1 || typeof s.picture !== 'string' || !s.picture.trim() || isOutside(s.picture)) continue;
    const key = await sha256File(rt, rt.path.resolve(dir, s.picture)).catch(() => undefined);
    if (!key) continue;
    const seen = same.get(key) ?? { name: s.picture, shots: [] };
    same.set(key, { ...seen, shots: [...seen.shots, k] });
  }
  return [...same.values()].flatMap(({ name, shots }) => {
    const used = shots.reduce((n, k) => n + (frames[k] ?? 0), 0);
    if (shots.length <= STILL_SHOTS && used <= STILL_SHARE * total) return [];
    const where = listOf(shots.map((k) => 'shots[' + k + ']'));
    return [warning('shots[' + shots[0] + '].picture',
      quote(name) + ' fills ' + where + ': ' + (used / fps).toFixed(1) + ' s of the video\'s ' + (total / fps).toFixed(1) + ' s (' + Math.round((100 * used) / Math.max(1, total)) + '%). One still over ' + (shots.length > 1 ? 'several shots' : 'so long a shot') + ' plays as a slide show.',
      'Move a camera over it: record it with the capture director, one zoom step to another part for each shot (popost video capture file://<its absolute path> --size <its width>x<its height> --plan plan.json; for a page, record the page itself with --plan instead of one --still; video-tools.md, "Capture plans"), and fill ' + (shots.length > 1 ? 'each shot with that footage from its own "in"' : 'the shot with that footage') + '; or give ' + (shots.length > 1 ? 'the shots' : 'it') + ' other material.')];
  });
};

/** A footage fill against the frames its shot needs (lengths: the shots' lengths, the template's by default). */
const footageLength = async (rt: Runtime, pkg: TemplatePackage, s: Shot, k: number, file: string, lengths?: number[]): Promise<Problem[]> => {
  const at = 'shots[' + k + ']';
  const f = await probe(rt, file).catch(() => undefined);
  if (!f || !(f.frames > 0)) return [error(at + '.footage', quote(String(s.footage)) + ' is not a video this engine can read.', 'Use an MP4, MOV or WebM file, for example converted with: ffmpeg -i input -c:v libx264 -pix_fmt yuv420p out.mp4.')];
  const fps = pkg.template.canvas.fps;
  const need = footageNeed(pkg.template, k, lengths);
  const from = typeof s.in === 'number' ? s.in : 0, speed = typeof s.speed === 'number' ? s.speed : 1;
  const used = Math.round(((need - 1) * f.fps * speed) / fps);
  const last = from + used;
  if (last <= f.frames - 1) return [];
  const has = quote(String(s.footage)) + ' has ' + f.frames + ' frames (' + (f.frames / f.fps).toFixed(2) + ' s at ' + Number(f.fps.toFixed(3)) + ' fps)';
  const slower = Math.floor((((f.frames - 1 - from) * fps) / Math.max(1, (need - 1) * f.fps)) * 100) / 100;
  const earlier = f.frames - 1 - used;
  const ways = [
    'use a clip with at least ' + ((need * speed) / fps).toFixed(2) + ' s after "in"',
    ...(from > 0 && earlier >= 0 ? ['start earlier ("in": ' + earlier + ')'] : []),
    ...(slower >= 0.25 ? ['slow it down ("speed": ' + slower + ')'] : []),
  ];
  return [error(at + '.footage', 'Shot ' + (k + 1) + ' needs ' + need + ' frames of footage (' + (need / fps).toFixed(2) + ' s at speed 1, the shot and half the transition after it), but ' + has + ': from frame ' + from + ' at speed ' + speed + ' it runs out ' + (last - f.frames + 1) + ' source frames early and its last frame holds.',
    ways.length > 1 ? ways.slice(0, -1).join(', ') + ' or ' + ways[ways.length - 1] + '.' : ways[0] + '.')];
};

/** A path a fill gives a picture place of a scene: the shot, the place, the path as written, the scene, and its file in the project. */
export interface SlotPicture { k: number; slot: string; value: string; scene: string; file: string }

/**
 * The paths a fill gives the picture places of its scenes (data-slot on an <img>), with the file each names in the
 * project: like every path in a scene, it is relative to the scene file. Scenes that cannot be read are left out
 * (their own check says why), and so is a value that is an address (data:, https:) rather than a path.
 */
export const slotPictures = async (rt: Runtime, fill: RetargetPlan, dir: string): Promise<SlotPicture[]> => {
  const out: SlotPicture[] = [];
  for (const [k, raw] of fill.shots.entries()) {
    const s = raw as Shot;
    if (typeof s.scene !== 'string' || isOutside(s.scene) || !isObject(s.slots)) continue;
    const scene = s.scene;
    const html = await rt.fs.readText(rt.path.resolve(dir, scene)).catch(() => undefined);
    for (const slot of html === undefined ? [] : pictureSlotNames(html)) {
      const value = s.slots[slot];
      if (typeof value !== 'string' || !value.trim() || /^[a-z][a-z0-9+.-]*:/i.test(value)) continue;
      out.push({ k, slot, value, scene, file: rt.path.join(rt.path.dirname(scene), value) });
    }
  }
  return out;
};

/** A picture place's path that leads nowhere: what it names, from where, and the path that would work. */
const slotPictureProblems = async (rt: Runtime, p: SlotPicture, dir: string): Promise<Problem[]> => {
  const exists = async (f: string): Promise<boolean> => (await rt.fs.stat(f)) !== null;
  const at = 'shots[' + p.k + '].slots.' + p.slot;
  const from = rt.path.dirname(p.scene);
  const folder = from === '.' ? 'the project directory' : 'the folder ' + from + '/';
  const what = quote(p.value) + ', the picture of the place "' + p.slot + '" in ' + p.scene + ',';
  if (!isOutside(p.file) && (await exists(rt.path.resolve(dir, p.file))))
    return PICTURES.includes(rt.path.extname(p.file).toLowerCase()) ? [] : [error(at, what + ' is not a picture file (' + PICTURES.join(', ') + ').', 'Convert it to WebP or PNG.')];
  const message = what + ' does not exist: the path of a picture place is relative to the scene file (' + folder + '), so it names "' + p.file + '" in ' + dir + '.';
  // The usual slip: a path written from the project directory, where the picture is.
  if (!isOutside(p.value) && (await exists(rt.path.resolve(dir, p.value))))
    return [error(at, message, 'Write "' + rt.path.relative(from, p.value) + '": the picture is at "' + p.value + '" in the project, and the path starts from ' + folder + '.')];
  const example = rt.path.relative(from, 'assets/' + rt.path.basename(p.file));
  return [error(at, message, 'Put the picture at ' + rt.path.join(dir, isOutside(p.file) ? 'assets/' + rt.path.basename(p.file) : p.file) + ', or correct the path so that it leads from ' + folder + ' to the picture (for a picture in assets/: "' + example + '").')];
};

/** The files of a shot's items (shotItemProblems checked their shape): there, of their kind, and how they sit in their boxes. */
/** A clip item against its shot, which it plays through (lengths: the shots' lengths, the template's by default): a warning when it runs out and its last frame holds. */
export const itemLength = async (rt: Runtime, pkg: TemplatePackage, o: { at: string; name: string; file: string; k: number; from: number; speed: number; lengths?: number[]; span?: [number, number] }): Promise<Problem[]> => {
  const f = await probe(rt, o.file).catch(() => undefined);
  if (!f || !(f.frames > 0)) return [error(o.at + '.video', quote(o.name) + ' is not a video this engine can read.', 'Use an MP4, MOV or WebM file, for example converted with: ffmpeg -i input -c:v libx264 -pix_fmt yuv420p out.mp4.')];
  const fps = pkg.template.canvas.fps;
  const [start, end] = itemSpan((o.lengths ?? fillLengths(pkg.template))[o.k] ?? 1, o.span);
  const need = end - start;
  const last = o.from + Math.round(((need - 1) * f.fps * o.speed) / fps);
  if (last <= f.frames - 1) return [];
  const has = (f.frames - o.from) / f.fps / o.speed;
  return [warning(o.at + '.video', 'Shot ' + (o.k + 1) + ' is ' + (need / fps).toFixed(2) + ' s, but its clip ' + quote(o.name) + ' has ' + Math.max(0, has).toFixed(2) + ' s of frames of clip from "in": ' + o.from + (o.speed !== 1 ? ' at speed ' + o.speed : '') + ', so its last frame holds for the last ' + (need / fps - Math.max(0, has)).toFixed(2) + ' s.',
    'Use a clip with at least ' + ((need * o.speed) / fps).toFixed(2) + ' s after "in"' + (o.from > 0 ? ', start it earlier' : '') + ', or let it hold if a still end is meant.')];
};

const itemFileProblems = async (rt: Runtime, pkg: TemplatePackage, s: Shot, k: number, dir: string, lengths?: number[]): Promise<Problem[]> => {
  const out: Problem[] = [];
  for (const [j, item] of (Array.isArray(s.items) ? s.items : []).entries()) {
    const key = isObject(item) ? (['video', 'image'] as const).find((x) => typeof item[x] === 'string') : undefined;
    const file = key && isObject(item) ? String(item[key]) : '';
    if (!key || !isObject(item) || !file.trim() || isOutside(file) || !Array.isArray(item.box)) continue;
    const at = 'shots[' + k + '].items[' + j + ']', full = rt.path.resolve(dir, file);
    if ((await rt.fs.stat(full)) === null) { out.push(error(at + '.' + key, quote(file) + ' does not exist in ' + dir + '.', 'Put the file there, or correct the path (it is relative to the project directory).')); continue; }
    if (key === 'image' && !PICTURES.includes(rt.path.extname(file).toLowerCase())) { out.push(error(at + '.image', quote(file) + ' is not a picture file (' + PICTURES.join(', ') + ').', 'Convert it to WebP or PNG.')); continue; }
    out.push(...(await itemFitProblems(rt, pkg.template.canvas, { at, key, name: file, file: full, box: item.box as number[], fit: item.fit })));
    const span: [number, number] | undefined = Array.isArray(item.span) && item.span.length === 2 && item.span.every((v) => typeof v === 'number' && Number.isFinite(v)) ? [item.span[0] as number, item.span[1] as number] : undefined;
    if (key === 'video') out.push(...(await itemLength(rt, pkg, { at, name: file, file: full, k, from: typeof item.in === 'number' ? item.in : 0, speed: typeof item.speed === 'number' ? item.speed : 1, ...(span ? { span } : {}), ...(lengths ? { lengths } : {}) })));
  }
  return out;
};

const fileProblems = async (rt: Runtime, pkg: TemplatePackage, fill: RetargetPlan, dir: string, lengths?: number[]): Promise<Problem[]> => {
  const exists = async (p: string): Promise<boolean> => (await rt.fs.stat(p)) !== null;
  const out: Problem[] = [];
  const missing = (at: string, file: string): Problem => error(at, quote(file) + ' does not exist in ' + dir + '.', 'Put the file there, or correct the path (it is relative to the project directory).');
  for (const [k, raw] of fill.shots.entries()) {
    const s = raw as Shot;
    if (k >= pkg.template.shots.length || kindsOf(s).length !== 1) continue;
    for (const key of ['footage', 'picture', 'scene'] as const) {
      const file = s[key];
      if (typeof file !== 'string' || !file.trim() || isOutside(file)) continue;
      const full = rt.path.resolve(dir, file);
      if (!(await exists(full))) { out.push(missing('shots[' + k + '].' + key, file)); continue; }
      if (key === 'picture' && !PICTURES.includes(rt.path.extname(file).toLowerCase())) out.push(error('shots[' + k + '].picture', quote(file) + ' is not a picture file (' + PICTURES.join(', ') + ').', 'Convert it to WebP or PNG.'));
      if (key === 'scene' && !PAGES.includes(rt.path.extname(file).toLowerCase())) out.push(error('shots[' + k + '].scene', quote(file) + ' is not an HTML file.', 'A scene is one HTML page, such as "scenes/shot-01.html" (references/video-scenes.md says what it may do).'));
      if (key === 'footage') out.push(...(await footageLength(rt, pkg, s, k, full, lengths)));
      if (key !== 'scene') out.push(...(await fitProblems(rt, pkg.template.canvas, { at: 'shots[' + k + ']', key, name: file, file: full, fit: s.fit, ground: s.ground, frame: typeof s.in === 'number' ? s.in : 0 })));
    }
    out.push(...(await itemFileProblems(rt, pkg, s, k, dir, lengths)));
  }
  if (typeof fill.sound === 'string' && !(await exists(rt.path.resolve(dir, fill.sound)))) out.push(missing('sound', fill.sound));
  out.push(...(await stillProblems(rt, pkg, fill, dir, lengths)));
  for (const p of await slotPictures(rt, fill, dir)) out.push(...(await slotPictureProblems(rt, p, dir)));
  return out;
};

/**
 * Problems of a fill for a template. o.dir: the directory the fill's paths are relative to (the project directory, or
 * where the assets are); without it, files are not looked at. o.lengths: the shots' lengths when they are not the
 * template's (after the speech re-flow).
 */
export const checkFill = async (rt: Runtime, pkg: TemplatePackage, fill: RetargetPlan, o: { dir?: string; lengths?: number[] } = {}): Promise<Problem[]> => {
  const shape = shapeProblems(fill);
  if (shape.some((p) => p.level === 'error')) return shape;
  shape.push(...captionOptionProblems(fill));
  if (shape.some((p) => p.level === 'error')) return shape;
  // Lengths are those of what is drawn and spoken: the *marks* of highlighted words are neither (retarget/marks.ts).
  const counted: RetargetPlan = fill.captions ? { ...fill, captions: fill.captions.map((l) => (typeof l === 'string' ? unmark(l).text : l)) } : fill;
  const out = [...shape, ...countProblems(pkg, fill), ...fill.shots.flatMap((s, k) => [...shotProblems(pkg, s, k), ...(isObject(s) ? [...shotItemProblems(s, 'shots[' + k + ']'), ...wordSlotProblems(pkg, s, k)] : [])]), ...colourProblems(fill), ...barSlotProblems(pkg, fill), ...captionProblems(pkg, counted), ...fragmentProblems(pkg, counted)];
  // What the reading of the frames says: an effect a scene must draw, the layout kept, the platform's words never shown.
  const reading = readingOfTemplate(pkg, (p) => (pkg.dir ? rt.path.relative(rt.cwd, rt.path.resolve(pkg.dir, p)) : p));
  const scenes = o.dir && hasReading(reading) ? await sceneSources(rt, o.dir, fill.shots.flatMap((s: unknown) => (isObject(s) && typeof s.scene === 'string' && !isOutside(s.scene) ? [s.scene] : []))) : new Map<string, string>();
  const read = fillReadingProblems(reading, fill, scenes);
  return o.dir ? [...out, ...read, ...(await fileProblems(rt, pkg, fill, o.dir, o.lengths))] : [...out, ...read];
};
