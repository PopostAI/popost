/**
 * The inputs of the edit form. Each field is bound to a path in video.json; a change is committed when the input
 * reports it (Enter or leaving the field), as one operation. An emptied optional field is removed, so the default
 * applies again. The resolved value (what the timeline plays) is shown beside the field where it differs, and the
 * problems of a refused edit under the field they name.
 */
import type { Problem } from '../../../types';
import { h } from '../dom';
import { isKey, t, type Key, type Lang } from '../i18n';
import type { Range } from './schema';
import type { Path } from './source';

export type Commit = (value: unknown) => void;

interface Common {
  label: Key | string;
  path: Path;
  value: unknown;
  /** What the timeline plays, when the source leaves it to a default or it differs. */
  resolved?: unknown;
  /** Replaces the default commit (one "set" or "remove" at path). */
  commit?: Commit;
  disabled?: boolean;
  /** Wider than the others in its row. */
  wide?: boolean;
}

export type Field =
  | (Common & { kind: 'number'; range?: Range; step?: number })
  | (Common & { kind: 'text' | 'textarea' | 'color' })
  | (Common & { kind: 'select'; options: readonly string[]; labels?: Readonly<Record<string, string>>; empty?: string | null });

export interface FieldCtx {
  lang: Lang;
  /** The problems of the last refused edit. */
  problems: readonly Problem[];
  commit: (path: Path, value: unknown) => void;
}

/** "tracks[2].box" from ["tracks", 2, "box"]: the form of Problem.at. */
export const pathText = (path: readonly (string | number)[]): string =>
  path.reduce<string>((s, k) => (typeof k === 'number' ? s + '[' + k + ']' : s ? s + '.' + k : k), '');

const label = (lang: Lang, l: string): string => (isKey(l) ? t(lang, l) : l);

const show = (v: unknown): string => (typeof v === 'number' ? String(Number(v.toFixed(4))) : typeof v === 'string' ? v : JSON.stringify(v) ?? '');

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The problems that name this path or a field under it. */
export const problemsAt = (problems: readonly Problem[], path: Path): Problem[] => {
  const at = pathText(path);
  return problems.filter((p) => p.at === at || p.at.startsWith(at + '.') || p.at.startsWith(at + '['));
};

const numberInput = (f: Extract<Field, { kind: 'number' }>, commit: Commit): HTMLInputElement => {
  const input = h('input', { attrs: { type: 'number', step: String(f.step ?? (f.range?.integer ? 1 : 'any')), ...(f.range?.min === undefined ? {} : { min: String(f.range.min) }), ...(f.range?.max === undefined ? {} : { max: String(f.range.max) }) } });
  input.value = typeof f.value === 'number' ? show(f.value) : '';
  if (typeof f.resolved === 'number' && f.value === undefined) input.placeholder = show(f.resolved);
  input.addEventListener('change', () => {
    const raw = input.value.trim();
    const n = Number(raw);
    if (raw !== '' && !Number.isFinite(n)) return void input.setAttribute('aria-invalid', 'true');
    commit(raw === '' ? undefined : n);
  });
  return input;
};

const textInput = (f: Extract<Field, { kind: 'text' | 'textarea' | 'color' }>, commit: Commit): HTMLElement => {
  const value = typeof f.value === 'string' ? f.value : '';
  if (f.kind === 'textarea') {
    const area = h('textarea', { attrs: { rows: String(Math.min(6, Math.max(2, value.split('\n').length))) } });
    area.value = value;
    area.addEventListener('change', () => commit(area.value === '' ? undefined : area.value));
    // Ctrl+Enter commits without leaving the field.
    area.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter' && ((e as KeyboardEvent).ctrlKey || (e as KeyboardEvent).metaKey)) area.blur(); });
    return area;
  }
  const input = h('input', { attrs: { type: 'text', autocomplete: 'off', spellcheck: 'false' } });
  input.value = value;
  if (typeof f.resolved === 'string' && f.value === undefined) input.placeholder = f.resolved;
  input.addEventListener('change', () => commit(input.value.trim() === '' ? undefined : input.value.trim()));
  return input;
};

