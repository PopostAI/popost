import { describe, expect, it } from 'vitest';
import { applyOp } from './edits';
import { createIdSource } from './ids';
import {
  deletePageOp,
  detectPages,
  duplicatePageOp,
  isPageRoot,
  movePageOp,
  newPageKey,
  pageOf,
  pageRoots,
  blockKind,
  pageSize,
  ratioSize,
  selectableBlocks,
  selectableKind,
} from './pages';
import { findByTag, getAttr, parseIndex } from './source';
import { DECK, makeCtx, session } from './test-fixtures';

const idx = (src: string) => parseIndex(src, createIdSource());
const slides = (n: number): string => Array.from({ length: n }, (_, i) => `<div class="slide" data-popost-page="p-${i}" data-popost-name="N${i}"></div>`).join('\n');

describe('ratioSize', () => {
  it('maps the ratio parameter', () => {
    expect(ratioSize('1:1')).toEqual({ width: 1080, height: 1080 });
    expect(ratioSize('3:4')).toEqual({ width: 1080, height: 1440 });
    expect(ratioSize('9:16')).toEqual({ width: 1080, height: 1920 });
    expect(ratioSize('4:5')).toEqual({ width: 1080, height: 1350 });
    expect(ratioSize('whatever')).toEqual({ width: 1080, height: 1350 });
    expect(ratioSize(' 1:1 ')).toEqual({ width: 1080, height: 1080 });
    expect(ratioSize('')).toEqual({ width: 1280, height: 720 });
    expect(ratioSize(null)).toEqual({ width: 1280, height: 720 });
    expect(ratioSize(undefined)).toEqual({ width: 1280, height: 720 });
  });
});

describe('detectPages', () => {
  it('lists top-level .slide elements in document order', () => {
    const pages = detectPages(idx(DECK));
    expect(pages).toEqual([
      { id: expect.any(String), pageKey: 'p-aaaaaaaaaaaa', name: 'Cover', width: 1080, height: 1350 },
      { id: expect.any(String), pageKey: 'p-bbbbbbbbbbbb', name: 'Details', width: 1080, height: 1350 },
    ]);
  });

  it('ignores slides nested in another slide, in templates, and non-.slide classes', () => {
    const i = idx('<div class="slide" id="o"><div class="slide">inner</div></div><div class="slides"></div><template><div class="slide"></div></template><div class="x slide y"></div>');
    expect(pageRoots(i).map((e) => e.attrs.find((a) => a.name === 'id')?.value)).toEqual(['o', undefined]);
    expect(detectPages(i)).toHaveLength(2);
  });

  it('finds slides under wrappers in document order', () => {
    const i = idx('<main><section><div class="slide" id="a"></div></section></main><div class="slide" id="b"></div>');
    expect(pageRoots(i).map((e) => getAttr(e, 'id'))).toEqual(['a', 'b']);
  });

  it('names pages by data-popost-name or "Page n"', () => {
    const i = idx('<div class="slide"></div><div class="slide" data-popost-name=""></div><div class="slide" data-popost-name="Hello"></div>');
    expect(detectPages(i).map((p) => p.name)).toEqual(['Page 1', 'Page 2', 'Hello']);
    expect(detectPages(i).map((p) => p.pageKey)).toEqual([null, null, null]);
  });

  it('sizes pages from data attributes, then inline style, then the ratio table', () => {
    const i = idx(
      [
        '<div class="slide" data-popost-width="800" data-popost-height="600" style="width:1px;height:2px"></div>',
        '<div class="slide" style="position:relative; width: 1000px; height:500.5px"></div>',
        '<div class="slide" style="width:50%;height:auto"></div>',
        '<div class="slide"></div>',
        '<div class="slide" data-popost-width="abc" data-popost-height="-5"></div>',
        '<div class="slide" style="max-width:10px; width:20px !important; width:30px"></div>',
      ].join(''),
    );
    expect(detectPages(i).map((p) => [p.width, p.height])).toEqual([
      [800, 600],
      [1000, 500.5],
      [1280, 720],
      [1280, 720],
      [1280, 720],
      [30, 720],
    ]);
    expect(detectPages(i, { ratio: '9:16' }).map((p) => [p.width, p.height]).slice(2, 4)).toEqual([
      [1080, 1920],
      [1080, 1920],
    ]);
    expect(pageSize(findByTag(i, 'div')[0], '1:1')).toEqual({ width: 800, height: 600 });
  });

  it('returns no pages for a document without slides', () => {
    expect(detectPages(idx('<p>x</p>'))).toEqual([]);
    expect(detectPages(idx(''))).toEqual([]);
  });

  it('knows which elements are pages and which page contains an element', () => {
    const i = idx(DECK);
    const [first] = pageRoots(i);
    const h1 = findByTag(i, 'h1')[0];
    expect(isPageRoot(i, first.id)).toBe(true);
    expect(isPageRoot(i, h1.id)).toBe(false);
    expect(pageOf(i, h1.id)).toBe(first.id);
    expect(pageOf(i, first.id)).toBe(first.id);
    expect(pageOf(i, i.body!)).toBeNull();
  });
});

