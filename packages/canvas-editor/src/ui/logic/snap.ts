/** Snapping for drag-move (SPEC §5): page edges and centre, other blocks' edges and centres. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Guide {
  axis: 'x' | 'y';
  /** Position of the line on its axis (document px). */
  pos: number;
  /** Extent along the other axis. */
  from: number;
  to: number;
}

export interface SnapResult {
  /** Adjustment to add to the box position. */
  dx: number;
  dy: number;
  guides: Guide[];
}

const EPS = 0.5;

/** Edge, centre, edge lines of a box on one axis. */
const lines = (start: number, size: number): number[] => [start, start + size / 2, start + size];

interface Best {
  adjust: number;
  distance: number;
}

function bestOnAxis(mine: number[], targets: number[], threshold: number): Best | null {
  let best: Best | null = null;
  for (const m of mine) {
    for (const t of targets) {
      const distance = Math.abs(t - m);
      if (distance <= threshold && (best === null || distance < best.distance)) best = { adjust: t - m, distance };
    }
  }
  return best;
}

/**
 * Snap `box` (already moved by the pointer) to the closest page/block lines within `threshold` (document px).
 * Returns the correction per axis and the guide lines that now coincide with the box.
 */
export function snapBox(box: Box, others: readonly Box[], page: { width: number; height: number }, threshold: number): SnapResult {
  const pageBox: Box = { x: 0, y: 0, width: page.width, height: page.height };
  const targets = [pageBox, ...others];
  const xs = targets.flatMap((b) => lines(b.x, b.width));
  const ys = targets.flatMap((b) => lines(b.y, b.height));
  const bx = bestOnAxis(lines(box.x, box.width), xs, threshold);
  const by = bestOnAxis(lines(box.y, box.height), ys, threshold);
  const dx = bx?.adjust ?? 0;
  const dy = by?.adjust ?? 0;
  const snapped: Box = { ...box, x: box.x + dx, y: box.y + dy };

  const guides: Guide[] = [];
  const add = (axis: 'x' | 'y', pos: number, a: Box, b: Box): void => {
    const [from, to] = axis === 'x' ? [Math.min(a.y, b.y), Math.max(a.y + a.height, b.y + b.height)] : [Math.min(a.x, b.x), Math.max(a.x + a.width, b.x + b.width)];
    if (!guides.some((g) => g.axis === axis && Math.abs(g.pos - pos) < EPS && g.from === from && g.to === to)) guides.push({ axis, pos, from, to });
  };
  if (bx) {
    for (const t of targets) {
      for (const line of lines(t.x, t.width)) {
        if (lines(snapped.x, snapped.width).some((m) => Math.abs(m - line) < EPS)) add('x', line, snapped, t);
      }
    }
  }
  if (by) {
    for (const t of targets) {
      for (const line of lines(t.y, t.height)) {
        if (lines(snapped.y, snapped.height).some((m) => Math.abs(m - line) < EPS)) add('y', line, snapped, t);
      }
    }
  }
  return { dx, dy, guides };
}

export function unionBox(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null;
  const x1 = Math.min(...boxes.map((b) => b.x));
  const y1 = Math.min(...boxes.map((b) => b.y));
  const x2 = Math.max(...boxes.map((b) => b.x + b.width));
  const y2 = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export function boxesIntersect(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Normalised box between two points. */
export function boxBetween(x1: number, y1: number, x2: number, y2: number): Box {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}
