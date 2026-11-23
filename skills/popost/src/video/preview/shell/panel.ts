/**
 * The side panel: what is selected (or under the playhead) as formatted JSON of its resolved or measured values,
 * the problems from check, the score table, which measurements are loaded, and the draft notes. In edit mode the
 * selection is a form instead (edit/form.ts), built from video.json.
 */
import type { PreviewState } from '../protocol';
import type { Problem, Score } from '../../types';
import type { Actions, Store, View } from './app';
import { h } from './dom';
import type { EditActions } from './edit/controller';
import { editForm, type FormCtx } from './edit/form';
import { opFor, targetOf } from './edit/source';
import { dimensionLabel, t, type Lang } from './i18n';
import { itemsAt, segmentAt, selectionTitle, selectionValue } from './model';

const heading = (text: string, extra: readonly (Node | string)[] = []): HTMLElement => h('h2', {}, [h('span', { text }), ...extra]);

const json = (value: unknown): HTMLElement => h('pre', { class: 'json', text: JSON.stringify(value, null, 2) ?? 'undefined' });

const selectionContent = (v: View, s: PreviewState, actions: Actions): HTMLElement[] => {
  if (v.pinned) {
    const value = selectionValue(s, v.pinned);
    return [h('div', { class: 'sel-title', text: selectionTitle(v.pinned) }), value === undefined ? h('p', { class: 'muted', text: t(v.lang, 'nothing') }) : json(value)];
  }
  const seg = s.resolved ? segmentAt(s.resolved, v.frame) : undefined;
  const items = s.resolved ? itemsAt(s.resolved, v.frame) : [];
  const onScreen = items.map((it) => h('button', { class: 'chip', text: it.id, attrs: { type: 'button' }, on: { click: () => actions.pin({ kind: 'item', id: it.id }) } }));
  return [
    ...(seg ? [h('div', { class: 'sel-title', text: 'segment ' + seg.id }), json(seg)] : [h('p', { class: 'muted', text: t(v.lang, 'nothing') })]),
    h('div', { class: 'chips' }, [h('span', { class: 'muted', text: t(v.lang, 'onScreen') + ': ' }), ...(onScreen.length ? onScreen : [t(v.lang, 'none')])]),
  ];
};

/**
 * Edit mode: the form of the selection, or, with nothing selected, what can be selected at the playhead. undefined
 * for a selection the form does not edit (a measured boundary or event), which keeps its JSON view.
 */
const editContent = (v: View, s: PreviewState, actions: Actions, edit: EditActions): HTMLElement[] | undefined => {
  const schema = v.edit.schema;
  if (!s.edit || !schema) return undefined;
  const target = targetOf(s, v.pinned);
  if (target) {
    const ctx: FormCtx = {
      lang: v.lang, problems: v.edit.problems, state: s, schema,
      commit: (path, value) => {
        const op = opFor(s.source, path, value);
        if (op) void edit.send(op);
      },
      set: (path, value) => void edit.send({ op: 'set', path, value }),
    };
    return [editForm(ctx, target)];
  }
  if (v.pinned) return undefined;
  const seg = s.resolved ? segmentAt(s.resolved, v.frame) : undefined;
  const chip = (text: string, pick: () => void): HTMLElement => h('button', { class: 'chip', text, attrs: { type: 'button' }, on: { click: pick } });
  return [
    h('p', { class: 'muted', id: 'edit-hint', text: t(v.lang, 'editHint') }),
    h('div', { class: 'chips' }, [
      ...(seg ? [chip(t(v.lang, 'fSegment') + ' ' + seg.id, () => actions.pin({ kind: 'segment', id: seg.id }))] : []),
      ...(s.resolved ? itemsAt(s.resolved, v.frame) : []).map((it) => chip(it.id, () => actions.pin({ kind: 'item', id: it.id }))),
    ]),
  ];
};

const problemItem = (p: Problem, lang: Lang): HTMLElement =>
  h('li', { class: 'problem ' + p.level }, [
    h('div', {}, [h('b', { class: p.level, text: t(lang, p.level) }), ' ', h('code', { text: p.at })]),
    h('div', { text: p.message }),
    ...(p.allowed?.length ? [h('div', { class: 'muted', text: t(lang, 'allowed') + ': ' + p.allowed.join(', ') })] : []),
    ...(p.fix ? [h('div', { text: t(lang, 'fix') + ': ' + p.fix })] : []),
  ]);

const detailText = (d: Record<string, number | string>): string =>
  Object.entries(d).map(([k, x]) => k + '=' + (typeof x === 'number' ? Number(x.toFixed(3)) : x)).join(', ');