describe('page keys', () => {
  it('generates p- plus 12 lowercase hex characters', () => {
    for (let k = 0; k < 20; k++) expect(newPageKey()).toMatch(/^p-[0-9a-f]{12}$/);
    expect(newPageKey(() => 'abcdefabcdef')).toBe('p-abcdefabcdef');
    expect(newPageKey()).not.toBe(newPageKey());
  });
});

describe('page operations', () => {
  const keys = (s: ReturnType<typeof session>): Array<string | null> => detectPages(s.index).map((p) => p.pageKey);

  it('duplicates through the duplicate op', () => {
    const s = session(slides(2));
    const [a] = detectPages(s.index);
    const r = s.apply(duplicatePageOp(a.id));
    expect(detectPages(s.index)).toHaveLength(3);
    expect(detectPages(s.index)[1].id).toBe(r.createdId);
  });

  it('never deletes the last page', () => {
    const s = session(slides(2));
    const [a, b] = detectPages(s.index);
    expect(deletePageOp(s.index, 'nope')).toBeNull();
    expect(deletePageOp(s.index, s.index.body!)).toBeNull();
    const op = deletePageOp(s.index, a.id)!;
    expect(op).toEqual({ kind: 'remove', id: a.id });
    s.apply(op);
    expect(keys(s)).toEqual(['p-1']);
    expect(deletePageOp(s.index, b.id)).toBeNull();
    expect(deletePageOp(idx('<p>x</p>'), 'x')).toBeNull();
  });

  const orderAfter = (n: number, from: number, to: number): Array<string | null> => {
    const s = session(slides(n));
    const pages = detectPages(s.index);
    const op = movePageOp(s.index, pages[from].id, to);
    if (op) applyOp(s.index, op, makeCtx(900)); // must be valid
    if (op) s.apply(op);
    return keys(s);
  };

  it('moves pages to any position', () => {
    expect(orderAfter(3, 0, 1)).toEqual(['p-1', 'p-0', 'p-2']);
    expect(orderAfter(3, 0, 2)).toEqual(['p-1', 'p-2', 'p-0']);
    expect(orderAfter(3, 2, 0)).toEqual(['p-2', 'p-0', 'p-1']);
    expect(orderAfter(3, 1, 0)).toEqual(['p-1', 'p-0', 'p-2']);
    expect(orderAfter(3, 1, 2)).toEqual(['p-0', 'p-2', 'p-1']);
    expect(orderAfter(4, 0, 3)).toEqual(['p-1', 'p-2', 'p-3', 'p-0']);
    expect(orderAfter(4, 3, 1)).toEqual(['p-0', 'p-3', 'p-1', 'p-2']);
  });

  it('clamps the target and reports no-ops as null', () => {
    expect(orderAfter(3, 0, 99)).toEqual(['p-1', 'p-2', 'p-0']);
    expect(orderAfter(3, 2, -5)).toEqual(['p-2', 'p-0', 'p-1']);
    const s = session(slides(3));
    const pages = detectPages(s.index);
    expect(movePageOp(s.index, pages[1].id, 1)).toBeNull();
    expect(movePageOp(s.index, pages[2].id, 7)).toBeNull();
    expect(movePageOp(s.index, 'nope', 0)).toBeNull();
    expect(movePageOp(idx('<p>x</p>'), 'x', 0)).toBeNull();
  });

  it('moves among pages that live in different wrappers', () => {
    const s = session('<main><div class="slide" id="a"></div></main>\n<footer><div class="slide" id="b"></div></footer>');
    const [a, b] = detectPages(s.index);
    s.apply(movePageOp(s.index, a.id, 1)!);
    expect(detectPages(s.index).map((p) => p.id)).toEqual([b.id, a.id]);
    expect(s.index.elements.get(a.id)!.parent).toBe(s.byTag('footer').id);
  });

  it('moves the first page to the end when pages are separated by other elements', () => {
    const s = session('<div class="slide" id="a"></div><hr><div class="slide" id="b"></div><hr>');
    const [a] = detectPages(s.index);
    s.apply(movePageOp(s.index, a.id, 1)!);
    expect(detectPages(s.index).map((p) => getAttr(s.index.elements.get(p.id)!, 'id'))).toEqual(['b', 'a']);
  });

  it('drives the realistic deck', () => {
    const s = session(DECK);
    const [a, b] = detectPages(s.index);
    s.apply(movePageOp(s.index, b.id, 0)!);
    expect(detectPages(s.index).map((p) => p.name)).toEqual(['Details', 'Cover']);
    s.apply(duplicatePageOp(a.id));
    expect(detectPages(s.index)).toHaveLength(3);
    s.apply(deletePageOp(s.index, b.id)!);
    expect(detectPages(s.index)).toHaveLength(2);
  });
});

