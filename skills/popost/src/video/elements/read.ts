/**
 * The shape of elements.json: what a program can say about the file alone, before it is held to the measurement
 * (check.ts). Every problem names its place as a JSON path and gives one fix, for the model that wrote the file. What
 * is well formed is returned, so that the comparison still runs on the rest: a layer with an error is left out of its
 * shot, a shot whose number, time or layers are wrong is left out, and the shots that have an entry are listed apart.
 */
import { error, warning } from '../project/check-common';
import { TRANSITION_KINDS, type Box, type Problem } from '../types';
import { LAYER_KINDS, MARKS, ROLES, type Elements, type Layer, type Mark, type ReadTransition, type ShotReading } from './types';

const SHOT_KEYS = ['shot', 'time', 'job', 'layout', 'sameEffectAsNext', 'transitionIn', 'layers', 'captions', 'emphasis', 'rebuild', 'drop'];
const LAYER_KEYS = ['id', 'kind', 'box', 'look', 'content', 'role', 'enters', 'moves', 'leaves'];
const TRANSITION_KEYS = ['kind', 'seconds', 'description'];
const READ_KINDS: readonly string[] = [...TRANSITION_KINDS, 'custom'];
const LAYER_EXAMPLE = '{"id": "title", "kind": "title", "box": [0.1, 0.2, 0.8, 0.15], "look": "white heavy sans, 7% of the height, yellow underline", "content": "the question the video answers", "role": "content"}';
/** A box may run past the frame by this much (a reader's rounding). */
const SLACK = 0.01;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string';
const filled = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
const hasError = (ps: readonly Problem[]): boolean => ps.some((p) => p.level === 'error');

const extraKeys = (o: Record<string, unknown>, keys: readonly string[], at: string): Problem[] =>
  Object.keys(o).filter((k) => !keys.includes(k)).map((k) => warning(at + '.' + k, 'There is no key "' + k + '" here; it is ignored.', 'Remove it, or use one of the keys listed.', [...keys]));

/** Words a key holds when it is there: free text, never a number or a list. */
const wordsProblems = (o: Record<string, unknown>, keys: readonly string[], at: string): Problem[] =>
  keys.filter((k) => o[k] !== undefined && !isText(o[k])).map((k) => error(at + '.' + k, '"' + k + '" is free words; it is ' + JSON.stringify(o[k]) + '.', 'Write it as a string, or leave it out.'));

export const boxProblems = (box: unknown, at: string): Problem[] => {
  if (!(Array.isArray(box) && box.length === 4 && box.every(isNumber)))
    return [error(at, '"box" is [x, y, width, height] as shares of the frame (0 to 1); it is ' + JSON.stringify(box) + '.', 'Write for example "box": [0.1, 0.7, 0.8, 0.12]: from 10% of the width and 70% of the height, 80% wide and 12% high.')];
  const [x, y, w, h] = box as Box;
  if (w <= 0 || h <= 0) return [error(at, 'The box ' + JSON.stringify(box) + ' has no area: its width and height are more than 0.', 'Give the width and height of the layer as shares of the frame.')];
  if (x < -SLACK || y < -SLACK || x + w > 1 + SLACK || y + h > 1 + SLACK) {
    const pixels = box.some((v) => v > 1.5) ? ' It looks like pixels: divide x and width by the frame\'s width, y and height by its height.' : '';
    return [error(at, 'The box ' + JSON.stringify(box) + ' lies outside the frame: x and y are at least 0, x + width and y + height at most 1.' + pixels, 'Give the part of the layer that is inside the frame, as shares of the frame.')];
  }
  return [];
};

