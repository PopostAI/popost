import { useState } from 'react';
import type { ReactNode } from 'react';

export interface CanvasSize {
  readonly width: number;
  readonly height: number;
}

const COMMON = [
  ['1:1', 1080, 1080], ['3:4', 1080, 1440], ['4:3', 1440, 1080],
  ['16:9', 1920, 1080], ['9:16', 1080, 1920],
] as const;

const SOCIAL = [
  ['TikTok', 1080, 1920], ['Instagram', 1080, 1080], ['Instagram 4:5', 1080, 1350],
  ['X', 1600, 900], ['小红书', 1080, 1440],
] as const;

export const validSize = ({ width, height }: CanvasSize): boolean =>
  [width, height].every((value) => Number.isInteger(value) && value >= 16 && value <= 12000);

export function SizeChoices({ value, onChange, zh, smart }: {
  value: CanvasSize;
  onChange(size: CanvasSize): void;
  zh: boolean;
  smart?: ReactNode;
}) {
  const [tab, setTab] = useState<'common' | 'social'>('common');
  const [draft, setDraft] = useState<CanvasSize | null>(null);
  const size = draft ?? value;
  const choose = (next: CanvasSize) => {
    setDraft(null);
    if (validSize(next)) onChange(next);
  };
  return (
    <div className="pp-size-picker">
      <div className="pp-size-tabs" role="tablist" aria-label={zh ? '尺寸类别' : 'Size categories'}>
        <button type="button" role="tab" aria-selected={tab === 'common'} onClick={() => setTab('common')}>{zh ? '常规' : 'Common'}</button>
        <button type="button" role="tab" aria-selected={tab === 'social'} onClick={() => setTab('social')}>{zh ? '社媒' : 'Social'}</button>
      </div>
      <div className="pp-size-main">
        <form className="pp-size-inputs" onSubmit={(event) => { event.preventDefault(); choose(size); }}>
          {(['width', 'height'] as const).map((axis) => (
            <label key={axis}>{axis === 'width' ? 'W' : 'H'}
              <input aria-label={axis === 'width' ? (zh ? '宽度' : 'Width') : (zh ? '高度' : 'Height')} type="number" min="16" max="12000" value={size[axis] || ''} onChange={(event) => setDraft({ ...size, [axis]: Number(event.currentTarget.value) })} />
            </label>
          ))}
          {draft && <button type="submit" disabled={!validSize(draft)}>{zh ? '应用' : 'Apply'}</button>}
        </form>
        {tab === 'common' && smart}
        <div className="pp-size-presets" role="group">
          {(tab === 'common' ? COMMON : SOCIAL).map(([name, width, height]) => (
            <button key={name} type="button" aria-pressed={width === value.width && height === value.height} onClick={() => choose({ width, height })}>
              <i style={{ width: 22 * Math.min(1, width / height), height: 22 * Math.min(1, height / width) }} />
              <span>{name === '小红书' && !zh ? 'RedNote' : name}<small>{width} × {height}</small></span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
