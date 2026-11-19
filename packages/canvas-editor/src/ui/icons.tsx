import type { ReactNode } from 'react';

/** Small stroke icons (16 px grid, currentColor). */
const PATHS = {
  undo: 'M6 4 3 7l3 3M3 7h6.5a3.5 3.5 0 0 1 0 7H7',
  redo: 'm10 4 3 3-3 3M13 7H6.5a3.5 3.5 0 0 0 0 7H9',
  reset: 'M3 8a5 5 0 1 0 1.6-3.7M3 2.5v3h3',
  save: 'M3 3h8l2 2v8H3zM5.5 3v3.5h5V3M5.5 13V9.5h5V13',
  export: 'M8 2v8M5 7l3 3 3-3M3 12.5h10',
  download: 'M8 2v7.5M5 7l3 3 3-3M2.5 13.5h11',
  chevron: 'm4 6 4 4 4-4',
  close: 'm4 4 8 8M12 4l-8 8',
  prev: 'm10 3-5 5 5 5',
  next: 'm6 3 5 5-5 5',
  grip: 'M6 4v.01M10 4v.01M6 8v.01M10 8v.01M6 12v.01M10 12v.01',
  parent: 'M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3M6 6h4v4H6z',
  duplicate: 'M5.5 5.5h7v7h-7zM3.5 10.5v-7h7',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4',
  forward: 'M8 3v8M4.5 7.5 8 11l3.5-3.5M3 13.5h10',
  backward: 'M8 13V5M4.5 8.5 8 5l3.5 3.5M3 2.5h10',
  text: 'M3.5 4V3h9v1M8 3v10M6 13h4',
  block: 'M3 3h10v10H3zM3 7h10',
  layers: 'm8 2.5 5.5 3L8 8.5l-5.5-3zM2.5 8.5 8 11.5l5.5-3M2.5 11 8 14l5.5-3',
  code: 'm5.5 4.5-3.5 3.5 3.5 3.5M10.5 4.5 14 8l-3.5 3.5',
  warn: 'M8 3 14 13H2zM8 7v3M8 11.5v.01',
  alignLeft: 'M3 4h10M3 7h6M3 10h10M3 13h6',
  alignCenter: 'M3 4h10M5 7h6M3 10h10M5 13h6',
  alignRight: 'M3 4h10M7 7h6M3 10h10M7 13h6',
  alignJustify: 'M3 4h10M3 7h10M3 10h10M3 13h10',
  spacing: 'M3 3v10M13 3v10M5.5 8h5M7.5 6 5.5 8l2 2M8.5 6l2 2-2 2',
  eraser: 'm9 3 4 4-5.5 5.5H5L3 10.5zM6 6l4 4M8 12.5h5',
  opacity: 'M8 2.5s4 4.2 4 7.2a4 4 0 0 1-8 0c0-3 4-7.2 4-7.2z',
  image: 'M2.5 3.5h11v9h-11zM2.5 11l3.5-3.5 3 3 2-2 2.5 2.5M10.5 6v.01',
  compare: 'M2 3h5v10H2zM9 3h5v10H9z',
  crop: 'M4.5 2v9.5H14M2 4.5h9.5V14',
  replace: 'M3 6h8.5M9 3.5 11.5 6 9 8.5M13 10H4.5M7 7.5 4.5 10 7 12.5',
  pencil: 'M3 10.5 10.5 3a1.8 1.8 0 0 1 2.5 2.5L5.5 13H3zM9.5 4l2.5 2.5',
  brush: 'M3 13c1.5 0 2.5-.5 2.5-2 0-1 .5-1.5 1.5-1.5L12.5 4a1.4 1.4 0 0 0-2-2L5 7.5c-.5.5-1 1-1 2C4 11 3 11.5 3 13z',
  paste: 'M5.5 3h5v2h-5zM4 4h8v9.5H4zM6.5 8h3M6.5 10.5h3',
  shape: 'M8 2.5 13.5 12.5h-11z',
  play: 'M5.5 3.5v9l7-4.5z',
  minus: 'M3 8h10',
  gem: 'M2 5.5 4.7 2.8h6.6L14 5.5 8 13.2 2 5.5zM2 5.5h12M4.7 2.8l1.2 2.7L8 13.2l2.1-7.7 1.2-2.7',
  wrap: 'M2 4h12M2 7.5h9a2.2 2.2 0 0 1 0 4.4H6m2-2-2 2 2 2M2 11h1',
  plus: 'M8 3v10M3 8h10',
  cloud: 'M4.5 12.5a3 3 0 0 1-.5-5.9A4.2 4.2 0 0 1 12 7a2.8 2.8 0 0 1-.2 5.5z',
  upload: 'M8 10V2.5M5 5.5 8 2.5l3 3M3 9v4.5h10V9',
  check: 'm3.5 8.5 3 3 6-7',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }): ReactNode {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