const selectInput = (f: Extract<Field, { kind: 'select' }>, commit: Commit, lang: Lang): HTMLSelectElement => {
  const options = [...(f.empty === null ? [] : [h('option', { text: f.empty ?? t(lang, 'fDefault'), attrs: { value: '' } })]), ...f.options.map((o) => h('option', { text: f.labels?.[o] ?? o, attrs: { value: o } }))];
  const select = h('select', {}, options);
  const value = f.value === undefined ? '' : String(f.value);
  if (value !== '' && !f.options.includes(value)) select.append(h('option', { text: value, attrs: { value } }));
  select.value = value;
  select.addEventListener('change', () => commit(select.value === '' ? undefined : select.value));
  return select;
};

/** A colour field: the text (any colour the engine reads) and a picker for a plain #rrggbb. */
const colourInput = (f: Extract<Field, { kind: 'text' | 'textarea' | 'color' }>, commit: Commit): HTMLElement => {
  const text = textInput(f, commit) as HTMLInputElement;
  // With no colour of its own the picker shows the one the timeline plays.
  const shown = f.value ?? f.resolved;
  const hex = typeof shown === 'string' && /^#[0-9a-f]{6}$/i.test(shown) ? shown : '#000000';
  const pick = h('input', { class: 'swatch-pick', attrs: { type: 'color', tabindex: '-1' } });
  pick.value = hex.toLowerCase();
  pick.addEventListener('change', () => commit(pick.value));
  return h('span', { class: 'colour' }, [pick, text]);
};

export const fieldEl = (f: Field, ctx: FieldCtx): HTMLElement => {
  const commit: Commit = f.commit ?? ((v) => { if (!same(v, f.value)) ctx.commit(f.path, v); });
  const guarded: Commit = (v) => { if (!same(v, f.value)) commit(v); };
  const input = f.kind === 'number' ? numberInput(f, guarded) : f.kind === 'select' ? selectInput(f, guarded, ctx.lang) : f.kind === 'color' ? colourInput(f, guarded) : textInput(f, guarded);
  const control = input.tagName === 'SPAN' ? (input.querySelector('input[type=text]') as HTMLElement) : input;
  control.dataset.path = pathText(f.path);
  if (f.disabled) control.setAttribute('disabled', '');
  const problems = problemsAt(ctx.problems, f.path);
  if (problems.length) control.setAttribute('aria-invalid', 'true');
  const differs = f.resolved !== undefined && f.value !== undefined && !same(f.value, f.resolved);
  const name = label(ctx.lang, f.label);
  return h('label', { class: 'fld' + (f.wide || f.kind === 'textarea' ? ' wide' : '') + (f.kind === 'textarea' ? ' area' : '') }, [
    h('span', { class: 'fl', text: name, title: name }),
    input,
    ...(differs ? [h('span', { class: 'rv', text: '→ ' + show(f.resolved), title: t(ctx.lang, 'resolvedTitle') })] : []),
    ...problems.map((p) => h('span', { class: 'fprob', text: p.message + (p.fix ? ' ' + t(ctx.lang, 'fix') + ': ' + p.fix : '') })),
  ]);
};

/** A titled group of fields in rows. */
export const section = (title: string, rows: readonly (readonly (Field | HTMLElement | null)[])[], ctx: FieldCtx, extra: readonly HTMLElement[] = []): HTMLElement =>
  h('fieldset', { class: 'fs' }, [
    h('legend', { text: title }),
    ...rows.map((row) => h('div', { class: 'row' }, row.filter((f): f is Field | HTMLElement => f !== null).map((f) => (f instanceof HTMLElement ? f : fieldEl(f, ctx))))),
    ...extra,
  ]);
