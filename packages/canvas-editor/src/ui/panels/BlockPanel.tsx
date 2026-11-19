import type { ReactNode } from 'react';
import type { EditOp, EditorController } from '../../contracts';
import { getAttr } from '../../core/source';
import { getStyleValue } from '../../core/style';
import { useT } from '../i18n';
import type { MessageKey } from '../i18n';
import {
  BORDER_STYLES,
  BORDER_WIDTHS,
  borderProps,
  borderStyleOf,
  boxProps,
  MARGIN_PRESETS,
  PADDING_PRESETS,
  px,
  RADIUS_PRESETS,
  RADIUS_SLIDER_MAX,
  radiusProps,
  SHADOW_PRESETS,
  shadowPresetId,
  shadowProps,
} from '../logic/block-style';
import { toHex } from '../logic/colors';
import { opacityOf } from '../logic/format-state';
import { isImgBlock } from '../ImageTools';
import { useSnapshot } from '../use-snapshot';
import { ColorSwatches } from './ColorSwatches';
import type { ColorPhase } from './ColorSwatches';
import { targetsOf, useDocColors, useTargetStyles } from './hooks';

const PROPS = [
  'background-color',
  'border-top-left-radius',
  'padding-top',
  'margin-top',
  'border-top-style',
  'border-top-width',
  'border-top-color',
  'opacity',
  'box-shadow',
];

function Presets<T extends { id: string }>({ items, active, label, onPick, prefix }: { items: readonly T[]; active: string | null; label(id: string): string; onPick(item: T): void; prefix: string }) {
  return (
    <div className="chips" data-presets={prefix}>
      {items.map((it) => (
        <button key={it.id} type="button" className={`chip${active === it.id ? ' on' : ''}`} data-preset={it.id} onClick={() => onPick(it)}>
          {label(it.id)}
        </button>
      ))}
    </div>
  );
}

function SliderRow({ id, value, max, onChange }: { id: string; value: number; max: number; onChange(v: number): void }) {
  return (
    <label className="slider-row bare">
      <input id={id} type="range" min={0} max={max} step={1} value={Math.min(max, Math.round(value))} onChange={(e) => onChange(Number(e.target.value))} />
      <output>{Math.round(value) > max ? '∞' : Math.round(value)}</output>
    </label>
  );
}

