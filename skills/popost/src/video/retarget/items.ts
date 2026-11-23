/**
 * Items over a shot's base, in the fill (fill.json, a retarget plan): a clip or a picture drawn in a box of the canvas
 * over the shot, such as a screen recording in the frame a scene draws ("Footage inside a scene", video-scenes.md).
 * They live in the fill, not in video.json, because template fill writes video.json again each time: an item added
 * there by hand is lost at the next fill. Each item becomes a track of the project during its shot's segment, so it
 * moves and stretches with the shot when time is re-flowed to speech.
 */
import type { Box, Problem, Track } from '../types';

/** fit: 'cover' fills the box and crops (default), 'contain' shows it whole. radius: a fraction of the box's smaller side. in: the clip's first frame. */
export type ShotItem =
  | { video: string; box: Box; fit?: 'cover' | 'contain'; radius?: number; mask?: 'ellipse'; in?: number; speed?: number }
  | { image: string; box: Box; fit?: 'cover' | 'contain'; radius?: number; mask?: 'ellipse' };

const EXAMPLE = '{ "video": "assets/app.mp4", "box": [0.6, 0.1, 0.2531, 0.8], "fit": "cover", "radius": 0.07, "in": 0 }';
const KEYS = ['video', 'image', 'box', 'fit', 'radius', 'mask', 'in', 'speed'];
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const err = (at: string, message: string, fix: string): Problem => ({ level: 'error', at, message, fix });

/** One item's shape: a file, a box inside the canvas, and values the engine takes. */
const itemProblems = (item: unknown, at: string): Problem[] => {
  if (!isObject(item)) return [err(at, 'An item is an object with "video" or "image" and a "box".', 'Write ' + EXAMPLE + '.')];
  const out: Problem[] = Object.keys(item).filter((k) => !KEYS.includes(k)).map((k) => ({ level: 'warning' as const, at: at + '.' + k, message: 'An item has no key "' + k + '"; it is ignored.', allowed: KEYS, fix: 'Remove it.' }));
  const files = (['video', 'image'] as const).filter((k) => k in item);
  if (files.length !== 1 || typeof item[files[0] ?? 'video'] !== 'string' || !String(item[files[0] ?? 'video']).trim())
    out.push(err(at, 'An item shows one file: "video" (a clip) or "image" (a picture), a path in the project.', 'Write "video": "assets/app.mp4" or "image": "assets/shot.webp".'));
  const box = item.box;
  const inside = Array.isArray(box) && box.length === 4 && box.every((v) => typeof v === 'number' && Number.isFinite(v))
    && box[2] > 0 && box[3] > 0 && box[0] >= -0.001 && box[1] >= -0.001 && box[0] + box[2] <= 1.001 && box[1] + box[3] <= 1.001;
  if (!inside) out.push(err(at + '.box', '"box" is [x, y, width, height] as fractions of the canvas, inside it; it is ' + JSON.stringify(box) + '.', 'Divide the opening in canvas pixels by the canvas size: a screen at [768, 72, 324, 576] px of 1280x720 is [0.6, 0.1, 0.2531, 0.8].'));
  if (item.fit !== undefined && item.fit !== 'cover' && item.fit !== 'contain') out.push(err(at + '.fit', '"fit" is "cover" (fill the box, crop) or "contain" (show it whole); it is ' + JSON.stringify(item.fit) + '.', 'Write "fit": "cover".'));
  if (item.radius !== undefined && !(typeof item.radius === 'number' && item.radius >= 0 && item.radius <= 0.5)) out.push(err(at + '.radius', '"radius" rounds the corners: a fraction of the box\'s smaller side, 0 to 0.5; it is ' + JSON.stringify(item.radius) + '.', 'Write "radius": 0.07.'));
  if (item.mask !== undefined && item.mask !== 'ellipse') out.push(err(at + '.mask', '"mask" can only be "ellipse".', 'Remove it, or write "mask": "ellipse".'));
  if ('image' in item && (item.in !== undefined || item.speed !== undefined)) out.push(err(at, '"in" and "speed" are for a clip, not a picture.', 'Remove them.'));
  if (item.in !== undefined && !(Number.isInteger(item.in) && (item.in as number) >= 0)) out.push(err(at + '.in', '"in" is the clip\'s first frame, a whole number from 0; it is ' + JSON.stringify(item.in) + '.', 'Write "in": 0.'));
  if (item.speed !== undefined && !(typeof item.speed === 'number' && item.speed >= 0.25 && item.speed <= 4)) out.push(err(at + '.speed', '"speed" is 0.25 to 4; it is ' + JSON.stringify(item.speed) + '.', 'Write "speed": 1, or remove it.'));
  return out;
};

/** The items of a shot of a fill: a list of items, each well formed. */
export const shotItemProblems = (shot: Record<string, unknown>, at: string): Problem[] => {
  if (shot.items === undefined) return [];
  if (!Array.isArray(shot.items)) return [err(at + '.items', '"items" is a list of clips and pictures to draw over the shot.', 'Write "items": [' + EXAMPLE + '].')];
  if ('keep' in shot && shot.items.length) return [err(at + '.items', 'A shot that keeps the reference\'s footage takes no items.', 'Make the shot a scene and put the items on it.')];
  return shot.items.flatMap((item, j) => itemProblems(item, at + '.items[' + j + ']'));
};

/** The file each item shows, with its kind. */
export const itemFile = (item: ShotItem): { file: string; kind: 'video' | 'image' } => ('video' in item ? { file: item.video, kind: 'video' } : { file: item.image, kind: 'image' });

/** The tracks of a shot's items, during its segment: "<segment>-video-1", "<segment>-image-2", in the order given (later is nearer). */
export const itemTracks = (segment: string, items: readonly ShotItem[], use: (file: string, kind: 'video' | 'image') => string): Track[] =>
  items.map((item, j): Track => {
    const { file, kind } = itemFile(item);
    const look = { box: item.box, fit: item.fit ?? 'cover', ...(item.radius ? { radius: item.radius } : {}), ...(item.mask ? { mask: item.mask } : {}) };
    const id = segment + '-' + kind + '-' + (j + 1);
    if ('video' in item) return { id, type: 'video', material: use(file, 'video'), ...look, ...(item.in !== undefined ? { in: item.in } : {}), ...(item.speed && item.speed !== 1 ? { speed: item.speed } : {}), during: { segment } };
    return { id, type: 'image', material: use(file, 'image'), ...look, during: { segment } };
  });