const scoreTable = (score: Score, lang: Lang): HTMLElement => {
  const row = (cells: readonly (string | HTMLElement)[], cls = ''): HTMLElement => h('tr', { class: cls }, cells.map((c) => h('td', {}, [c])));
  const rows = Object.entries(score.dimensions).map(([name, d]) => {
    const detail = detailText(d.detail);
    return row([dimensionLabel(lang, name), d.n ? d.score.toFixed(2) : '-', String(d.n), h('span', { class: 'detail', text: detail, title: detail })], d.n ? '' : 'muted');
  });
  return h('table', { class: 'score' }, [
    h('thead', {}, [h('tr', {}, [t(lang, 'dimension'), t(lang, 'value'), t(lang, 'compared'), t(lang, 'detail')].map((c) => h('th', { text: c })))]),
    h('tbody', {}, [...rows, row([t(lang, 'composite'), score.composite.toFixed(2), '', ''], 'total')]),
  ]);
};

const measureLines = (s: PreviewState, lang: Lang): HTMLElement[] => [
  h('div', { class: 'kv' }, [h('span', { class: 'muted', text: t(lang, 'renderMeasure') + ': ' }), h('code', { text: s.measure?.file ?? t(lang, 'none'), title: s.measure?.file ?? '' })]),
  h('div', { class: 'kv' }, [h('span', { class: 'muted', text: t(lang, 'referenceMeasure') + ': ' }), h('code', { text: s.referenceMeasure?.file ?? t(lang, 'none'), title: s.referenceMeasure?.file ?? '' })]),
  ...s.messages.map((m) => h('p', { class: 'message', text: m })),
];

export const mountPanel = (root: HTMLElement, store: Store, actions: Actions, edit?: EditActions): void => {
  const selection = h('section', { id: 'selection' });
  const problems = h('section', { id: 'problems' });
  const score = h('section', { id: 'score' });
  const measures = h('section', { id: 'measures' });
  const notes = h('section', { id: 'notes' });
  root.append(selection, problems, score, measures, notes);
  let selectionKey = '';
  let lastPinned = '';

  const drawSelection = (v: View): void => {
    const s = v.state;
    const under = s?.resolved && !v.pinned ? [segmentAt(s.resolved, v.frame)?.id, itemsAt(s.resolved, v.frame).map((i) => i.id)] : null;
    const editing = s?.edit ? [v.edit.problems, v.edit.schema !== null] : null;
    const key = JSON.stringify([v.lang, s?.generation, v.pinned, under, editing]);
    if (key === selectionKey) return;
    const pinChanged = JSON.stringify(v.pinned) !== lastPinned;
    lastPinned = JSON.stringify(v.pinned);
    selectionKey = key;
    // A rebuilt form keeps the field that had the focus (the next one, after a change was committed by leaving a field).
    const focused = selection.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.path : undefined;
    const follow = v.pinned ? [h('button', { class: 'link', text: t(v.lang, 'follow'), attrs: { type: 'button' }, on: { click: () => actions.pin(null) } })] : [];
    const content = s ? ((edit && editContent(v, s, actions, edit)) ?? selectionContent(v, s, actions)) : [];
    selection.replaceChildren(heading(t(v.lang, 'selection'), [h('span', { class: 'muted', text: ' (' + t(v.lang, v.pinned ? 'pinned' : 'underPlayhead') + ')' }), ...follow]), ...content);
    if (focused) selection.querySelector<HTMLElement>('[data-path="' + CSS.escape(focused) + '"]')?.focus();
    if (pinChanged) selection.querySelector('.cue.current')?.scrollIntoView({ block: 'nearest' });
  };

  const drawRest = (v: View): void => {
    const s = v.state;
    if (!s) return;
    const lang = v.lang;
    problems.replaceChildren(heading(t(lang, 'problems') + ' (' + s.problems.length + ')'),
      s.problems.length ? h('ul', {}, s.problems.map((p) => problemItem(p, lang))) : h('p', { class: 'muted', text: t(lang, 'noProblems') }));
    score.replaceChildren(heading(t(lang, 'score')), s.score ? scoreTable(s.score, lang) : h('p', { class: 'muted', text: t(lang, 'noScore') }));
    measures.replaceChildren(heading(t(lang, 'measurements')), ...measureLines(s, lang));
    notes.hidden = !s.notes;
    notes.replaceChildren(heading(t(lang, 'notes') + ' (' + (s.notes?.length ?? 0) + ')'),
      h('ul', {}, (s.notes ?? []).map((n) => h('li', { class: 'note-item' }, [h('code', { text: n.at }), ' ', h('b', { text: n.kind }), h('div', { text: n.message })]))));
  };

  drawRest(store.get());
  drawSelection(store.get());
  store.subscribe((v, prev) => {
    if (v.state !== prev.state || v.lang !== prev.lang) drawRest(v);
    if (v.state !== prev.state || v.lang !== prev.lang || v.pinned !== prev.pinned || v.frame !== prev.frame || v.edit.problems !== prev.edit.problems || v.edit.schema !== prev.edit.schema) drawSelection(v);
  });
};