export function BlockPanel({ controller }: { controller: EditorController }) {
  const t = useT();
  const snap = useSnapshot(controller);
  const targets = targetsOf(snap);
  const styles = useTargetStyles(controller, snap, PROPS);
  const docColors = useDocColors(controller, snap.sourceVersion);
  const key = targets.join(',');

  if (targets.length === 0 || snap.docState !== 'ready') {
    return (
      <div className="panel-body" data-panel-body="block">
        <p className="p-hint">{t('panel.selectHint')}</p>
      </div>
    );
  }

  const first = targets[0] as string;
  const el = controller.index().elements.get(first);
  const single = targets.length === 1;
  const isImage = single && isImgBlock(controller, first);
  const setAll = (props: Record<string, string | null>, label: string, coalesce?: string): void => {
    const ops: EditOp[] = targets.map((id) => ({ kind: 'setStyle', id, props }));
    controller.applyBatch(ops, label, coalesce ? { coalesceKey: `${coalesce}:${key}` } : undefined);
  };
  const preset = (n: number, items: readonly { id: string; px: number }[]): string | null => items.find((p) => p.px === Math.round(n))?.id ?? null;
  const tr = (prefix: string) => (id: string) => t(`${prefix}.${id}` as MessageKey);

  const bg = toHex(styles['background-color']);
  const bgPhase = (c: string, phase: ColorPhase): void => setAll({ 'background-color': c }, 'background', phase === 'live' ? 'bg' : undefined);
  const borderColorPick = (c: string, phase: ColorPhase): void => setAll({ 'border-color': c }, 'border color', phase === 'live' ? 'bc' : undefined);

  const radius = px(styles['border-top-left-radius']);
  const padding = px(styles['padding-top']);
  const margin = px(styles['margin-top']);
  const borderStyle = borderStyleOf(styles['border-top-style']);
  const borderWidth = px(styles['border-top-width']);
  const inlineShadow = el ? getStyleValue(getAttr(el, 'style') ?? '', 'box-shadow') : null;
  const shadow = single ? (shadowPresetId(inlineShadow) ?? (inlineShadow === null && styles['box-shadow'] === 'none' ? 'none' : null)) : null;

  const section = (title: MessageKey, body: ReactNode, id: string) => (
    <section className="p-section" data-section={id}>
      <h3>{t(title)}</h3>
      {body}
    </section>
  );

  return (
    <div className="panel-body" data-panel-body="block">
      {targets.length > 1 && <p className="p-hint">{t('pill.selected', { n: targets.length })}</p>}
      {section('block.background', <ColorSwatches docColors={docColors} current={bg} allowNone onPick={bgPhase} />, 'background')}
      {section(
        'block.radius',
        <>
          <Presets items={RADIUS_PRESETS} active={preset(radius, RADIUS_PRESETS)} label={tr('block.radius')} prefix="radius" onPick={(p) => setAll(radiusProps(p.px), 'radius')} />
          <SliderRow id="block-radius" value={radius} max={RADIUS_SLIDER_MAX} onChange={(v) => setAll(radiusProps(v), 'radius', 'radius')} />
        </>,
        'radius',
      )}
      {section(
        'block.padding',
        <>
          <Presets items={PADDING_PRESETS} active={preset(padding, PADDING_PRESETS)} label={tr('block.padding')} prefix="padding" onPick={(p) => setAll(boxProps('padding', p.px), 'padding')} />
          <SliderRow id="block-padding" value={padding} max={120} onChange={(v) => setAll(boxProps('padding', v), 'padding', 'padding')} />
        </>,
        'padding',
      )}
      {section(
        'block.margin',
        <>
          <Presets items={MARGIN_PRESETS} active={preset(margin, MARGIN_PRESETS)} label={tr('block.margin')} prefix="margin" onPick={(p) => setAll(boxProps('margin', p.px), 'margin')} />
          <SliderRow id="block-margin" value={margin} max={120} onChange={(v) => setAll(boxProps('margin', v), 'margin', 'margin')} />
        </>,
        'margin',
      )}
      {section(
        'block.border',
        <>
          <div className="chips" data-presets="border-style">
            {BORDER_STYLES.map((s) => (
              <button key={s} type="button" className={`chip${borderStyle === s ? ' on' : ''}`} data-preset={s} onClick={() => setAll(borderProps(s, borderWidth || 2), 'border')}>
                {t(`block.border.${s}` as MessageKey)}
              </button>
            ))}
          </div>
          <div className="chips" data-presets="border-width">
            {BORDER_WIDTHS.map((w) => (
              <button key={w.id} type="button" className={`chip${borderStyle !== 'none' && Math.round(borderWidth) === w.px ? ' on' : ''}`} data-preset={w.id} onClick={() => setAll(borderProps(borderStyle === 'none' ? 'solid' : borderStyle, w.px), 'border')}>
                {t(`block.borderWidth.${w.id}` as MessageKey)}
              </button>
            ))}
          </div>
          <ColorSwatches docColors={docColors} current={toHex(styles['border-top-color'])} onPick={borderColorPick} />
        </>,
        'border',
      )}
      {section(
        'block.shadow',
        <Presets items={SHADOW_PRESETS} active={shadow} label={tr('block.shadow')} prefix="shadow" onPick={(p) => setAll(shadowProps(p.css), 'shadow')} />,
        'shadow',
      )}
      {section(
        'block.opacity',
        <SliderRow id="block-opacity" value={opacityOf(styles) * 100} max={100} onChange={(v) => setAll({ opacity: v >= 100 ? null : String(v / 100) }, 'opacity', 'opacity')} />,
        'opacity',
      )}
      {isImage &&
        section(
          'block.size',
          <>
            <p className="p-hint">{t('block.sizeHint')}</p>
            <button type="button" id="block-reset-size" className="btn wide" onClick={() => setAll({ width: null, height: null }, 'reset size')}>
              {t('block.resetSize')}
            </button>
          </>,
          'size',
        )}
    </div>
  );
}
