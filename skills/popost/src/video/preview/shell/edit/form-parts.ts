/**
 * Parts of the edit form: when an item is on (a segment span or a phrase span), the cues of a caption track, and a
 * segment (its length, the transition into it, its base).
 */
import type { ResolvedItem, ResolvedSegment } from '../../../types';
import { DIRECTED_TRANSITIONS, ONE_SIDED_TRANSITIONS, type TransitionName } from '../../../presets/transition';
import { h } from '../dom';
import { t } from '../i18n';
import { section, type Field } from './fields';
import type { FormCtx } from './form';
import { choices, prop, rangeOf } from './schema';
import { isObj, materialsOf, segmentsOf, valueAt, type Obj, type Path, type Target } from './source';

const framesHint = (ctx: FormCtx, start: number, end: number): HTMLElement =>
  h('div', { class: 'hint', text: t(ctx.lang, 'onFrames') + ' ' + start + '..' + (end - 1) });

/** Segment, from and to; or, for an item placed on spoken words, the phrase and its lead and hold. */
export const whenSection = (ctx: FormCtx, at: Path, span: unknown, item: Pick<ResolvedItem, 'start' | 'end'> | undefined, title = t(ctx.lang, 'fWhen')): HTMLElement => {
  const own = isObj(span) ? span : {};
  const fps=ctx.state.resolved?.canvas.fps??30;
  const segmentFrames = ctx.state.resolved?.segments.find(s => s.id === own.segment);
  const fallback = (key: string): unknown => key === 'from' ? 0 : key === 'to' && segmentFrames ? segmentFrames.end - segmentFrames.start : undefined;
  const n = (key: string, label: string): Field => ({ kind: 'number', label:t(ctx.lang,label as Parameters<typeof t>[1])+(ctx.lang==='zh'?'（秒）':' (s)'), path: [...at, key], value:typeof (own[key] ?? fallback(key))==='number'?Number(own[key] ?? fallback(key))/fps:undefined,step:.01,commit:v=>ctx.commit([...at,key],v===undefined?undefined:Math.round(Number(v)*fps)) });
  const hint = item ? [framesHint(ctx, item.start, item.end)] : [];
  if (own.phrase !== undefined)
    return section(title, [[{ kind: 'text', label: 'fPhrase', path: [...at, 'phrase'], value: own.phrase, wide: true }], [n('occurrence', 'fOccurrence'), n('lead', 'fLead'), n('hold', 'fHold')]], ctx, hint);
  const segment: Field = { kind: 'select', label: 'fSegment', path: [...at, 'segment'], value: own.segment, options: segmentsOf(ctx.state).map((s) => String(s.id)), labels:Object.fromEntries(segmentsOf(ctx.state).map((s,i)=>[String(s.id),(ctx.lang==='zh'?'画面 ':'Scene ')+(i+1)])),empty: null };
  return section(title, [[segment, n('from', 'fFrom'), n('to', 'fTo')]], ctx, hint);
};

/** Every cue of a caption track: its text and when it is on. The selected cue is marked and scrolled to. */
export const cuesSection = (ctx: FormCtx, target: Extract<Target, { kind: 'track' | 'cue' }>): HTMLElement => {
  const cues = Array.isArray(target.track.cues) ? target.track.cues : [];
  const id = String(target.track.id);
  const rows = cues.flatMap((cue, i) => {
    if(target.kind==='cue'&&target.cue!==i)return [];
    const at: Path = ['tracks', target.index, 'cues', i];
    const item = ctx.state.resolved?.items.find((x) => x.id === id + '#' + i);
    const text: Field = { kind: 'textarea', label: t(ctx.lang, 'fCue') + ' ' + i, path: [...at, 'text'], value: isObj(cue) ? cue.text : undefined };
    const box = section('#' + i, [[text]], ctx, [whenSection(ctx, [...at, 'during'], isObj(cue) ? cue.during : undefined, item, t(ctx.lang, 'fWhen'))]);
    box.classList.add('cue');
    if (target.kind === 'cue' && target.cue === i) box.classList.add('current');
    return box;
  });
  return h('div', { class: 'cues' }, [h('h3', { text: t(ctx.lang, 'fCues') + ' (' + cues.length + ')' }), ...rows]);
};

const DIRECTIONS_OF = (kind: string, ctx: FormCtx): string[] => {
  if (kind === 'wipe') return choices(prop(ctx.schema.transition, 'direction'));
  return DIRECTED_TRANSITIONS.includes(kind as TransitionName) ? choices(prop(ctx.schema.motion, 'direction')) : [];
};

