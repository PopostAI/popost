/**
 * The side panel's form in edit mode, built from the SOURCE of the selection (its track, cue or segment in
 * video.json), with the resolved values beside where they differ. Allowed values and ranges come from the schema
 * (GET /api/schema) and from the constants of src/presets; nothing here copies them.
 */
import type { PreviewState } from '../../protocol';
import type { ResolvedItem, ResolvedMotion, ResolvedTextStyle } from '../../../types';
import { TEXT_STYLES, isTextStyleName } from '../../../presets/text-styles';
import { h } from '../dom';
import { t } from '../i18n';
import { section, type Field, type FieldCtx } from './fields';
import { choices, prop, rangeOf, type JsonSchema, type Schemas } from './schema';
import { isObj, materialsOf, segmentsOf, valueAt, type Obj, type Path, type Target } from './source';
import { cuesSection, segmentSections, whenSection } from './form-parts';

export interface FormCtx extends FieldCtx {
  state: PreviewState;
  schema: Schemas;
  /** One operation, as a whole value at path (the form builds it when the parent object is missing). */
  set: (path: Path, value: unknown) => void;
}

/** A named style written out as an object, so one of its values can change while the others stay. */
const styleObject = (style: unknown): Obj => {
  if (isObj(style)) return style;
  if (typeof style !== 'string' || !isTextStyleName(style)) return {};
  const { font: _font, ...rest } = TEXT_STYLES[style];
  return rest;
};

const CUSTOM = 'custom';

/** Preset style, size, colour, weight and align of a text item or a caption track. */
const styleSection = (ctx: FormCtx, base: Path, style: unknown, resolved: ResolvedTextStyle | undefined): HTMLElement => {
  const at = [...base, 'style'];
  const schema = prop(ctx.schema.text, 'style');
  const names = choices(schema);
  const own = isObj(style) ? style : undefined;
  const edge=Math.min(ctx.state.resolved?.canvas.width??1,ctx.state.resolved?.canvas.height??1);
  const size:Field={kind:'number',label:ctx.lang==='zh'?'字号（px）':'Font size (px)',path:[...at,'size'],value:Math.round(Number(own?.size??resolved?.size??.05)*edge),step:1,range:{min:1,max:edge,integer:true},commit:v=>put('size')(v===undefined?undefined:Number(v)/edge)};
  const put = (key: string) => (v: unknown): void => {
    const next = Object.fromEntries(Object.entries({ ...styleObject(style), [key]: v }).filter(([, x]) => x !== undefined));
    ctx.set(at, next);
  };
  const field = (key: string, kind: 'number' | 'color' | 'select', extra: Partial<Field> = {}): Field => ({
    kind, label: 'f' + key[0]?.toUpperCase() + key.slice(1), path: [...at, key], value: own?.[key], resolved: resolved?.[key as keyof ResolvedTextStyle],
    commit: put(key), range: rangeOf(prop(schema, key)), options: choices(prop(schema, key)), ...extra,
  } as Field);
  const named: Field = {
    kind: 'select', label: 'fNamed', path: at, value: typeof style === 'string' ? style : own ? CUSTOM : undefined, options: [...names, CUSTOM],
    labels: { [CUSTOM]: t(ctx.lang, 'fCustom') },
    commit: (v) => ctx.set(at, v === CUSTOM ? styleObject(style) : v),
  };
  return section(t(ctx.lang, 'fStyle'), [[named, size], [field('color', 'color', { label: 'fColour' }), field('weight', 'number', { step: 100 }), field('align', 'select')]], ctx);
};

const DIRECTED_MOTION = new Set(['slide', 'wipe']);

/** Preset, frames, direction and ease of an entrance or an exit. */
const motionSection = (ctx: FormCtx, base: Path, key: 'enter' | 'exit', motion: unknown, resolved: ResolvedMotion | undefined): HTMLElement => {
  const at = [...base, key];
  const schema = ctx.schema.motion;
  const own = isObj(motion) ? motion : undefined;
  const field = (name: string, kind: 'number' | 'select', label: string): Field => ({
    kind, label, path: [...at, name], value: own?.[name], resolved: resolved?.[name as keyof ResolvedMotion], disabled: !own,
    range: rangeOf(prop(schema, name)), options: choices(prop(schema, name)),
  } as Field);
  const preset: Field = { kind: 'select', label: 'fPreset', path: [...at, 'preset'], value: own?.preset, options: choices(prop(schema, 'preset')), empty: t(ctx.lang, 'fNone'),
    commit: (v) => (v === undefined ? ctx.commit(at, undefined) : ctx.commit([...at, 'preset'], v)) };
  const directed = DIRECTED_MOTION.has(String(own?.preset ?? ''));
  return section(t(ctx.lang, key === 'enter' ? 'fEnter' : 'fExit'), [[preset, field('frames', 'number', 'fFrames')], [directed ? field('direction', 'select', 'fDirection') : null, field('ease', 'select', 'fEase')]], ctx);
};

