/** Shared HTML fixtures and helpers for the core unit tests. */
import type { DocIndex, EditOp, EditResult, ElementInfo, NodeId } from '../contracts';
import type { EditContext } from './edits';
import { applyOp } from './edits';
import { createIdSource } from './ids';
import { parseIndex } from './source';

export const FONT_DATA_URI = 'data:font/woff2;base64,d09GMgABAAAAAAZkAA0AAAAADLQAAAYMAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGhYbHhw=';

/** A realistic two-page deck as produced by the skill: doctype, font-face data URIs, page roots, SVG, comments. */
export const DECK = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>Launch — 发布 😀</title>
  <style>
    @font-face { font-family: "Brand"; src: url(${FONT_DATA_URI}) format("woff2"); }
    .slide { position: relative; overflow: hidden; background: #fff; }
    .title { font: 700 64px/1.2 "Brand", sans-serif; }
  </style>
  <style data-popost-font="brand">/* Brand 1.0 */
@font-face { font-family: "Brand"; src: url(${FONT_DATA_URI}); }</style>
</head>
<body style="margin:0">
  <!-- page one -->
  <section class="slide" data-popost-page="p-aaaaaaaaaaaa" data-popost-name="Cover" data-popost-width="1080" data-popost-height="1350" style="width:1080px; height:1350px">
    <div data-layer-id="bg" style="position:absolute; left:0; top:0; width:1080px; height:1350px; background:linear-gradient(#fff, #eee)"></div>
    <h1 class="title" data-layer-id="title" data-slot="headline" style="position:absolute; left:80px; top:120px; font-size:64px">春季发布 Spring &amp; Launch</h1>
    <p data-layer-id="sub" data-slot="body" style="position:absolute; left:80px; top:260px">Line one<br>Line two</p>
    <img data-layer-id="logo" src="data:image/png;base64,iVBORw0KGgo=" alt="logo" style="position:absolute; left:900px; top:40px; width:120px">
    <svg data-layer-id="mark" width="80" height="80" viewBox="0 0 80 80" style="position:absolute; left:40px; top:1200px">
      <circle cx="40" cy="40" r="30" fill="#f60"/>
      <path d="M10 10 L70 70" stroke="#000"/>
      <text x="10" y="20">hi</text>
    </svg>
  </section>
  <section class="slide" data-popost-page="p-bbbbbbbbbbbb" data-popost-name="Details" data-popost-width="1080" data-popost-height="1350" style="width:1080px; height:1350px">
    <div data-layer-id="card" style="position:absolute; left:100px; top:200px; width:880px; height:400px; background:url('a;b.png')">
      <span data-slot="label">Card</span>
    </div>
    <template><b>never rendered</b></template>
  </section>
</body>
</html>
`;

export const DECK_CRLF = DECK.replace(/\n/g, '\r\n');

/** Awkward but valid documents; every one must survive a parse without changing a byte. */
export const ODD_DOCUMENTS: Record<string, string> = {
  empty: '',
  fragmentOnly: '<div class="slide">x</div>',
  textOnly: 'just text',
  noDoctypeNoHead: '<style>a{}</style>\n<div class="slide">a</div>\n',
  impliedTags: '<p>a<p>b\n<ul><li>1<li>2</ul>',
  table: '<table><tr><td>a<td>b</table>',
  unquoted: '<div class=slide data-x=1 hidden>t</div>',
  singleQuotes: "<div class='slide' title='it\"s'>t</div>",
  duplicateAttrs: '<div a=1 a=2 class="slide">t</div>',
  entitiesInAttrs: '<div title="&quot;q&quot; &amp; &#x41;" class="slide">t</div>',
  comments: '<!-- top --><!doctype html><!-- after --><html><!-- in html --><head></head><body><!-- b --><div class="slide"></div></body></html><!-- end -->',
  svgSelfClosing: '<svg><g><rect width="1" height="1"/><circle r="1"></circle><use xlink:href="#a"/></g></svg>',
  rawText: '<script>if (a<b && c>d) { document.write("</div>") }</script><style>a>b{}</style><textarea><b></textarea><title>a<b</title>',
  noscript: '<noscript><p class="slide">fallback</p></noscript>',
  template: '<template><div class="slide"><span>x</span></div></template><div class="slide">real</div>',
  misnested: '<b>1<p>2</b>3</p>',
  unclosed: '<div><span>never closed',
  bom: '﻿<!doctype html><div>bom</div>',
  nonAscii: '<p title="é">日本語 😀 𝒳 <b>x</b></p>',
  crlfAttrs: '<div\r\n class="slide"\r\n data-a="1">\r\n  <p>x</p>\r\n</div>\r\n',
  selfClosedDiv: '<div/><p>after</p>',
  strayEndTags: '<div></div></div></p></span>',
  crlfDeck: DECK_CRLF,
  deck: DECK,
};

export function makeCtx(start = 1): EditContext {
  const ids = createIdSource(start);
  let n = 0;
  return {
    newId: () => ids.newId(),
    randomHex: (length) => {
      n++;
      return n.toString(16).padStart(length, '0').slice(-length);
    },
  };
}

export interface Session {
  index: DocIndex;
  ctx: EditContext;
  apply(op: EditOp): EditResult;
  /** First element matching the predicate. */
  find(pred: (el: ElementInfo) => boolean): ElementInfo;
  byAttr(name: string, value: string): ElementInfo;
  byTag(tag: string, nth?: number): ElementInfo;
  source(): string;
}

/** A parsed document plus an op applier that keeps the index current. */
export function session(source: string): Session {
  const ctx = makeCtx();
  const state: { index: DocIndex } = { index: parseIndex(source, ctx) };
  const find = (pred: (el: ElementInfo) => boolean): ElementInfo => {
    for (const id of state.index.order) {
      const el = state.index.elements.get(id);
      if (el && pred(el)) return el;
    }
    throw new Error('element not found');
  };
  return {
    get index() {
      return state.index;
    },
    ctx,
    apply(op) {
      const result = applyOp(state.index, op, ctx);
      state.index = result.index;
      return result;
    },
    find,
    byAttr: (name, value) => find((el) => el.attrs.some((a) => a.name === name && a.value === value)),
    byTag: (tag, nth = 0) => {
      let seen = 0;
      return find((el) => el.tag === tag && seen++ === nth);
    },
    source: () => state.index.source,
  };
}

export const idOf = (el: ElementInfo): NodeId => el.id;
