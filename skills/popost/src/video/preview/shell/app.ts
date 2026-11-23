/**
 * The shell's state and the actions that change it. Playback advances the frame by wall-clock time with
 * requestAnimationFrame here, in the shell; the page itself only ever receives applyFrame(n).
 */
import type { Problem } from '../../types';
import type { PreviewState, RenderInfo, StepKind } from '../protocol';
import type { Schemas } from './edit/schema';
import type { Lang } from './i18n';
import { clampFrame, timelineFps, timelineFrames, type Selection } from './model';

export interface Overlays { boxes: boolean; events: boolean; safe: boolean }

export interface View {
  state: PreviewState | null;
  frame: number;
  playing: boolean;
  /** Playback speed: 0.25, 0.5 or 1. */
  speed: number;
  lang: Lang;
  /** What was clicked; null = show what is under the playhead. */
  pinned: Selection | null;
  overlays: Overlays;
  connected: boolean;
  /** Set when the page's prepare() rejected (a picture that did not load). */
  pageError: string | null;
  /** Edit mode only (all null / false in the read-only preview). */
  edit: EditView;
}

/** What the status line of edit mode says: the last step, or why an edit was not saved. */
export type EditStatus =
  | { kind: 'done'; op: StepKind | 'undo' | 'redo'; step: StepKind; label: string }
  | { kind: 'refused'; problem: Problem }
  | { kind: 'note'; key: 'phraseSpan' | 'offline' };

export interface EditView {
  /** The schemas of GET /api/schema; null until loaded, and always in the read-only preview. */
  schema: Schemas | null;
  status: EditStatus | null;
  /** The problems of the last edit that was refused, shown next to their fields. */
  problems: Problem[];
  render: RenderInfo | null;
  /** The reference player shows the last render instead of the reference. */
  playRender: boolean;
}

export const NO_EDIT: EditView = { schema: null, status: null, problems: [], render: null, playRender: false };

export type Listener = (view: View, previous: View) => void;

export interface Store {
  get(): View;
  set(patch: Partial<View>): void;
  subscribe(fn: Listener): void;
}

export const createStore = (initial: View): Store => {
  let view = initial;
  const listeners: Listener[] = [];
  return {
    get: () => view,
    set: (patch) => {
      const previous = view;
      view = { ...view, ...patch };
      listeners.forEach((fn) => fn(view, previous));
    },
    subscribe: (fn) => { listeners.push(fn); },
  };
};

export interface Actions {
  seek(n: number): void;
  step(delta: number): void;
  togglePlay(): void;
  pause(): void;
  setSpeed(speed: number): void;
  pin(sel: Selection | null): void;
  toggleOverlay(name: keyof Overlays): void;
  setLang(lang: Lang): void;
}

export const SPEEDS = [0.25, 0.5, 1] as const;

const framesOf = (v: View): number => (v.state ? timelineFrames(v.state) : 0);
const fpsOf = (v: View): number => (v.state ? timelineFps(v.state) : 30);

interface Playback { play(): void; pause(): void; reanchor(): void }

/** Advances the frame by wall-clock time while playing, from an anchor that every seek and speed change re-sets. */
const playback = (store: Store): Playback => {
  let anchor = { frame: 0, time: 0 };
  let raf = 0;
  const tick = (now: number): void => {
    const v = store.get();
    if (!v.playing) return;
    const last = Math.max(0, framesOf(v) - 1);
    const n = Math.min(last, anchor.frame + Math.floor(((now - anchor.time) / 1000) * fpsOf(v) * v.speed));
    if (n >= last) return store.set({ frame: last, playing: false });
    if (n !== v.frame) store.set({ frame: n });
    raf = requestAnimationFrame(tick);
  };
  const reanchor = (): void => { anchor = { frame: store.get().frame, time: performance.now() }; };
  return {
    reanchor,
    pause: () => {
      cancelAnimationFrame(raf);
      if (store.get().playing) store.set({ playing: false });
    },
    play: () => {
      const v = store.get();
      if (framesOf(v) < 2) return;
      if (v.frame >= framesOf(v) - 1) store.set({ frame: 0 });
      reanchor();
      store.set({ playing: true });
      raf = requestAnimationFrame(tick);
    },
  };
};

export const createActions = (store: Store): Actions => {
  const p = playback(store);
  const seek = (n: number): void => {
    store.set({ frame: clampFrame(n, framesOf(store.get())) });
    p.reanchor();
  };
  return {
    seek,
    step: (delta) => seek(store.get().frame + delta),
    togglePlay: () => (store.get().playing ? p.pause() : p.play()),
    pause: p.pause,
    setSpeed: (speed) => {
      store.set({ speed });
      p.reanchor();
    },
    pin: (sel) => store.set({ pinned: sel }),
    toggleOverlay: (name) => {
      const o = store.get().overlays;
      store.set({ overlays: { ...o, [name]: !o[name] } });
    },
    setLang: (lang) => {
      document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
      store.set({ lang });
    },
  };
};
