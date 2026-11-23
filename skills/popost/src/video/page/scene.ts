/**
 * A scene base in the page: an iframe that shows the scene's HTML file, held on the engine's clock. Every animation
 * of the scene's document is paused when the page is prepared and kept in a list (an animation that has ended drops
 * out of document.getAnimations(), and could not be taken back to an earlier frame otherwise). applyFrame sets all
 * of them to the frame's time and calls the scene's own render(seconds, fps) when it has one. Nothing of a scene is
 * drawn before a frame shows it.
 * A scene may also hand over timelines: anything that can be paused and taken to a time in seconds (seek or time),
 * as the timelines of animation libraries can. They are given as window.__popostScene.timeline, or under
 * window.__timelines (an object of timelines, a convention other tools use). The engine knows no library by name;
 * a scene brings its own as a script file of the project.
 */
import type { SceneFailure } from './contract';

export interface SceneNode {
  frame: HTMLIFrameElement;
  /** The index of the segment whose base it is: a failure names it, since several segments may show one file. */
  segment: number;
  /** Every animation the scene's document had when it was prepared, and any found later. */
  animations: Animation[];
  /** Effective animation times at the previous seek, including their final resting values. */
  clock?: string;
  /** New content for the places the scene marks with data-slot. */
  slots?: Record<string, string>;
}

/** Puts the project's content into the scene's marked places: the text of an element, the picture of an <img>. */
const fillSlots = (doc: Document, slots: Record<string, string>): void => {
  doc.querySelectorAll('[data-slot]').forEach((el) => {
    const value = slots[el.getAttribute('data-slot') ?? ''];
    if (value === undefined) return;
    if (el instanceof (doc.defaultView as typeof globalThis | null ?? globalThis).HTMLImageElement) el.setAttribute('src', value);
    else el.textContent = value;
  });
};

/** A timeline of some animation library: paused once, then taken to a time on every frame. */
interface Seekable {
  pause?: () => unknown;
  seek?: (seconds: number, suppressEvents?: boolean) => unknown;
  time?: (seconds: number) => unknown;
  totalDuration?: () => number;
  duration?: () => number;
}

interface SceneWindow extends Window {
  __popostScene?: { render?: (seconds: number, fps: number) => void; timeline?: Seekable };
  __timelines?: Record<string, Seekable>;
}

const timelinesOf = (win: SceneWindow | null): Seekable[] =>
  [win?.__popostScene?.timeline, ...Object.values(win?.__timelines ?? {})].filter((t): t is Seekable => typeof t === 'object' && t !== null && (typeof t.seek === 'function' || typeof t.time === 'function'));

/** Adds the animations the document has now that are not in the list yet (element.animate() called by a script). */
const collect = (scene: SceneNode): void => {
  const doc = scene.frame.contentDocument;
  if (!doc) return;
  for (const a of doc.getAnimations()) if (!scene.animations.includes(a)) scene.animations.push(a);
};

const failureText = (f: SceneFailure | undefined): string =>
  f?.picture
    ? 'The picture "' + f.picture.src + '" of the scene "' + f.scene + '" could not be loaded. Check its path: it is relative to the scene file.'
    : 'The scene "' + (f?.scene ?? '') + '" could not be loaded. Check that the file exists in the project directory and is an HTML page.';

/** What prepare() rejects with when scenes did not load: every failure, so that each is reported at its own segment. */
export class SceneLoadError extends Error {
  override name = 'SceneLoadError';
  readonly failures: SceneFailure[];
  constructor(failures: SceneFailure[]) {
    super(failureText(failures[0]));
    this.failures = failures;
  }
}

/** The pictures of a scene that did not decode, each with the path it was given and where that path came from. */
const failedPictures = async (scene: SceneNode, doc: Document, src: string): Promise<SceneFailure[]> => {
  const images = Array.from(doc.images);
  const results = await Promise.allSettled(images.map((img) => img.decode()));
  return images.flatMap((img, i) => {
    if (results[i]?.status !== 'rejected') return [];
    const slot = img.getAttribute('data-slot');
    const given = slot !== null && scene.slots?.[slot] !== undefined;
    return [{ segment: scene.segment, scene: src, picture: { src: img.getAttribute('src') ?? '', url: img.currentSrc || img.src, ...(given ? { slot } : {}) } }];
  });
};

/**
 * Resolves when the scene's document, its fonts and its pictures are loaded; then holds it (holdScene). Rejects with a
 * SceneLoadError naming the page or every picture that did not load.
 */
export const prepareScene = async (scene: SceneNode): Promise<void> => {
  const { frame } = scene;
  const src = frame.getAttribute('src') ?? '';
  if (frame.contentDocument?.readyState !== 'complete' || frame.contentDocument.URL === 'about:blank') {
    await new Promise<void>((resolve) => { frame.addEventListener('load', () => resolve(), { once: true }); });
  }
  const doc = frame.contentDocument;
  if (!doc?.body) throw new SceneLoadError([{ segment: scene.segment, scene: src }]);
  if (scene.slots) fillSlots(doc, scene.slots);
  await doc.fonts.ready;
  const failures = await failedPictures(scene, doc, src);
  if (failures.length) throw new SceneLoadError(failures);
  collect(scene);
  holdScene(scene);
};

/**
 * Stops the scene's animations at time 0 and pauses its timelines, without drawing it: its render() and its timelines'
 * seek run first with a frame that shows it (applyFrame). Every scene loads at once, and one that waits for its segment
 * sits in a layer that is not displayed, where its elements measure 0; a scene that measures its layout when it is
 * first drawn (the screen helper measures its window, a library measures what it moves) would keep those zeros.
 */
const holdScene = (scene: SceneNode): void => {
  for (const a of scene.animations) {
    if (a.playState !== 'paused') a.pause();
    a.currentTime = 0;
  }
  for (const t of timelinesOf(scene.frame.contentWindow as SceneWindow | null)) t.pause?.();
};

/**
 * Puts the scene at its segment time. A changed clock must be captured even when it just reached its resting
 * value; later identical resting frames can be reused. A scene that draws itself always needs a capture.
 */
export const seekScene = (scene: SceneNode, seconds: number, fps: number): boolean => {
  collect(scene);
  const ms = Math.max(0, seconds) * 1000;
  let live = false;
  const clock: number[] = [];
  for (const a of scene.animations) {
    if (a.playState !== 'paused') a.pause();
    a.currentTime = ms;
    const end = Number(a.effect?.getComputedTiming().endTime ?? 0);
    clock.push(Math.min(ms, end));
    if (!(ms >= end)) live = true;
  }
  const win = scene.frame.contentWindow as SceneWindow | null;
  const at = Math.max(0, seconds);
  for (const t of timelinesOf(win)) {
    t.pause?.();
    if (typeof t.seek === 'function') t.seek(at, false); else t.time?.(at);
    const length = typeof t.totalDuration === 'function' ? t.totalDuration() : typeof t.duration === 'function' ? t.duration() : Infinity;
    clock.push(Math.min(at, length));
    if (!(at >= length)) live = true;
  }
  const render = win?.__popostScene?.render;
  if (typeof render === 'function') { render(Math.max(0, seconds), fps); live = true; }
  const now = clock.join('|'), moved = scene.clock !== now;
  scene.clock = now;
  return live || moved;
};
