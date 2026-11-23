/**
 * Text that follows the words (a caption cue with ResolvedItem.words): built once, restyled on every frame from n alone.
 *
 * Nothing may move when a token changes look, so each token is an inline-block that holds two copies of its characters:
 * an invisible one in the flow, set at the heavier of each character's own weight and the spoken weight (it gives the
 * token its room, so the layout is the same on every frame), and the visible one in a layer laid over that room, centred
 * in it. The spoken background is a box outside the flow, around the room; the spoken scale is a transform of the layer
 * and the box. Stacking inside the item (its element is a stacking context): the spoken token's box (z 0), below every
 * other token and the text between tokens (z 1), below the spoken token's characters (z 2): the box never covers a
 * neighbour and a larger spoken token stays on top.
 */
import type { ResolvedItem, ResolvedTextStyle, TextSpanStyle } from '../types';
import { DEFAULT_LINE_HEIGHT } from '../presets/text-styles';
import { BASE_LOOK, SPOKEN_BACKGROUND, tokenLook, tokenPhase, type TokenLook } from '../presets/spoken';
import { backgroundCss, element, n4, px, spanCss } from './css';

export interface TokenNode {
  /** The visible characters of the token, over its room. */
  layer: HTMLElement;
  layerCss: string;
  /** The box behind the token while it is spoken (only with a spoken background). */
  box?: HTMLElement;
  boxCss: string;
}

export interface WordNodes {
  /** Every visible character, in the order of the text (by code point). */
  chars: HTMLElement[];
  /** Static CSS of each character: the look of its span. */
  charCss: string[];
  /** The token a character belongs to; for a character between tokens (gap), the token before it (-1: none). */
  owner: { token: number; gap: boolean }[];
  tokens: TokenNode[];
}

/** For each character, the span that styles it. */
const spansOf = (spans: readonly TextSpanStyle[] | undefined, count: number): (TextSpanStyle | undefined)[] => {
  const out = new Array<TextSpanStyle | undefined>(count).fill(undefined);
  for (const sp of spans ?? []) for (let i = Math.max(0, sp.from); i < Math.min(count, sp.to); i++) out[i] = sp;
  return out;
};

const charCssOf = (span: TextSpanStyle | undefined, i: number, count: number, size: number): string =>
  spanCss(span) + (span?.background ? backgroundCss(span.background, size, i === span.from, i === Math.min(span.to, count) - 1) : '');

interface Builder { doc: Document; chars: string[]; spans: (TextSpanStyle | undefined)[]; s: ResolvedTextStyle; size: number; out: WordNodes }

const addChar = (b: Builder, i: number, parent: HTMLElement, owner: { token: number; gap: boolean }): void => {
  const css = charCssOf(b.spans[i], i, b.chars.length, b.size);
  const el = element(b.doc, 'span', css, parent);
  el.textContent = b.chars[i] ?? '';
  b.out.chars.push(el);
  b.out.charCss.push(css);
  b.out.owner.push(owner);
};

/** The spoken box: around the token's room by padding, centred on its line, outside the flow. */
const boxCss = (b: Builder): string => {
  const bg = b.s.spoken?.background;
  if (!bg) return '';
  const pad = (bg.padding ?? SPOKEN_BACKGROUND.padding) * b.size;
  const v = ((b.s.lineHeight ?? DEFAULT_LINE_HEIGHT) - 1.1) / 2 * b.size - pad;
  return 'position:absolute;left:' + px(-pad) + ';right:' + px(-pad) + ';top:' + px(v) + ';bottom:' + px(v) + ';z-index:0;transform-origin:50% 50%;background:' + bg.color +
    ';border-radius:' + px((bg.radius ?? SPOKEN_BACKGROUND.radius) * b.size) + ';';
};

const LAYER_CSS = 'position:absolute;left:0;top:0;width:100%;height:100%;text-align:center;white-space:pre;transform-origin:50% 50%;';

