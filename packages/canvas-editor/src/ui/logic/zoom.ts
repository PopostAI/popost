/** Zoom math. Zoom values are percentages; the rendered scale is `percent / 100`. */
export const ZOOM_MIN = 10;
export const ZOOM_MAX = 300;
/** Free space kept around the page when fitting it into the stage. */
export const STAGE_PADDING = 32;

export const clampZoom = (percent: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, percent));

/** Percentage that fits a page into the stage (unrounded so the page touches the padding exactly). */
export function fitZoom(stage: { width: number; height: number }, page: { width: number; height: number }, padding = STAGE_PADDING): number {
  if (page.width <= 0 || page.height <= 0) return 100;
  const w = Math.max(1, stage.width - padding * 2);
  const h = Math.max(1, stage.height - padding * 2);
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.min(w / page.width, h / page.height) * 100));
}

/** Next zoom for Ctrl/Cmd + and - (12% per step). */
export function stepZoom(current: number, direction: 1 | -1): number {
  return clampZoom(current * (direction > 0 ? 1.12 : 1 / 1.12));
}

/** Zoom after a Ctrl+wheel tick (`deltaY` > 0 zooms out). */
export const wheelZoom = (current: number, deltaY: number): number => clampZoom(current * Math.exp(-deltaY * 0.002));
