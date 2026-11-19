import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import type { EditOp, EditorController, NodeId } from '../contracts';
import { buildFontMenu } from '../fonts/palette';
import type { PaletteRole } from '../fonts/palette';
import type { Actions } from './actions';
import { ImagePicker, isImgBlock } from './ImageTools';
import { Icon } from './icons';
import type { IconName } from './icons';
import { useT } from './i18n';
import type { MessageKey } from './i18n';
import { toHex } from './logic/colors';
import { activeFromStyles, alignOf, firstFamily, fontSizeOf, letterSpacingEm, lineHeightRatio, opacityOf, STATE_PROPS } from './logic/format-state';
import type { Align } from './logic/format-state';
import { ColorSwatches } from './panels/ColorSwatches';
import type { ColorPhase } from './panels/ColorSwatches';
import { targetsOf, useDocColors, useKinds, useTargetStyles } from './panels/hooks';
import { frameFontsSettled } from './frame-dom';
import { Popover } from './Popover';
import { useSnapshot } from './use-snapshot';

export interface CropControl {
  id: NodeId | null;
  setId(id: NodeId | null): void;
}

interface Props {
  controller: EditorController;
  actions: Actions;
  onOpenBlock(): void;
  crop: CropControl;
}

const ALIGNS: Array<{ id: Align; icon: IconName; label: MessageKey }> = [
  { id: 'left', icon: 'alignLeft', label: 'toolbar.alignLeft' },
  { id: 'center', icon: 'alignCenter', label: 'toolbar.alignCenter' },
  { id: 'right', icon: 'alignRight', label: 'toolbar.alignRight' },
  { id: 'justify', icon: 'alignJustify', label: 'toolbar.alignJustify' },
];

const MISSING_FONT = '__doc-font';
const MIN_SIZE = 1;
const MAX_SIZE = 999;

type PopId = 'color' | 'spacing' | 'opacity' | 'image';

function Slider({ id, label, min, max, step, value, format, onChange }: { id: string; label: string; min: number; max: number; step: number; value: number; format(v: number): string; onChange(v: number): void }) {
  return (
    <label className="slider-row">
      <span className="slider-label">{label}</span>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <output>{format(value)}</output>
    </label>
  );
}

/**
 * Format toolbar (`#format-toolbar`). The row is always present (controls disabled without a selection) so that
 * selecting a block never resizes the stage. While a text edit is open, buttons keep the frame focused (the App root
 * prevents the mousedown default); the size input and the font select take focus, which commits the edit — see
 * `FormatToolbar` notes in docs/history/oss-cleanup-progress.md.
 */
