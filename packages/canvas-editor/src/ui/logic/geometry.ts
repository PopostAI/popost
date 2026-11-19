/** Position and resize computations for the interaction layer (SPEC §5). Pure; values rounded to 1 px. */
import type { Box } from './snap';

/** How a block is positioned today, read from its computed style. */
export type Placement = { mode: 'abs'; left: number; top: number } | { mode: 'flow'; x: number; y: number };

const PX = /^(-?\d*\.?\d+)(?:px)?$/;

const px = (value: string | undefined): number | null => {
  const m = PX.exec((value ?? '').trim());
  return m ? Number(m[1]) : null;
};

/** `translate` as x/y px; `none` = 0,0; null when a component is not a plain length (e.g. a percentage). */
export function parseTranslate(value: string | undefined): { x: number; y: number } | null {
  const v = (value ?? '').trim();
  if (v === '' || v === 'none') return { x: 0, y: 0 };
  const parts = v.split(/\s+/);
  if (parts.length > 3) return null;
  const nums = parts.map(px);
  if (nums.some((n) => n === null)) return null;
  return { x: nums[0] as number, y: nums[1] ?? 0 };
}

export const NUDGE_STYLE_PROPS = ['position', 'left', 'top', 'translate'];

/** Absolute / fixed blocks move through `left`/`top`; everything else through the `translate` property. */
export function readPlacement(style: Readonly<Record<string, string>>): Placement {
  const position = style.position;
  if (position === 'absolute' || position === 'fixed') {
    const left = px(style.left);
    const top = px(style.top);
    if (left !== null && top !== null) return { mode: 'abs', left, top };
  }
  const t = parseTranslate(style.translate) ?? { x: 0, y: 0 };
  return { mode: 'flow', x: t.x, y: t.y };
}

const round1 = (n: number): number => Math.round(n);
const fmt = (n: number): string => `${round1(n)}px`;

/** Style declarations that move a block by (dx, dy) document px. */
export function moveProps(from: Placement, dx: number, dy: number): Record<string, string> {
  return from.mode === 'abs'
    ? { left: fmt(from.left + dx), top: fmt(from.top + dy) }
    : { translate: `${fmt(from.x + dx)} ${fmt(from.y + dy)}` };
}

export type ResizeHandle = 'nw' | 'ne' | 'sw' | 'se' | 'w' | 'e';
export type ResizeKind = 'text' | 'image' | 'svg' | 'video' | 'box';

export const MIN_SIZE = 8;
export const MIN_FONT = 4;

export interface ResizeInput {
  handle: ResizeHandle;
  kind: ResizeKind;
  /** Border box at the start of the gesture. */
  start: Box;
  /** Pointer movement in document px. */
  dx: number;
  dy: number;
  /** Computed font size in px (text corner scaling). */
  fontSize: number;
  /** Padding + border that CSS `width`/`height` do not include (content-box), per axis. */
  extra: { width: number; height: number };
}

export interface ResizeResult {
  /** `width` / `height` / `font-size` declarations. */
  props: Record<string, string>;
  /** Movement of the top-left corner (west / north handles) to be applied through the block's placement. */
  shift: { x: number; y: number };
  /** Resulting border-box size (text height is only an estimate: the browser reflows it). */
  width: number;
  height: number;
}

const isCorner = (h: ResizeHandle): boolean => h.length === 2;
const isMedia = (k: ResizeKind): boolean => k === 'image' || k === 'svg' || k === 'video';

/**
 * Resize rules: side handles change `width` (text reflows; media keeps its aspect ratio through an explicit
 * height). Corners scale text proportionally (`font-size` + `width`), keep the aspect ratio of media and are
 * free for plain boxes.
 */
export function resizeBlock(input: ResizeInput): ResizeResult {
  const { handle, kind, start, dx, dy } = input;
  const west = handle.includes('w');
  const north = handle.startsWith('n');
  const w0 = Math.max(1, start.width);
  const h0 = Math.max(1, start.height);

  let width = Math.max(MIN_SIZE, w0 + (west ? -dx : dx));
  let height = h0;
  const props: Record<string, string> = {};
  let fontScale: number | null = null;

  if (!isCorner(handle)) {
    if (isMedia(kind)) height = (width * h0) / w0;
  } else if (kind === 'text') {
    fontScale = width / w0;
    height = h0 * fontScale;
  } else if (isMedia(kind)) {
    height = (width * h0) / w0;
  } else {
    height = Math.max(MIN_SIZE, h0 + (north ? -dy : dy));
  }

  width = round1(width);
  props.width = fmt(width - input.extra.width);
  if (isMedia(kind) || (isCorner(handle) && kind === 'box')) {
    height = round1(height);
    props.height = fmt(height - input.extra.height);
  }
  if (fontScale !== null) {
    const size = Math.max(MIN_FONT, Math.round(input.fontSize * fontScale * 2) / 2);
    props['font-size'] = `${size}px`;
  }
  return {
    props,
    shift: { x: west ? w0 - width : 0, y: north ? h0 - height : 0 },
    width,
    height: round1(height),
  };
}
