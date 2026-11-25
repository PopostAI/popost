/** Small DOM helpers of the shell: element creation and the few line icons it uses. */

export interface Props {
  class?: string;
  id?: string;
  text?: string;
  title?: string;
  style?: string;
  attrs?: Readonly<Record<string, string>>;
  data?: Readonly<Record<string, string>>;
  on?: Readonly<Partial<Record<string, (e: Event) => void>>>;
}

export const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, children: readonly (Node | string)[] = []): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.id) el.id = props.id;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.title) el.title = props.title;
  if (props.style) el.style.cssText = props.style;
  for (const [k, v] of Object.entries(props.attrs ?? {})) el.setAttribute(k, v);
  for (const [k, v] of Object.entries(props.data ?? {})) el.dataset[k] = v;
  for (const [k, fn] of Object.entries(props.on ?? {})) if (fn) el.addEventListener(k, fn);
  el.append(...children);
  return el;
};

const SVG = 'http://www.w3.org/2000/svg';

/** 16x16 line icons, drawn with the current text colour. */
const ICONS = {
  film: 'M2 2h12v12H2zM5 2v12M11 2v12M2 6h3M2 10h3M11 6h3M11 10h3',
  media: 'M2 2h12v12H2zM2 12l4-5 4 4 2-2 2 3M5 4h.1',
  text: 'M2 3h12M8 3v11M5 14h6',
  layers: 'M1 5l7-4 7 4-7 4-7-4M1 8l7 4 7-4M1 11l7 4 7-4',
  code: 'M5 3 1 8l4 5M11 3l4 5-4 5M9 2 7 14',
  checks: 'M8 1l6 2v5c0 4-6 7-6 7S2 12 2 8V3l6-2M5 8l2 2 4-4',
  first: 'M4 3v10M12 3.5 6 8l6 4.5z',
  last: 'M12 3v10M4 3.5 10 8l-6 4.5z',
  play: 'M5 3l8 5-8 5z',
  pause: 'M5.5 3v10M10.5 3v10',
  undo: 'M6 3.5 3 6.5l3 3M3 6.5h6.5a3.5 3.5 0 0 1 0 7H7',
  redo: 'M10 3.5l3 3-3 3M13 6.5H6.5a3.5 3.5 0 0 0 0 7H9',
  remove: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5M7 7v4M9 7v4',
  addText: 'M2 3.5h7M5.5 3.5V12M11.5 8v5M9 10.5h5',
  duplicate: 'M5.5 5.5h7v7h-7zM3.5 10.5v-7h7',
  render: 'M2.5 3.5h11v9h-11zM7 6l3 2-3 2z',
} as const;

export type IconName = keyof typeof ICONS;

export const icon = (name: IconName): SVGSVGElement => {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', ICONS[name]);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('stroke-linecap', 'round');
  svg.appendChild(path);
  return svg;
};

/** left and width of the frames start .. end-1 on a track of total frames, in percent. */
export const placeSpan = (el: HTMLElement, start: number, end: number, total: number): HTMLElement => {
  const t = Math.max(1, total);
  el.style.left = (Math.max(0, start) / t) * 100 + '%';
  el.style.width = (Math.max(0, Math.min(end, t) - Math.max(0, start)) / t) * 100 + '%';
  return el;
};

/** A position on the boundary before frame f, in percent. */
export const placeAt = (el: HTMLElement, f: number, total: number): HTMLElement => {
  el.style.left = (Math.max(0, Math.min(f, total)) / Math.max(1, total)) * 100 + '%';
  return el;
};

/** A box given as fractions of the canvas, in percent of its container. */
export const placeBox = (el: HTMLElement, box: readonly number[]): HTMLElement => {
  const [x = 0, y = 0, w = 0, hgt = 0] = box;
  el.style.left = x * 100 + '%';
  el.style.top = y * 100 + '%';
  el.style.width = w * 100 + '%';
  el.style.height = hgt * 100 + '%';
  return el;
};