const layerOf = (raw: unknown, at: string): { layer?: Layer; problems: Problem[] } => {
  if (!isObject(raw)) return { problems: [error(at, 'A layer is an object with "id", "kind", "box", "look", "content" and "role".', 'Write ' + LAYER_EXAMPLE + '.')] };
  const out = extraKeys(raw, LAYER_KEYS, at);
  if (!filled(raw.id)) out.push(error(at + '.id', 'A layer needs an "id": a short name, unique in its shot.', 'Write "id": "title" (or "page", "mark", "ground").'));
  if (!oneOf(LAYER_KINDS, raw.kind)) out.push(error(at + '.kind', '"kind" is ' + JSON.stringify(raw.kind) + '; it is one of the kinds listed.', 'Write the kind that names what the layer is; "other" when none does.', [...LAYER_KINDS]));
  if (!oneOf(ROLES, raw.role)) out.push(error(at + '.role', '"role" is ' + JSON.stringify(raw.role) + '; it is design (keep the look), content (the new subject goes here), platform or creator (never re-made).', 'Write one of the roles listed.', [...ROLES]));
  out.push(...boxProblems(raw.box, at + '.box'));
  if (!isText(raw.look)) out.push(error(at + '.look', 'A layer needs a "look": its colours, shape, weight, outline, plate and angle, precisely enough to redraw it.', 'Write for example "look": "white heavy sans, 7% of the height, on a yellow plate with round corners".'));
  out.push(...wordsProblems(raw, ['content', 'enters', 'moves', 'leaves'], at));
  if (hasError(out)) return { problems: out };
  const layer = raw as unknown as Layer;
  if (layer.role === 'design' && !layer.look.trim()) out.push(warning(at + '.look', 'Layer "' + layer.id + '" keeps its look in the re-make, and its "look" is empty.', 'Say its colours, shape, weight, outline and angle, precisely enough to redraw it.'));
  if (layer.role === 'content' && !filled(layer.content)) out.push(warning(at + '.content', 'Layer "' + layer.id + '" is a place for the new subject, and its "content" does not say what the reference showed there.', 'Say what it shows or says, so that the re-make knows what to put in its place.'));
  const pick = (k: 'content' | 'enters' | 'moves' | 'leaves') => (filled(layer[k]) ? { [k]: layer[k] } : {});
  return { layer: { id: layer.id, kind: layer.kind, box: layer.box, look: layer.look, ...pick('content'), role: layer.role, ...pick('enters'), ...pick('moves'), ...pick('leaves') }, problems: out };
};

const transitionOf = (raw: unknown, at: string): { transition?: ReadTransition; problems: Problem[] } => {
  if (!isObject(raw)) return { problems: [error(at, '"transitionIn" is an object: {"kind", "seconds", "description"}.', 'Write {"kind": "cut"}, {"kind": "dissolve", "seconds": 0.4} or {"kind": "custom", "seconds": 0.8, "description": "..."}.')] };
  const out = extraKeys(raw, TRANSITION_KEYS, at);
  if (!oneOf(READ_KINDS, raw.kind)) out.push(error(at + '.kind', '"kind" is ' + JSON.stringify(raw.kind) + '; it is a standard transition the engine has, or "custom" for an effect of its own.', 'Write the standard kind the frames show, or "custom" with a "description".', [...READ_KINDS]));
  if (raw.seconds !== undefined && !(isNumber(raw.seconds) && raw.seconds >= 0)) out.push(error(at + '.seconds', '"seconds" is how long the change lasts, a number from 0; it is ' + JSON.stringify(raw.seconds) + '.', 'Write for example "seconds": 0.5, or leave it out.'));
  out.push(...wordsProblems(raw, ['description'], at));
  if (hasError(out)) return { problems: out };
  const t = raw as unknown as ReadTransition;
  return { transition: { kind: t.kind, ...(t.seconds !== undefined ? { seconds: t.seconds } : {}), ...(filled(t.description) ? { description: t.description } : {}) }, problems: out };
};

