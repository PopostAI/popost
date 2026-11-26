import type { PreviewState } from '../../protocol';
import type { Selection } from '../model';

/** Keep an already visible item in place; otherwise reveal it past its entrance. */
export const selectionFrame = (state: PreviewState | null, selection: Selection, frame: number): number => {
  const r = state?.resolved;
  const span = selection.kind === 'item' ? r?.items.find(x => x.id === selection.id)
    : selection.kind === 'audio' ? r?.audio.find(x => x.id === selection.id)
    : selection.kind === 'segment' || selection.kind === 'slot' ? r?.segments.find(x => x.id === selection.id) : undefined;
  if (!span) return frame;
  const end = span.end ?? r!.frames;
  const entrance = 'enter' in span ? span.enter?.frames ?? 0 : 0;
  if (frame >= span.start + entrance && frame < end && selection.kind !== 'slot') return frame;
  return Math.min(end - 1, Math.max(span.start + entrance, span.start + Math.floor((end - span.start) * .3)));
};
