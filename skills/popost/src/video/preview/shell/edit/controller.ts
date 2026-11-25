/**
 * Edit mode's actions: sending one operation (POST /api/edit), undo and redo, delete, duplicate, add a text, render;
 * and the selection, which is kept in sessionStorage so that it survives a reload of the page. Every answer of the
 * server ends in the status line: what was saved, or the first problem and its fix.
 */
import type { Problem } from '../../../types';
import type { EditAnswer, PreviewState, RenderInfo } from '../../protocol';
import type { Actions, EditStatus, EditView, Store } from '../app';
import { t } from '../i18n';
import { clampFrame, timelineFrames, type Selection } from '../model';
import { removeScene } from './remove';
import { splitSource } from './split';
import { duplicate, newTextTrack, removal, targetOf, type EditOp, type Target } from './source';

export interface EditActions {
  /** Sends one operation; resolves true when it was saved. */
  replace(source: unknown, base?: unknown): Promise<boolean>;
  send(op: EditOp, select?: Selection | null): Promise<boolean>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  remove(): Promise<void>;
  duplicate(): Promise<void>;
  addText(): Promise<void>;
  split(): Promise<void>;
  canSplit(): boolean;
  render(): Promise<void>;
  select(sel: Selection | null): void;
  note(key: Extract<EditStatus, { kind: 'note' }>['key']): void;
  /** The source the selection points at, or undefined. */
  target(): Target | undefined;
  setRender(info: RenderInfo): void;
  togglePlayRender(): void;
}

const storageKey = (s: PreviewState): string => 'popost-preview-selection:' + s.project.dir;

/** The selection kept for this project in sessionStorage (a reload of the page keeps it). */
export const storedSelection = (s: PreviewState): Selection | null => {
  try {
    const raw = sessionStorage.getItem(storageKey(s));
    return raw ? (JSON.parse(raw) as Selection) : null;
  } catch {
    return null;
  }
};

/** Keeps the selection in sessionStorage whenever it changes. */
export const keepSelection = (store: Store): void => {
  store.subscribe((v, prev) => {
    if (v.pinned === prev.pinned || !v.state) return;
    try {
      if (v.pinned) sessionStorage.setItem(storageKey(v.state), JSON.stringify(v.pinned));
      else sessionStorage.removeItem(storageKey(v.state));
    } catch {
      // A browser without storage keeps the selection until the page is reloaded.
    }
  });
};

const post = async (url: string, body?: unknown): Promise<EditAnswer> => {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return (await res.json()) as EditAnswer;
  } catch (e) {
    return { ok: false, problems: [{ level: 'error', at: '(request)', message: e instanceof Error ? e.message : String(e), fix: '' }] };
  }
};

export const createEditActions = (store: Store, actions: Actions): EditActions => {
  const patch = (p: Partial<EditView>): void => store.set({ edit: { ...store.get().edit, ...p } });
  const select = (sel: Selection | null): void => actions.pin(sel);
  /** Applies an answer: the new state and the status line, or the problems next to their fields. */
  const settle = (answer: EditAnswer, after?: Selection | null): boolean => {
    if (!answer.ok) {
      const first = answer.problems.find((p) => p.level === 'error') ?? answer.problems[0];
      patch({ status: first ? { kind: 'refused', problem: first } : null, problems: answer.problems });
      return false;
    }
    const state = answer.state;
    store.set({ state, frame: clampFrame(store.get().frame, timelineFrames(state)), edit: { ...store.get().edit, status: { kind: 'done', op: answer.op, step: answer.step, label: answer.label }, problems: [] } });
    if (after !== undefined) select(after);
    return true;
  };
  const target = (): Target | undefined => {
    const v = store.get();
    return v.state ? targetOf(v.state, v.pinned) : undefined;
  };
  const send = async (op: EditOp, after?: Selection | null): Promise<boolean> => settle(await post('/api/edit', op), after);
  const withTarget = async (fn: (s: PreviewState, t: Target) => Promise<void>): Promise<void> => {
    const s = store.get().state;
    const t0 = target();
    if (s && t0) await fn(s, t0);
  };
  return {
    send,
    canSplit: () => { const v = store.get(); return Boolean(v.state && splitSource(v.state, v.pinned, v.frame)); },
    split: async () => { const v=store.get(); const result=v.state ? splitSource(v.state,v.pinned,v.frame) : undefined; if(result && settle(await post('/api/source',{source:result.source,base:v.state?.source}))) select(result.select); },
    replace: async (source, base) => settle(await post('/api/source', { source, base })),
    undo: async () => { settle(await post('/api/undo')); },
    redo: async () => { settle(await post('/api/redo')); },
    remove: () => withTarget(async (s, t0) => { if(t0.kind==='segment'){const next=removeScene(s,t0.index);if(next)settle(await post('/api/source',{source:next,base:s.source}),null);return;} await send(removal(t0), null); }),
    duplicate: () => withTarget(async (s, t0) => {
      const d = duplicate(s, t0);
      if (d) await send(d.op, d.select);
    }),
    addText: async () => {
      const v = store.get();
      const add = v.state ? newTextTrack(v.state, v.frame, t(v.lang, 'newText')) : undefined;
      if (add) await send(add.op, add.select);
    },
    render: async () => {
      const res = await fetch('/api/render', { method: 'POST' }).catch(() => undefined);
      const body = (await res?.json().catch(() => undefined)) as { ok: boolean; render?: RenderInfo; problems?: Problem[] } | undefined;
      if (body?.render) patch({ render: body.render });
      else if (body?.problems?.[0]) patch({ status: { kind: 'refused', problem: body.problems[0] } });
    },
    select,
    note: (key) => patch({ status: { kind: 'note', key } }),
    target,
    setRender: (info) => patch({ render: info }),
    togglePlayRender: () => patch({ playRender: !store.get().edit.playRender }),
  };
};