const captionsOf = (raw: unknown, at: string): { captions?: ShotReading['captions']; problems: Problem[] } => {
  if (!isObject(raw) || !isText(raw.base) || (raw.highlight !== undefined && !isText(raw.highlight)) || (raw.reveal !== undefined && !isText(raw.reveal)))
    return { problems: [error(at, '"captions" is {"base": "...", "highlight": "...", "reveal": "..."}: the style of the captions, the style of the words drawn differently and which words ("none" when none are), and how a line appears.', 'Write for example {"base": "white bold sans on a black plate", "highlight": "the key word in yellow", "reveal": "word by word as spoken"}.')] };
  if (raw.lines !== undefined && !(Array.isArray(raw.lines) && raw.lines.every(filled)))
    return { problems: [error(at + '.lines', '"lines" is a list of visually confirmed caption strings, or [] when the shot has none.', 'Copy the actual caption lines from the pictures; omit this field to keep the OCR roles.')] };
  return { captions: { base: raw.base, ...(filled(raw.highlight) ? { highlight: raw.highlight } : {}), ...(filled(raw.reveal) ? { reveal: raw.reveal } : {}), ...(Array.isArray(raw.lines) ? { lines: raw.lines as string[] } : {}) }, problems: extraKeys(raw, ['base', 'highlight', 'reveal', 'lines'], at) };
};

const marksOf = (raw: unknown, at: string): { emphasis: Mark[]; problems: Problem[] } => {
  if (!Array.isArray(raw)) return { emphasis: [], problems: [error(at, '"emphasis" is a list of marks: {"what", "on", "why"}.', 'Write [{"what": "box", "on": "the price", "why": "the line says it is free"}], or [] when nothing is marked.')] };
  const out: Problem[] = [];
  const emphasis = raw.flatMap((m, j): Mark[] => {
    const here = at + '[' + j + ']';
    if (!isObject(m) || !oneOf(MARKS, m.what) || !filled(m.on) || (m.why !== undefined && !isText(m.why))) {
      out.push(error(here, 'A mark is {"what", "on", "why"}: what kind of mark (' + MARKS.join(', ') + '), on what, and what the line at that moment says that makes it worth marking.', 'Write {"what": "box", "on": "the price", "why": "the line says it is free"}.', [...MARKS]));
      return [];
    }
    out.push(...extraKeys(m, ['what', 'on', 'why'], here));
    return [{ what: m.what, on: m.on, ...(filled(m.why) ? { why: m.why } : {}) }];
  });
  return { emphasis, problems: out };
};

/** One shot's own keys: its number, its time and its layers must be right for the shot to be kept. */
const headProblems = (raw: Record<string, unknown>, at: string): Problem[] => {
  const out: Problem[] = [];
  if (!(Number.isInteger(raw.shot) && (raw.shot as number) >= 1)) out.push(error(at + '.shot', '"shot" is the number of the measured shot, from 1; it is ' + JSON.stringify(raw.shot) + '.', 'Write the number questions lists for it, for example "shot": 3.'));
  const t = raw.time;
  if (!(Array.isArray(t) && t.length === 2 && t.every(isNumber) && (t[0] as number) >= 0 && (t[1] as number) > (t[0] as number)))
    out.push(error(at + '.time', '"time" is [start, end] in seconds, as questions lists it for the shot; it is ' + JSON.stringify(t) + '.', 'Copy the shot\'s time, for example "time": [2.4, 5.1].'));
  if (!filled(raw.layout)) out.push(error(at + '.layout', 'A shot needs a "layout": the kind of picture in generic words.', 'Write for example "layout": "a full-frame screen recording", "a window on a designed ground", "a title card" or "a person to camera with inserts".'));
  if (!Array.isArray(raw.layers) || !raw.layers.length) out.push(error(at + '.layers', 'A shot needs "layers": everything it shows, the ground first.', 'Write "layers": [{"id": "ground", "kind": "ground", "box": [0, 0, 1, 1], "look": "...", "role": "design"}, ...].'));
  if (raw.sameEffectAsNext !== undefined && typeof raw.sameEffectAsNext !== 'boolean') out.push(error(at + '.sameEffectAsNext', '"sameEffectAsNext" is true or false.', 'Write true when an animation of this shot runs across the boundary into the next one, else leave it out.'));
  return [...out, ...wordsProblems(raw, ['job', 'rebuild', 'drop'], at)];
};