/** The transition into a segment: kind, frames, and the settings its kind reads. */
const transitionSection = (ctx: FormCtx, base: Path, tr: unknown, resolved: ResolvedSegment | undefined): HTMLElement => {
  const at = [...base, 'in'];
  const own = isObj(tr) ? tr : undefined;
  const kind = String(own?.transition ?? '');
  const schema = ctx.schema.transition;
  const r = resolved?.transition;
  const field = (key: string, label: string, kindOf: 'number' | 'select', options?: string[]): Field =>
    ({ kind: kindOf, label, path: [...at, key], value: own?.[key], resolved: r?.[(key === 'transition' ? 'kind' : key) as keyof typeof r], range: rangeOf(prop(schema, key)), options: options ?? choices(prop(schema, key)), step: key === 'strength' ? 0.1 : undefined } as Field);
  const kindField: Field = { kind: 'select', label: 'fKind', path: [...at, 'transition'], value: own?.transition, options: choices(prop(schema, 'transition')), empty: t(ctx.lang, 'fHardCut'),
    commit: (v) => (v === undefined ? ctx.commit(at, undefined) : ctx.commit([...at, 'transition'], v)) };
  const directions = DIRECTIONS_OF(kind, ctx);
  const oneSided = ONE_SIDED_TRANSITIONS.includes(kind as TransitionName);
  const rows: (Field | null)[][] = [
    [kindField, own && kind !== 'cut' ? field('frames', 'fFrames', 'number') : null],
    [directions.length ? field('direction', 'fDirection', 'select', directions) : null, kind === 'slide' ? field('mode', 'fMode', 'select') : null, kind === 'fade' ? field('via', 'fVia', 'select') : null],
    [oneSided ? field('side', 'fSide', 'select') : null, own && kind !== 'cut' ? field('ease', 'fEase', 'select') : null, own && kind !== 'cut' ? field('strength', 'fStrength', 'number') : null],
  ];
  return section(t(ctx.lang, 'fTransition'), rows.filter((row) => row.some((f) => f !== null)), ctx);
};

/** The base of a segment: a colour, or a material with its fit (and in / speed for video). */
const baseSection = (ctx: FormCtx, at: Path, base: Obj): HTMLElement => {
  const schema = ctx.schema.base;
  const visual = materialsOf(ctx.state, ['image', 'video']);
  const kind = 'material' in base ? 'material' : 'color' in base ? 'color' : 'scene';
  const kindField: Field = {
    kind: 'select', label: 'fBase', path: at, value: kind, options: kind === 'scene' ? ['scene', 'color', 'material'] : ['color', 'material'], labels: { scene: t(ctx.lang, 'fBaseScene'), color: t(ctx.lang, 'fBaseColor'), material: t(ctx.lang, 'fBaseMaterial') }, empty: null,
    commit: (v) => ctx.set(at, v === 'scene' ? base : v === 'color' ? { color: '#000000' } : { material: visual[0] ?? '' }),
  };
  if (kind === 'scene') {
    const slots = isObj(base.slots) ? base.slots : {};
    const rows: Field[][] = Object.entries(slots).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([name, value]) => [{ kind: 'textarea', label: name, path: [...at, 'slots', name], value, wide: true }]);
    return section(t(ctx.lang, 'fBaseScene'), [[kindField], ...rows], ctx);
  }
  if (kind !== 'material') {
    const colour: Field | HTMLElement = typeof base.color === 'string' ? { kind: 'color', label: 'fColour', path: [...at, 'color'], value: base.color, empty: null } as Field : h('div', { class: 'hint', text: t(ctx.lang, 'fGradient') });
    return section(t(ctx.lang, 'fBase'), [[kindField, colour]], ctx);
  }
  const isVideo = materialsOf(ctx.state, ['video']).includes(String(base.material));
  const n = (key: string, label: string, step?: number): Field => ({ kind: 'number', label, path: [...at, key], value: base[key], range: rangeOf(prop(schema, key)), ...(step ? { step } : {}) });
  return section(t(ctx.lang, 'fBase'), [
    [kindField, { kind: 'select', label: 'fMaterial', path: [...at, 'material'], value: base.material, options: visual, empty: null, wide: true }],
    [{ kind: 'select', label: 'fFit', path: [...at, 'fit'], value: base.fit, options: choices(prop(schema, 'fit')) }, ...(isVideo ? [n('in', 'fIn'), n('speed', 'fSpeed', 0.05), n('audio', 'fSourceAudio')] : [])],
  ], ctx, base.camera !== undefined ? [h('div', { class: 'hint', text: t(ctx.lang, 'fCamera') })] : []);
};

/** A segment's length, the transition into it (not for the first), and its base. */
export const segmentSections = (ctx: FormCtx, target: Extract<Target, { kind: 'segment' }>): HTMLElement[] => {
  const base: Path = ['segments', target.index];
  const resolved = ctx.state.resolved?.segments[target.index];
  const fps=ctx.state.resolved?.canvas.fps??30;
  const frames: Field = { kind: 'number', label:ctx.lang==='zh'?'时长（秒）':'Duration (s)', path: [...base, 'frames'], value:Number(valueAt(ctx.state.source,[...base,'frames']))/fps,step:.01,range:{min:1/fps,integer:false},commit:v=>ctx.commit([...base,'frames'],Math.max(1,Math.round(Number(v)*fps))) };
  const length = section(ctx.lang === 'zh' ? '镜头时长' : 'Shot duration', [[frames]], ctx, resolved ? [framesHint(ctx, resolved.start, resolved.end)] : []);
  const seg = target.segment;
  return [
    length,
    ...(target.index > 0 ? [transitionSection(ctx, base, seg.in, resolved)] : []),
    ...(isObj(seg.base) ? [baseSection(ctx, [...base, 'base'], seg.base)] : []),
  ];
};
