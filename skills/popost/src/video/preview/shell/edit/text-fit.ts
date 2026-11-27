import type { PreviewState } from '../../protocol';
import { textStyle } from '../../../presets/text-styles';
import { isObj, type EditOp } from './source';

/** Measure with the loaded project font, then persist the fitted size in the same undo step as the text. */
export const fitTextEdit = (state: PreviewState | null, op: EditOp): EditOp => {
  if (!state?.resolved || op.op !== 'set' || op.path[0] !== 'tracks' || op.path[2] !== 'text' || typeof op.value !== 'string') return op;
  const source = isObj(state.source) ? state.source : {};
  const track = Array.isArray(source.tracks) ? source.tracks[Number(op.path[1])] : undefined;
  if (!isObj(track) || track.type !== 'text') return op;
  const item = state.resolved.items.find(it => it.id === track.id);
  const page = document.querySelector<HTMLIFrameElement>('#page');
  const doc = page?.contentDocument;
  const original = doc?.querySelector<HTMLElement>('[data-item="' + CSS.escape(String(track.id)) + '"] > div');
  if (!doc || !original || !item?.style) return op;
  const width = item.box[2] * state.resolved.canvas.width;
  const height = item.box[3] * state.resolved.canvas.height;
  const probe = original.cloneNode(false) as HTMLElement;
  probe.textContent = op.value;
  Object.assign(probe.style, { position: 'fixed', left: '0', top: '0', width: width + 'px', height: 'auto', visibility: 'hidden', transform: 'none' });
  doc.body.append(probe);
  const maximum = item.style.size * state.resolved.canvas.height;
  const fits = (size: number): boolean => {
    probe.style.fontSize = size + 'px';
    probe.style.letterSpacing = (item.style!.letterSpacing ?? 0) * size + 'px';
    return probe.scrollHeight <= height + .5 && probe.scrollWidth <= width + .5;
  };
  try {
    if (fits(maximum)) return op;
    let low = 1, high = maximum;
    for (let i = 0; i < 16; i++) { const mid = (low + high) / 2; if (fits(mid)) low = mid; else high = mid; }
    const { font: _font, ...preset } = textStyle(typeof track.style === 'string' ? track.style as Parameters<typeof textStyle>[0] : undefined);
    const style = isObj(track.style) ? track.style : preset;
    return { op: 'set', path: ['tracks', Number(op.path[1])], value: { ...track, text: op.value,
      style: { ...style, size: Math.floor(low * 100) / 100 / state.resolved.canvas.height } } };
  } finally { probe.remove(); }
};