const addToken = (b: Builder, k: number, from: number, to: number, run: HTMLElement): void => {
  const wrap = element(b.doc, 'span', 'display:inline-block;position:relative;white-space:nowrap;', run);
  const room = element(b.doc, 'span', 'visibility:hidden;', wrap);
  const heavy = b.s.spoken?.weight;
  for (let i = from; i < to; i++) {
    const own = b.spans[i]?.weight ?? b.s.weight;
    const el = element(b.doc, 'span', charCssOf(b.spans[i], i, b.chars.length, b.size) + (heavy && heavy > own ? 'font-weight:' + heavy + ';' : ''), room);
    el.textContent = b.chars[i] ?? '';
  }
  const css = boxCss(b);
  const box = css ? element(b.doc, 'span', css + 'display:none;', wrap) : undefined;
  const layer = element(b.doc, 'span', LAYER_CSS + 'z-index:1;', wrap);
  layer.dataset.glyphs = '1';
  for (let i = from; i < to; i++) addChar(b, i, layer, { token: k, gap: false });
  b.out.tokens.push({ layer, layerCss: LAYER_CSS, ...(box ? { box } : {}), boxCss: css });
};

/** The characters of item.text inside run: tokens as rooms with layers, the text between them above the spoken box. */
export const buildWords = (doc: Document, item: ResolvedItem, s: ResolvedTextStyle, size: number, run: HTMLElement): WordNodes => {
  const chars = Array.from(item.text ?? '');
  const words = item.words ?? [];
  const b: Builder = { doc, chars, spans: spansOf(s.spans, chars.length), s, size, out: { chars: [], charCss: [], owner: [], tokens: [] } };
  let p = 0;
  let k = 0;
  while (p < chars.length) {
    const w = words[k];
    if (w && p >= w.from) {
      addToken(b, k, w.from, Math.max(w.from, Math.min(w.to, chars.length)), run);
      p = Math.max(p, w.to);
      k++;
      continue;
    }
    const end = Math.min(chars.length, w ? w.from : chars.length);
    const gap = element(doc, 'span', 'position:relative;z-index:1;', run);
    for (let i = p; i < end; i++) addChar(b, i, gap, { token: k - 1, gap: true });
    p = end;
  }
  return b.out;
};

const lookCss = (l: TokenLook | undefined): string =>
  !l ? '' : (l.color ? 'color:' + l.color + ';' : '') + (l.weight ? 'font-weight:' + l.weight + ';' : '') + (l.opacity !== undefined ? 'opacity:' + n4(l.opacity) + ';' : '');

/**
 * The look of every token at frame n (presets/spoken.ts) and the first shown characters. A character between tokens
 * takes the "past" look of the token before it once that token is past, and the base look otherwise.
 */
export const applyWords = (w: WordNodes, item: ResolvedItem, n: number, shown: number): void => {
  const words = item.words ?? [];
  const phases = words.map((x) => tokenPhase(x, n));
  const looks = phases.map((ph) => tokenLook(item.style?.spoken, ph));
  w.tokens.forEach((t, k) => {
    const look = looks[k] ?? BASE_LOOK;
    const transform = 'transform:' + (look.scale !== 1 ? 'scale(' + n4(look.scale) + ')' : 'none') + ';';
    t.layer.style.cssText = t.layerCss + 'z-index:' + (phases[k] === 'spoken' ? 2 : 1) + ';' + transform;
    if (t.box) t.box.style.cssText = t.boxCss + 'display:' + (look.background ? 'block' : 'none') + ';' + transform;
  });
  w.chars.forEach((c, i) => {
    const o = w.owner[i] ?? { token: -1, gap: true };
    const look = o.token < 0 ? undefined : o.gap ? (phases[o.token] === 'past' ? looks[o.token] : undefined) : looks[o.token];
    c.style.cssText = (w.charCss[i] ?? '') + lookCss(look) + 'visibility:' + (i < shown ? 'visible' : 'hidden') + ';';
  });
};
