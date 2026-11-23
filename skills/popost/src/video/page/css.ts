/** CSS helpers the page's builders share: numbers, elements, and how a part of a text looks. */
import type { ResolvedTextStyle, TextSpanStyle } from '../types';

export const n4 = (v: number): string => String(Math.round(v * 1e4) / 1e4);
export const px = (v: number): string => n4(v) + 'px';

export const element = <K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, css: string, parent: Element): HTMLElementTagNameMap[K] => {
  const el = doc.createElement(tag);
  el.style.cssText = css;
  parent.appendChild(el);
  return el;
};

/** A background behind characters; edges: which outer sides get the padding and the rounded corners. */
export const backgroundCss = (bg: NonNullable<ResolvedTextStyle['background']>, size: number, left: boolean, right: boolean): string => {
  const pad = (bg.padding ?? 0.3) * size;
  const rad = (bg.radius ?? 0) * size;
  return 'background:' + bg.color + ';padding:' + [pad, right ? pad : 0, pad, left ? pad : 0].map(px).join(' ') +
    ';border-radius:' + [left ? rad : 0, right ? rad : 0, right ? rad : 0, left ? rad : 0].map(px).join(' ') + ';';
};

/** Colour, weight and slant of characters set by a span. */
export const spanCss = (span: TextSpanStyle | undefined): string =>
  !span ? '' : (span.color ? 'color:' + span.color + ';' : '') + (span.weight ? 'font-weight:' + span.weight + ';' : '') +
    (span.italic !== undefined ? 'font-style:' + (span.italic ? 'italic' : 'normal') + ';' : '');