const shotOf = (raw: unknown, k: number): { shot?: ShotReading; number?: number; problems: Problem[] } => {
  const at = 'shots[' + k + ']';
  if (!isObject(raw)) return { problems: [error(at, 'A shot is an object with "shot", "time", "layout", "layers" and the other keys of video-elements.md.', 'Write {"shot": ' + (k + 1) + ', "time": [0, 2.4], "layout": "...", "layers": [...]}.')] };
  const out = [...extraKeys(raw, SHOT_KEYS, at), ...headProblems(raw, at)];
  const number = Number.isInteger(raw.shot) && (raw.shot as number) >= 1 ? (raw.shot as number) : undefined;
  if (hasError(out)) return { ...(number ? { number } : {}), problems: out };
  const layers = (raw.layers as unknown[]).flatMap((l, j) => { const r = layerOf(l, at + '.layers[' + j + ']'); out.push(...r.problems); return r.layer ? [r.layer] : []; });
  const seen = new Set<string>();
  for (const [j, l] of layers.entries()) {
    if (seen.has(l.id)) out.push(error(at + '.layers[' + j + '].id', 'Two layers of shot ' + number + ' are called "' + l.id + '".', 'Give each layer of a shot its own id.'));
    seen.add(l.id);
  }
  const into = raw.transitionIn === undefined ? undefined : transitionOf(raw.transitionIn, at + '.transitionIn');
  const caps = raw.captions === undefined ? undefined : captionsOf(raw.captions, at + '.captions');
  const marks = raw.emphasis === undefined ? undefined : marksOf(raw.emphasis, at + '.emphasis');
  out.push(...(into?.problems ?? []), ...(caps?.problems ?? []), ...(marks?.problems ?? []));
  const r = raw as unknown as ShotReading;
  const shot: ShotReading = {
    shot: r.shot, time: [r.time[0], r.time[1]], ...(filled(r.job) ? { job: r.job } : {}), layout: r.layout,
    ...(r.sameEffectAsNext ? { sameEffectAsNext: true } : {}), ...(into?.transition ? { transitionIn: into.transition } : {}),
    layers, ...(caps?.captions ? { captions: caps.captions } : {}), ...(marks ? { emphasis: marks.emphasis } : {}),
    ...(filled(r.rebuild) ? { rebuild: r.rebuild } : {}), ...(filled(r.drop) ? { drop: r.drop } : {}),
  };
  return { shot, number: r.shot, problems: out };
};

export interface ReadElements {
  /** The well-formed part. */
  elements: Elements;
  /** The shot numbers that have an entry, well formed or not. */
  present: number[];
  /** Where each shot number's entry is in the file's list, for the places problems name. */
  where: Record<number, number>;
  problems: Problem[];
}

/** The shape of a parsed elements.json. */
export const readElements = (raw: unknown): ReadElements => {
  if (!isObject(raw) || !Array.isArray(raw.shots))
    return { elements: { shots: [] }, present: [], where: {}, problems: [error('shots', 'elements.json is {"shots": [...]}: one entry per measured shot.', 'Write {"shots": [{"shot": 1, ...}, {"shot": 2, ...}]}; popost video elements questions lists the shots.')] };
  const problems = extraKeys(raw, ['shots'], '(root)');
  const shots: ShotReading[] = [];
  const present: number[] = [];
  const where: Record<number, number> = {};
  raw.shots.forEach((s, k) => {
    const r = shotOf(s, k);
    problems.push(...r.problems);
    if (r.number !== undefined && present.includes(r.number)) problems.push(error('shots[' + k + '].shot', 'Shot ' + r.number + ' has two entries.', 'Keep one entry per shot; merge what the two say.'));
    else if (r.number !== undefined) { present.push(r.number); where[r.number] = k; }
    if (r.shot && !shots.some((x) => x.shot === r.number)) shots.push(r.shot);
  });
  return { elements: { shots: [...shots].sort((a, b) => a.shot - b.shot) }, present: [...present].sort((a, b) => a - b), where, problems };
};