export function FormatToolbar({ controller, actions, onOpenBlock, crop }: Props) {
  const t = useT();
  const snap = useSnapshot(controller);
  const targets = targetsOf(snap);
  const hasTarget = snap.docState === 'ready' && targets.length > 0;
  const kinds = useKinds(controller, targets, snap.sourceVersion);
  const textual = hasTarget && (snap.editingTextId !== null || kinds.some((k) => k === 'text' || k === 'box'));
  const imageId = snap.docState === 'ready' && snap.selection.length === 1 && snap.selection[0] !== undefined && isImgBlock(controller, snap.selection[0]) ? snap.selection[0] : null;

  const styles = useTargetStyles(controller, snap, STATE_PROPS);
  const active = activeFromStyles(styles, snap.editingTextId ? snap.textState?.active : null);
  const size = fontSizeOf(styles);
  const align = alignOf(styles['text-align']);
  const colorHex = toHex(styles.color) ?? '#000000';
  const docColors = useDocColors(controller, snap.sourceVersion);
  const rangeEditing = snap.editingTextId !== null && snap.textState?.range === true;

  const [pop, setPop] = useState<PopId | null>(null);
  const closePop = (): void => setPop(null);
  const colorBtn = useRef<HTMLButtonElement | null>(null);
  const spacingBtn = useRef<HTMLButtonElement | null>(null);
  const opacityBtn = useRef<HTMLButtonElement | null>(null);
  const imageBtn = useRef<HTMLButtonElement | null>(null);
  // A popover belongs to the current selection.
  const targetKey = targets.join(',');
  useEffect(() => setPop(null), [targetKey]);

  /* ---- fonts ---- */
  const [roles, setRoles] = useState<PaletteRole[] | null>(null);
  const [fontsFailed, setFontsFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    controller.fontPalette().then(
      (p) => alive && setRoles(p.roles as PaletteRole[]),
      () => alive && setFontsFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [controller]);
  const menu = useMemo(() => (roles ? buildFontMenu(roles) : []), [roles]);
  const family = firstFamily(styles['font-family']);
  const known = roles?.some((r) => r.family === family) ?? false;
  const fontValue = !hasTarget || family === '' ? '' : known ? family : MISSING_FONT;

  /* ---- applying ---- */
  const setStyleAll = (props: Record<string, string | null>, label: string, coalesce?: string): void => {
    const ops: EditOp[] = targets.map((id) => ({ kind: 'setStyle', id, props }));
    controller.applyBatch(ops, label, coalesce ? { coalesceKey: `${coalesce}:${targetKey}` } : undefined);
  };
  const applyColor = (color: string, phase: ColorPhase): void => {
    // A range edit takes the picker's final colour only; live drags would pile up wrapper spans.
    if (rangeEditing && phase === 'live') return;
    controller.format({ command: 'color', value: color });
    if (phase === 'commit') closePop(); // swatch click, or the native picker was closed
  };
  const applySize = (n: number): void => {
    if (!Number.isFinite(n)) return;
    controller.format({ command: 'fontSize', value: `${Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(n)))}px` });
  };
  const setAlign = (a: Align): void => {
    const editing = snap.editingTextId;
    setStyleAll({ 'text-align': a }, 'align');
    if (editing) controller.beginTextEdit(editing, 'end'); // the block-level change committed the edit; carry on typing
  };

  // `#tb-font` is disabled while a font is being fetched and embedded (external tests wait for it to re-enable).
  const [fontBusy, setFontBusy] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const sizeShown = draft ?? (size > 0 ? String(Math.round(size * 10) / 10) : '');

  const tool = (id: string, label: string, content: ReactNode, opts: { on?: boolean; disabled?: boolean; onClick(): void; ref?: RefObject<HTMLButtonElement | null> }) => (
    <button ref={opts.ref} type="button" id={id} className={`tb-btn small fmt${opts.on ? ' on' : ''}`} title={label} aria-label={label} aria-pressed={opts.on === undefined ? undefined : opts.on} disabled={opts.disabled ?? !hasTarget} onClick={opts.onClick}>
      {content}
    </button>
  );
  const fmt = (command: 'bold' | 'italic' | 'underline' | 'strike' | 'uppercase' | 'clear') => () => controller.format({ command });

  return (
    <div className="fmt-row" data-has-target={hasTarget ? '1' : '0'}>
      <select
        id="tb-font"
        className="fmt-font"
        title={t('toolbar.font')}
        aria-label={t('toolbar.font')}
        disabled={!textual || !roles || fontBusy}
        value={fontValue}
        onChange={(e) => {
          const role = roles?.find((r) => r.family === e.target.value);
          if (!role) return;
          setFontBusy(true);
          void controller
            .applyFont(role.id, targets)
            .then(() => frameFontsSettled(role.family))
            .finally(() => setFontBusy(false));
        }}
      >
        {!roles && <option value="">{fontsFailed ? t('toolbar.fontsFailed') : t('toolbar.fontsLoading')}</option>}
        {roles && fontValue === '' && <option value="" disabled>{t('toolbar.font')}</option>}
        {roles && fontValue === MISSING_FONT && (
          <option value={MISSING_FONT} disabled>
            {t('toolbar.fontMissing', { name: family })}
          </option>
        )}
        {menu.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.options.map((o) => (
              <option key={o.fontId} value={o.value} title={o.title} data-font-id={o.fontId}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>

      <span className="fmt-size">
        {tool('tb-size-dec', t('toolbar.sizeDown'), '−', { disabled: !textual, onClick: () => applySize((size || 16) - 1) })}
        <input
          id="tb-size"
          type="number"
          min={MIN_SIZE}
          max={MAX_SIZE}
          step={1}
          inputMode="numeric"
          title={t('toolbar.size')}
          aria-label={t('toolbar.size')}
          disabled={!textual}
          value={sizeShown}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => setDraft(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              applySize(Number(draft ?? sizeShown));
              setDraft(null);
            }
          }}
        />
        {tool('tb-size-inc', t('toolbar.sizeUp'), '+', { disabled: !textual, onClick: () => applySize((size || 16) + 1) })}
      </span>

      <span className="tb-sep" />
      {tool('tb-bold', t('toolbar.bold'), <b>B</b>, { on: active.bold, disabled: !textual, onClick: fmt('bold') })}
      {tool('tb-italic', t('toolbar.italic'), <i>I</i>, { on: active.italic, disabled: !textual, onClick: fmt('italic') })}
      {tool('tb-underline', t('toolbar.underline'), <u>U</u>, { on: active.underline, disabled: !textual, onClick: fmt('underline') })}
      {tool('tb-strike', t('toolbar.strike'), <s>S</s>, { on: active.strike, disabled: !textual, onClick: fmt('strike') })}
      {tool(
        'tb-color',
        t('toolbar.color'),
        <span className="color-glyph">
          A<i style={{ background: colorHex }} />
        </span>,
        { ref: colorBtn, disabled: !textual, on: pop === 'color', onClick: () => setPop(pop === 'color' ? null : 'color') },
      )}
      <Popover open={pop === 'color'} anchor={colorBtn} onClose={closePop} id="pop-color" className="pop-colors">
        <ColorSwatches docColors={docColors} current={colorHex} onPick={applyColor} />
      </Popover>

      <span className="tb-sep" />
      {ALIGNS.map((a) => (
        <Fragment key={a.id}>{tool(`tb-align-${a.id}`, t(a.label), <Icon name={a.icon} />, { on: textual && align === a.id, disabled: !textual, onClick: () => setAlign(a.id) })}</Fragment>
      ))}
      {tool('tb-spacing', t('toolbar.spacing'), <Icon name="spacing" />, { ref: spacingBtn, disabled: !textual, on: pop === 'spacing', onClick: () => setPop(pop === 'spacing' ? null : 'spacing') })}
      <Popover open={pop === 'spacing'} anchor={spacingBtn} onClose={closePop} id="pop-spacing">
        <Slider id="tb-line-height" label={t('toolbar.lineHeight')} min={0.8} max={3} step={0.05} value={lineHeightRatio(styles)} format={(v) => v.toFixed(2)} onChange={(v) => setStyleAll({ 'line-height': String(Math.round(v * 100) / 100) }, 'line-height', 'lh')} />
        <Slider id="tb-letter-spacing" label={t('toolbar.letterSpacing')} min={-0.1} max={0.5} step={0.005} value={letterSpacingEm(styles)} format={(v) => `${Math.round(v * 1000)}‰`} onChange={(v) => setStyleAll({ 'letter-spacing': `${Math.round(v * 1000) / 1000}em` }, 'letter-spacing', 'ls')} />
      </Popover>
      {tool('tb-uppercase', t('toolbar.uppercase'), <span className="aa">aA</span>, { on: active.uppercase, disabled: !textual, onClick: fmt('uppercase') })}
      {tool('tb-opacity', t('toolbar.opacity'), <Icon name="opacity" />, { ref: opacityBtn, on: pop === 'opacity', onClick: () => setPop(pop === 'opacity' ? null : 'opacity') })}
      <Popover open={pop === 'opacity'} anchor={opacityBtn} onClose={closePop} id="pop-opacity">
        <Slider id="tb-opacity-range" label={t('toolbar.opacity')} min={0} max={100} step={1} value={Math.round(opacityOf(styles) * 100)} format={(v) => `${v}%`} onChange={(v) => setStyleAll({ opacity: v >= 100 ? null : String(v / 100) }, 'opacity', 'opacity')} />
      </Popover>
      {tool('tb-clear', t('toolbar.clear'), <Icon name="eraser" />, { disabled: !textual, onClick: fmt('clear') })}
      <span className="tb-sep" />
      {tool('tb-copy-style', t('toolbar.copyStyle'), <Icon name="brush" />, { disabled: !textual, onClick: actions.copyStyle })}
      {tool('tb-paste-style', t('toolbar.pasteStyle'), <Icon name="paste" />, { disabled: !textual, onClick: actions.pasteStyle })}

      {imageId !== null && (
        <>
          <span className="tb-sep" />
          <button ref={imageBtn} type="button" id="tb-replace" className={`tb-btn small fmt wide${pop === 'image' ? ' on' : ''}`} title={t('toolbar.replaceImage')} onClick={() => setPop(pop === 'image' ? null : 'image')}>
            <Icon name="replace" /> <span className="fmt-text">{t('toolbar.replaceImage')}</span>
          </button>
          <Popover open={pop === 'image'} anchor={imageBtn} onClose={closePop} id="pop-image" className="pop-image">
            <ImagePicker controller={controller} id={imageId} onDone={closePop} />
          </Popover>
          <button type="button" id="tb-crop" className={`tb-btn small fmt wide${crop.id === imageId ? ' on' : ''}`} title={t('toolbar.crop')} onClick={() => crop.setId(crop.id === imageId ? null : imageId)}>
            <Icon name="crop" /> <span className="fmt-text">{t('toolbar.crop')}</span>
          </button>
        </>
      )}

      <span className="fmt-spacer" />
      <button type="button" id="tb-block" className="tb-btn small fmt wide" disabled={!hasTarget} title={t('toolbar.block')} onClick={onOpenBlock}>
        <Icon name="block" /> <span className="fmt-text">{t('toolbar.block')}</span>
      </button>
    </div>
  );
}
