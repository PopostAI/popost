import { useState, type PointerEvent } from 'react';
import { useT } from '../i18n';
import { PRESET_COLORS, toHex } from '../logic/colors';

export type ColorPhase = 'live' | 'commit';

interface Props {
  docColors: readonly string[];
  current?: string | null;
  allowNone?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  onPick(color: string, phase: ColorPhase): void;
}

const byte = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0');
const clamp = (n: number) => Math.min(1, Math.max(0, n));
const hsvHex = (h: number, s: number, v: number) => {
  const channel = (n: number) => {
    const k = (n + h / 60) % 6;
    return byte(v - v * s * Math.max(0, Math.min(k, 4 - k, 1)));
  };
  return `#${channel(5)}${channel(3)}${channel(1)}`;
};
const hexHsv = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255) as [number, number, number];
  const v = Math.max(r, g, b);
  const d = v - Math.min(r, g, b);
  const h = d ? (v === r ? (g - b) / d : v === g ? 2 + (b - r) / d : 4 + (r - g) / d) * 60 : 0;
  return { h: (h + 360) % 360, s: v ? d / v : 0, v };
};

const MORE = [20, 45, 100, 155, 190, 220, 250, 290, 325, 350].flatMap((h) =>
  [0.94, 0.7, 0.4, 0.18].map((s, i) => hsvHex(h, s, [0.76, 0.92, 0.99, 1][i] ?? 1)),
);

function Picker({ color, onPick, disabled }: { color: string; onPick: Props['onPick']; disabled?: boolean }) {
  const hex = toHex(color.slice(0, 7)) ?? '#222222';
  const [hue, setHue] = useState<number | null>(null);
  const [hexDraft, setHexDraft] = useState<string | null>(null);
  const [alpha, setAlpha] = useState<number | null>(null);
  const hsv = hexHsv(hex);
  const h = hue ?? hsv.h;
  const a = alpha ?? (color.length === 9 ? parseInt(color.slice(7), 16) / 255 : 1);
  const apply = (next: string, opacity: number, phase: ColorPhase) => onPick(opacity === 1 ? next : `${next}${byte(opacity)}`, phase);
  const position = (event: PointerEvent<HTMLDivElement>, phase: ColorPhase) => {
    if (disabled) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setHue(h);
    apply(hsvHex(h, clamp((event.clientX - rect.left) / rect.width), 1 - clamp((event.clientY - rect.top) / rect.height)), a, phase);
  };
  const submitHex = () => {
    if (hexDraft === null) return;
    const value = hexDraft.trim();
    const next = toHex(value.startsWith('#') ? value : `#${value}`);
    if (next) {
      setHue(null);
      apply(next, a, 'commit');
    }
    setHexDraft(null);
  };
  return (
    <div className="color-picker">
      <div className="color-field" style={{ backgroundColor: hsvHex(h, 1, 1) }}
        onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); position(event, 'live'); }}
        onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) position(event, 'live'); }}
        onPointerUp={(event) => position(event, 'commit')}>
        <i style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hex }} />
      </div>
      <input className="color-hue" type="range" min={0} max={359} aria-label="Hue" value={h} disabled={disabled} onChange={(event) => {
        const next = Number(event.currentTarget.value);
        setHue(next);
        apply(hsvHex(next, hsv.s || 0.8, hsv.v || 1), a, 'commit');
      }} />
      <input className="color-alpha" type="range" min={0} max={100} aria-label="Opacity" value={Math.round(a * 100)} disabled={disabled} style={{ backgroundImage: `linear-gradient(90deg, transparent, ${hex})` }} onChange={(event) => {
        const next = Number(event.currentTarget.value) / 100;
        setAlpha(next);
        apply(hex, next, 'commit');
      }} />
      <div className="color-inputs">
        <label>HEX<input aria-label="HEX" value={hexDraft ?? hex.toUpperCase()} maxLength={7} disabled={disabled} onChange={(event) => setHexDraft(event.currentTarget.value)} onBlur={submitHex} onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }} /></label>
        <span>{Math.round(a * 100)}%</span>
      </div>
    </div>
  );
}

export function ColorSwatches({ docColors, current, allowNone, disabled, expanded = false, onPick }: Props) {
  const t = useT();
  const [custom, setCustom] = useState(expanded);
  const [more, setMore] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const selected = draft ?? current ?? '#222222';
  const pick = (color: string, phase: ColorPhase) => {
    setDraft(color);
    onPick(color, phase);
  };
  const swatch = (color: string) => (
    <button key={color} type="button" className={`swatch${color === 'transparent' ? ' none' : ''}${selected === color ? ' current' : ''}`}
      style={color !== 'transparent' ? { background: color } : undefined} title={color === 'transparent' ? t('colors.none') : color}
      aria-label={color === 'transparent' ? t('colors.none') : color} data-color={color} disabled={disabled} onClick={() => pick(color, 'commit')} />
  );
  return (
    <div className="swatches">
      <button type="button" className="btn color-toggle" disabled={disabled} aria-expanded={custom} onClick={() => { setDraft(null); setCustom(!custom); }}>{t('colors.custom')}</button>
      {custom && <Picker color={selected === 'transparent' ? '#ffffff' : selected} onPick={pick} disabled={disabled} />}
      {docColors.length > 0 && <>
        <div className="swatch-title">{t('colors.document')}</div>
        <div className="swatch-grid" data-swatches="document">{docColors.map(swatch)}</div>
      </>}
      <div className="swatch-title">{t('colors.presets')}</div>
      <div className="swatch-grid" data-swatches="presets">
        {allowNone && swatch('transparent')}
        {PRESET_COLORS.map(swatch)}
        {more && MORE.map(swatch)}
      </div>
      <button type="button" className="btn color-toggle" aria-expanded={more} onClick={() => setMore(!more)}>{t(more ? 'colors.collapse' : 'colors.expand')}</button>
    </div>
  );
}