describe('selectableBlocks / blockKind', () => {
  /** Selected elements as `tag:kind`, in document order. */
  const picks = (body: string, pageId?: string): string[] => {
    const index = idx(`<div class="slide">${body}</div>`);
    return selectableBlocks(index, pageId).map((id) => `${index.elements.get(id)!.tag}:${blockKind(index, id)}`);
  };

  it('selects layers, text tags and media; never the page root', () => {
    expect(picks('<div data-layer-id="g"></div><h1>a</h1><h6>b</h6><p>c</p><ul><li>d</li></ul><blockquote>e</blockquote><figure><img src=x><figcaption>f</figcaption></figure>')).toEqual([
      'div:box', 'h1:text', 'h6:text', 'p:text', 'li:text', 'blockquote:text', 'img:image', 'figcaption:text',
    ]);
    expect(picks('<picture><source><img src=x></picture><svg width=1></svg><video src=x></video>')).toEqual(['picture:image', 'svg:svg', 'video:video']);
  });

  it('selects elements with an inline background image or gradient', () => {
    expect(picks('<div style="background:url(a.png)"></div><div style="background-image:linear-gradient(red,blue)"></div><div style="background:#fff"></div><div style="background-image:none"></div>')).toEqual(['div:box', 'div:box']);
    expect(picks('<div style="background-image:url(a.png);background:red"></div><div style="background:red;background-image:url(a.png)"></div>')).toEqual(['div:box']);
  });

  it('treats elements with direct text as text containers, but not inside text blocks', () => {
    expect(picks('<p>Hello <strong>you</strong></p>')).toEqual(['p:text']);
    expect(picks('<div data-layer-id="t"><span data-slot>Text</span></div>')).toEqual(['div:box', 'span:text']);
    expect(picks('<div>Hi<span>x</span></div>')).toEqual(['div:text']);
    expect(picks('<div><div>a<b>b</b></div></div>')).toEqual(['div:text']);
    expect(picks('<div>a<div>b<span>c</span></div></div>')).toEqual(['div:text']);
    expect(picks('<li><span>x</span></li>')).toEqual(['li:text']);
  });

  it('ignores whitespace, nbsp, comments and stray tags as text', () => {
    expect(picks('<div> \n <span>a</span> </div>')).toEqual(['span:text']);
    expect(picks('<div>&nbsp;<!-- c --> <b>x</b></div>')).toEqual(['b:text']);
    expect(picks('<div data-layer-id="a">&nbsp;</div>')).toEqual(['div:box']);
  });

  it('excludes .notes, style, script, template, noscript and descendants of svg/picture/video', () => {
    expect(picks('<div class="notes"><p>n</p></div><style>p{}</style><script>x</script><template><p>t</p></template><noscript><p>n</p></noscript>')).toEqual([]);
    expect(picks('<svg data-layer-id="s"><text>t</text><g data-layer-id="g"></g></svg><video><track></video><picture><img src=x></picture>')).toEqual(['svg:svg', 'video:video', 'picture:image']);
    expect(picks('<div class="notes"><div data-layer-id="a"></div></div>')).toEqual([]);
  });

  it('only looks inside page roots, in document order, optionally for one page', () => {
    const index = idx('<p>out</p><div class="slide"><p>a</p><div class="slide"><p>nested</p></div></div><div class="slide"><h1>b</h1></div>');
    const [one, two] = pageRoots(index);
    const tags = (ids: string[]) => ids.map((id) => index.elements.get(id)!.tag);
    expect(tags(selectableBlocks(index))).toEqual(['p', 'p', 'h1']);
    expect(tags(selectableBlocks(index, one.id))).toEqual(['p', 'p']);
    expect(selectableBlocks(index, two.id)).toHaveLength(1);
    expect(selectableBlocks(index, 'nope')).toEqual([]);
  });

  it('agrees with the per-element query on every fixture', () => {
    for (const src of [DECK, '<div class="slide"><div>a<p>b</p></div><svg><circle></circle></svg><div style="background:url(x)"></div></div>']) {
      const index = idx(src);
      const all = new Set(selectableBlocks(index));
      for (const id of index.order) expect(selectableKind(index, id) !== null, id).toBe(all.has(id));
    }
  });

  it('blockKind covers non-selectable elements too', () => {
    const index = idx('<div class="slide"><div id=a>text</div><div id=b></div></div>');
    const [, a, b] = findByTag(index, 'div');
    expect([blockKind(index, a.id), blockKind(index, b.id), blockKind(index, 'nope')]).toEqual(['text', 'box', 'box']);
  });

  it('is fast on a large page', () => {
    const body = Array.from({ length: 5000 }, (_, i) => `<div data-layer-id="l${i}"><p>t${i} <b>x</b></p></div>`).join('');
    const index = idx(`<div class="slide">${body}</div>`);
    const t = performance.now();
    expect(selectableBlocks(index)).toHaveLength(10000);
    expect(performance.now() - t).toBeLessThan(500);
  });
});