const num = (ctx: FormCtx, path: Path, label: string, schema: JsonSchema | undefined, extra: Partial<Field> = {}): Field =>
  ({ kind: 'number', label, path, value: valueAt(ctx.state.source, path), range: rangeOf(schema), ...extra } as Field);

const pick = (ctx: FormCtx, path: Path, label: string, options: readonly string[], extra: Partial<Field> = {}): Field =>
  ({ kind: 'select', label, path, value: valueAt(ctx.state.source, path), options, ...extra } as Field);

const boxSection = (ctx: FormCtx, base: Path, item: ResolvedItem | undefined): HTMLElement => {
  const c = ctx.state.resolved?.canvas;
  const px = item && c ? [item.box[0] * c.width, item.box[1] * c.height, item.box[2] * c.width, item.box[3] * c.height].map((v) => Math.round(v)).join(', ') + ' px' : '';
  const coords = (['fX', 'fY', 'fW', 'fH'] as const).map((label, i) => { const path:Path=[...base,'box',i];const edge=i%2===0?c?.width??1:c?.height??1;return num(ctx,path,label,undefined,{step:1,value:Math.round(Number(valueAt(ctx.state.source,path)??0)*edge),commit:v=>ctx.commit(path,Number(v)/edge)}); });
  return section(t(ctx.lang, 'fBox'), [coords], ctx, px ? [h('div', { class: 'hint', text: px })] : []);
};

const lookSection = (ctx: FormCtx, base: Path, schema: JsonSchema | undefined): HTMLElement =>
  section(t(ctx.lang, 'fLook'), [[num(ctx, [...base, 'rotate'], 'fRotate', prop(schema, 'rotate')), num(ctx, [...base, 'opacity'], 'fOpacity', prop(schema, 'opacity'), { step: 0.05 }), num(ctx, [...base, 'z'], 'fZ', prop(schema, 'z'))]], ctx);

/** What an image, shape or video item shows. */
const contentSection = (ctx: FormCtx, base: Path, track: Obj, item: ResolvedItem | undefined): HTMLElement | null => {
  const type = String(track.type);
  const schema = ctx.schema[type === 'image' ? 'image' : type === 'video' ? 'video' : 'shape'];
  const radius = num(ctx, [...base, 'radius'], 'fRadius', prop(schema, 'radius'), { step: 0.01 });
  if (type === 'shape') {
    const colour: Field | HTMLElement = typeof track.color === 'string' ? { kind: 'color', label: 'fColour', path: [...base, 'color'], value: track.color, resolved: item?.color } : h('div', { class: 'hint', text: t(ctx.lang, 'fGradient') });
    return section(t(ctx.lang, 'fShape'), [[pick(ctx, [...base, 'shape'], 'fShape', choices(prop(schema, 'shape')), { empty: null }), colour, radius]], ctx);
  }
  if (type !== 'image' && type !== 'video') return null;
  const material = pick(ctx, [...base, 'material'], 'fMaterial', materialsOf(ctx.state, [type]), { empty: null, wide: true });
  const fit = pick(ctx, [...base, 'fit'], 'fFit', choices(prop(schema, 'fit')), { resolved: item?.fit });
  const mask = pick(ctx, [...base, 'mask'], 'fMask', choices(prop(schema, 'mask')), { empty: t(ctx.lang, 'fNone') });
  const play = type === 'video' ? [num(ctx, [...base, 'in'], 'fIn', prop(schema, 'in')), num(ctx, [...base, 'speed'], 'fSpeed', prop(schema, 'speed'), { step: 0.05 }), num(ctx, [...base, 'audio'], 'fSourceAudio', prop(schema, 'audio'))] : [];
  return section(t(ctx.lang, type === 'video' ? 'fFootage' : 'fPicture'), [[material, fit], [radius, mask, ...play]], ctx);
};

const textSection = (ctx: FormCtx, base: Path): HTMLElement =>
  section(t(ctx.lang, 'fText'), [[{ kind: 'textarea', label: 'fText', path: [...base, 'text'], value: valueAt(ctx.state.source, [...base, 'text']) }]], ctx);

const audioSection = (ctx: FormCtx, base: Path, track: Obj): HTMLElement => {
  const during = isObj(track.during) ? track.during : undefined;
  const segment: Field = {
    kind: 'select', label: 'fStart', path: [...base, 'during', 'segment'], value: during?.segment, options: segmentsOf(ctx.state).map((s) => String(s.id)), empty: t(ctx.lang, 'fWhole'),
    commit: (v) => (v === undefined ? ctx.commit([...base, 'during'], undefined) : ctx.set([...base, 'during'], { ...(during ?? {}), segment: v })),
  };
  return section(t(ctx.lang, 'fAudio'), [
    [pick(ctx, [...base, 'material'], 'fMaterial', materialsOf(ctx.state, ['audio', 'voice', 'speech']), { empty: null, wide: true }), num(ctx, [...base, 'gain'], 'fGain', prop(ctx.schema.audio, 'gain'))],
    [segment, num(ctx, [...base, 'during', 'from'], 'fFrom', undefined, { disabled: !during })],
  ], ctx);
};

const resolvedItem = (s: PreviewState, id: string): ResolvedItem | undefined => s.resolved?.items.find((x) => x.id === id);

/** The form of a track: by its type, the sections the schema has for it. */
const trackForm = (ctx: FormCtx, target: Extract<Target, { kind: 'track' | 'cue' }>): HTMLElement[] => {
  const base: Path = ['tracks', target.index];
  const track = target.track;
  const type = String(track.type);
  if (type === 'audio') return [audioSection(ctx, base, track)];
  const id = String(track.id);
  if (type === 'caption') {
    const first = resolvedItem(ctx.state, id + '#' + (target.kind === 'cue' ? target.cue : 0));
    return [cuesSection(ctx, target),boxSection(ctx, base, first), styleSection(ctx, base, track.style, first?.style), motionSection(ctx, base, 'enter', track.enter, first?.enter), motionSection(ctx, base, 'exit', track.exit, first?.exit)];
  }
  const item = resolvedItem(ctx.state, id);
  const schema = ctx.schema[type === 'text' ? 'text' : type === 'image' ? 'image' : type === 'video' ? 'video' : 'shape'];
  return [
    ...(type === 'text' ? [textSection(ctx, base)] : []),
    boxSection(ctx, base, item),
    whenSection(ctx, [...base, 'during'], track.during, item),
    ...(type === 'text' ? [styleSection(ctx, base, track.style, item?.style)] : [contentSection(ctx, base, track, item)].filter((x): x is HTMLElement => x !== null)),
    motionSection(ctx, base, 'enter', track.enter, item?.enter),
    motionSection(ctx, base, 'exit', track.exit, item?.exit),
    lookSection(ctx, base, schema),
  ];
};

/** The form of the selection. */
export const editForm = (ctx: FormCtx, target: Target): HTMLElement => {
  const title = target.kind === 'segment' ? t(ctx.lang, 'fSegment') + ' ' + String(target.segment.id) : String(target.track.type) + ' ' + String(target.track.id) + (target.kind === 'cue' ? ' #' + target.cue : '');
  const parts = target.kind === 'segment' ? segmentSections(ctx, target) : trackForm(ctx, target);
  const friendly=target.kind==='segment'?(ctx.lang==='zh'?'画面 '+(target.index+1):'Scene '+(target.index+1)):target.kind==='cue'?(ctx.lang==='zh'?'字幕 '+(target.cue+1):'Subtitle '+(target.cue+1)):(ctx.lang==='zh'?({text:'文字',image:'图片',video:'视频',audio:'音频',shape:'形状'}[String(target.track.type)]??'元素'):String(target.track.type));
  const essential=target.kind==='cue'?3:target.kind==='segment'?1:target.track.type==='text'?4:3;
  return h('div', { class: 'form', id: 'edit-form' }, [h('div', { class: 'sel-title', text: friendly, title }), ...parts.slice(0,essential), ...(parts.length>essential?[h('details',{},[h('summary',{text:ctx.lang==='zh'?'更多设置':'More settings'}),...parts.slice(essential)])]:[])]);
};
