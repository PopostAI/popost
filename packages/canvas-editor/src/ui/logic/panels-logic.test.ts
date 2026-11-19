import { describe, expect, it } from 'vitest';
import { applyOp } from '../../core/edits';
import { selectableBlocks } from '../../core/pages';
import { parseIndex } from '../../core/source';
import { borderProps, boxProps, radiusProps, shadowPresetId, SHADOW_PRESETS } from './block-style';
import { maskLongData } from './code-mask';
import { extractDocColors, isTransparentColor, PRESET_COLORS, toHex } from './colors';
import { cropFitOf, dragPosition, drawnSize, formatObjectPosition, parseObjectPosition } from './crop';
import { activeFromStyles, alignOf, firstFamily, letterSpacingEm, lineHeightRatio, opacityOf } from './format-state';
import { blobToDataURL, checkImageBlob, docImages, ImageLoadError, normalizeImageUrl, urlToDataURL } from './images';
import { chooseInsertPosition, newBlockHTML } from './insert';
import { buildLayerRows, layerMoveOp, movedIndex } from './layers';
import { pasteStyleOps, pickCopiedStyle, STYLE_COPY_PROPS } from './style-copy';

const PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const DOC = `<!doctype html><html><head><style>.slide{background:#fff}.x{color:#FF7A1A}</style><style data-popost-font="f">a{color:#123456}</style></head><body>
<section class="slide" style="width:1080px;height:1350px;background:#ffffff">
<h1 id="h" style="color:#ff7a1a">Title</h1>
<div id="wrap"><p id="p1" style="color:rgb(10, 20, 30)">One</p><p id="p2">Two</p><p id="p3" style="color:rgba(0,0,0,0.5)">Three</p></div>
<img id="im" src="data:image/png;base64,${PX}" alt="Logo">
<img id="im2" src="data:image/png;base64,${PX}">
<img id="im3" src="https://x.test/a/b%20c.png?x=1" style="color:#abc">
</section><section class="slide" style="width:1080px;height:1350px"><p>Second</p></section></body></html>`;
const idx = parseIndex(DOC);
const byAttr = (i: typeof idx, id: string) => [...i.elements.values()].find((e) => e.attrs.some((a) => a.name === 'id' && a.value === id))!.id;

describe('colours', () => {
  it('distinguishes missing and fully transparent backgrounds from visible colors', () => {
    for (const value of [undefined, '', 'transparent', 'rgba(21, 23, 26, 0)', 'color(display-p3 0 0 0 / 0)']) {
      expect(isTransparentColor(value)).toBe(true);
    }
    for (const value of ['rgb(0, 0, 0)', 'rgba(0, 0, 0, 0.1)', 'color(display-p3 0 0 0 / 0.1)']) {
      expect(isTransparentColor(value)).toBe(false);
    }
  });
  it('normalises opaque colours only', () => {
    expect(toHex('#ABC')).toBe('#aabbcc');
    expect(toHex('rgb(255, 122, 26)')).toBe('#ff7a1a');
    expect(toHex('rgba(0,0,0,1)')).toBe('#000000');
    expect(toHex('rgba(0,0,0,0.5)')).toBeNull();
    expect(toHex('#11223380')).toBeNull();
    expect(toHex('#112233ff')).toBe('#112233');
    expect(toHex('red')).toBeNull();
    expect(toHex(undefined)).toBeNull();
  });

  it('has 28 distinct presets', () => {
    expect(PRESET_COLORS).toHaveLength(28);
    expect(new Set(PRESET_COLORS).size).toBe(28);
  });

  it('extracts document colours by frequency, skipping font styles and translucent colours', () => {
    const colors = extractDocColors(DOC);
    expect(colors.slice(0, 2).sort()).toEqual(['#ff7a1a', '#ffffff']); // both used twice
    expect(colors).toContain('#ffffff');
    expect(colors).toContain('#0a141e');
    expect(colors).toContain('#aabbcc');
    expect(colors).not.toContain('#123456');
    expect(colors).not.toContain('#000000');
    expect(extractDocColors(DOC, 2)).toHaveLength(2);
  });

  it('ignores colours inside data URIs', () => {
    const long = `data:image/png;note=#ff0000;${'x'.repeat(100)}`;
    expect(extractDocColors(`<p style="background:url(${long})">`)).toEqual([]);
  });
});

describe('copy / paste style', () => {
  it('keeps only copy-set props with values and pastes one op per target', () => {
    const picked = pickCopiedStyle({ color: 'rgb(1, 2, 3)', 'font-size': '20px', width: '5px', opacity: '', 'text-align': 'center' });
    expect(picked).toEqual({ color: 'rgb(1, 2, 3)', 'font-size': '20px', 'text-align': 'center' });
    expect(STYLE_COPY_PROPS).toContain('letter-spacing');
    const ops = pasteStyleOps(['n1', 'n2'], picked);
    expect(ops).toEqual([
      { kind: 'setStyle', id: 'n1', props: picked },
      { kind: 'setStyle', id: 'n2', props: picked },
    ]);
    expect(pasteStyleOps(['n1'], {})).toEqual([]);
  });
});

describe('crop math', () => {
  it('parses and formats object-position', () => {
    expect(parseObjectPosition('50% 20%')).toEqual({ x: 0.5, y: 0.2 });
    expect(parseObjectPosition('left top')).toEqual({ x: 0, y: 0 });
    expect(parseObjectPosition('bottom')).toEqual({ x: 0.5, y: 1 });
    expect(parseObjectPosition('10px 4px')).toEqual({ x: 0.5, y: 0.5 });
    expect(parseObjectPosition('')).toEqual({ x: 0.5, y: 0.5 });
    expect(formatObjectPosition({ x: 0.123, y: 1 })).toBe('12.3% 100%');
  });

  it('draws cover larger and contain smaller than the box', () => {
    const natural = { width: 400, height: 200 };
    const box = { width: 100, height: 100 };
    expect(drawnSize(natural, box, 'cover')).toEqual({ width: 200, height: 100 });
    expect(drawnSize(natural, box, 'contain')).toEqual({ width: 100, height: 50 });
  });

  it('dragging right moves the visible area left (position decreases) with slack of 100px', () => {
    const args = { natural: { width: 400, height: 200 }, box: { width: 100, height: 100 }, fit: 'cover' as const, start: { x: 0.5, y: 0.5 } };
    // drawn 200x100: x slack = -100; dragging +25px -> offset +25 -> p = 0.5 - 0.25
    expect(dragPosition({ ...args, dx: 25, dy: 40 })).toEqual({ x: 0.25, y: 0.5 });
    expect(dragPosition({ ...args, dx: -500, dy: 0 }).x).toBe(1);
    expect(dragPosition({ ...args, dx: 500, dy: 0 }).x).toBe(0);
  });

  it('works for contain (positive slack) and ignores invalid sizes', () => {
    const args = { natural: { width: 400, height: 200 }, box: { width: 100, height: 100 }, fit: 'contain' as const, start: { x: 0.5, y: 0.5 } };
    // drawn 100x50: y slack = 50; dragging +10px down -> p = 0.5 + 0.2
    expect(dragPosition({ ...args, dx: 30, dy: 10 })).toEqual({ x: 0.5, y: 0.7 });
    expect(dragPosition({ ...args, natural: { width: 0, height: 0 }, dx: 5, dy: 5 })).toEqual(args.start);
  });

  it('maps object-fit to a crop mode', () => {
    expect(cropFitOf('cover')).toBe('cover');
    expect(cropFitOf('fill')).toBeNull();
  });
});

describe('insert position', () => {
  it('goes after the last selected block in document order', () => {
    const p1 = byAttr(idx, 'p1');
    const p2 = byAttr(idx, 'p2');
    const wrap = byAttr(idx, 'wrap');
    const page = idx.elements.get(wrap)!.parent!;
    expect(chooseInsertPosition(idx, [p1], page)).toEqual({ parentId: wrap, beforeId: p2 });
    expect(chooseInsertPosition(idx, [p2, p1], page)).toEqual({ parentId: wrap, beforeId: byAttr(idx, 'p3') });
    expect(chooseInsertPosition(idx, [byAttr(idx, 'p3')], page)).toEqual({ parentId: wrap, beforeId: null });
  });

  it('appends to the page root without a selection and rejects a missing page', () => {
    const page = idx.elements.get(byAttr(idx, 'wrap'))!.parent!;
    expect(chooseInsertPosition(idx, [], page)).toEqual({ parentId: page, beforeId: null });
    expect(chooseInsertPosition(idx, ['gone'], page)).toEqual({ parentId: page, beforeId: null });
    expect(chooseInsertPosition(idx, [], null)).toBeNull();
  });

  it('builds escaped, page-scaled blocks that become selectable text', () => {
    const html = newBlockHTML('heading', 1080, 'A <b> & B');
    expect(html).toBe('<h1 style="position:absolute;z-index:100;left:76px;top:76px;max-width:928px;margin:0;color:#222222;font-size:76px;font-weight:700;line-height:1.15">A &lt;b&gt; &amp; B</h1>');
    const page = idx.elements.get(byAttr(idx, 'wrap'))!.parent!;
    const r = applyOp(idx, { kind: 'insertHTML', parentId: page, beforeId: null, html: newBlockHTML('paragraph', 1080, 'Hello') }, { newId: (() => { let n = 900; return () => `n${n++}`; })() });
    expect(selectableBlocks(r.index, page)).toContain(r.createdId);
    expect(newBlockHTML('subheading', 1000, 'x')).toContain('<h2 ');
  });
});

describe('layers', () => {
  const page = idx.elements.get(byAttr(idx, 'wrap'))!.parent!;
  it('builds rows with kind, snippet and depth', () => {
    const rows = buildLayerRows(idx, page);
    const by = (id: string) => rows.find((r) => r.id === byAttr(idx, id))!;
    expect(by('h')).toMatchObject({ kind: 'text', snippet: 'Title', depth: 0 });
    expect(by('im')).toMatchObject({ kind: 'image', snippet: 'Logo' });
    expect(by('im2')).toMatchObject({ kind: 'image', snippet: '' });
    expect(by('im3').snippet).toBe('b c.png');
    expect(by('p1').parentId).toBe(byAttr(idx, 'wrap'));
    expect(rows.every((r) => r.depth === 0)).toBe(true); // the wrapper div is not selectable
    expect(buildLayerRows(idx, null)).toEqual([]);
  });

  it('moves among siblings only', () => {
    const [p1, p2, p3, h] = ['p1', 'p2', 'p3', 'h'].map((i) => byAttr(idx, i)) as [string, string, string, string];
    const wrap = byAttr(idx, 'wrap');
    expect(layerMoveOp(idx, p1, p3, 'after')).toEqual({ kind: 'move', id: p1, parentId: wrap, beforeId: null });
    expect(layerMoveOp(idx, p3, p1, 'before')).toEqual({ kind: 'move', id: p3, parentId: wrap, beforeId: p1 });
    expect(layerMoveOp(idx, p1, p2, 'before')).toBeNull(); // already there
    expect(layerMoveOp(idx, p1, p2, 'after')).toEqual({ kind: 'move', id: p1, parentId: wrap, beforeId: p3 });
    expect(layerMoveOp(idx, p1, h, 'after')).toBeNull(); // different parent
    expect(layerMoveOp(idx, p1, p1, 'after')).toBeNull();
    expect(movedIndex(idx, p1, p3, 'after')).toBe(2);
    expect(movedIndex(idx, p3, p1, 'before')).toBe(0);
  });
});

describe('code mask', () => {
  it('masks long base64 payloads and restores them, keeping edits', () => {
    const long = 'A'.repeat(4000);
    const src = `<img src="data:image/png;base64,${long}"><style>@font-face{src:url(data:font/woff2;base64,${long}B)}</style><p>x</p>`;
    const m = maskLongData(src);
    expect(m.text.length).toBeLessThan(400);
    expect(m.text).toMatch(/\[\[popost-data-1:/);
    expect(m.restore(m.text)).toBe(src);
    expect(m.restore(m.text.replace('<p>x</p>', '<p>y</p>'))).toBe(src.replace('<p>x</p>', '<p>y</p>'));
    expect(m.restore('[[popost-data-9:1 KB]]')).toBe('[[popost-data-9:1 KB]]');
    expect(maskLongData('<p>short data:image/png;base64,AAAA</p>').text).toBe('<p>short data:image/png;base64,AAAA</p>');
  });
});

describe('format state', () => {
  it('derives toggles, preferring the live text state', () => {
    const s = { 'font-weight': '700', 'font-style': 'italic', 'text-decoration-line': 'underline line-through', 'text-transform': 'uppercase' };
    expect(activeFromStyles(s)).toEqual({ bold: true, italic: true, underline: true, strike: true, uppercase: true });
    expect(activeFromStyles({ 'font-weight': '400', 'text-decoration-line': 'none' })).toMatchObject({ bold: false, underline: false });
    expect(activeFromStyles(s, { bold: false, underline: true })).toMatchObject({ bold: false, italic: false, underline: true, strike: false });
  });

  it('converts computed values', () => {
    const base = { 'font-size': '36px' };
    expect(lineHeightRatio({ ...base, 'line-height': '43.2px' })).toBe(1.2);
    expect(lineHeightRatio({ ...base, 'line-height': '1.5' })).toBe(1.5);
    expect(lineHeightRatio({ ...base, 'line-height': 'normal' })).toBe(1.2);
    expect(letterSpacingEm({ ...base, 'letter-spacing': '1.8px' })).toBe(0.05);
    expect(letterSpacingEm({ ...base, 'letter-spacing': 'normal' })).toBe(0);
    expect(opacityOf({ opacity: '0.4' })).toBe(0.4);
    expect(opacityOf({})).toBe(1);
    expect(alignOf('end')).toBe('right');
    expect(alignOf('start')).toBe('left');
    expect(alignOf('justify')).toBe('justify');
    expect(firstFamily('"Playfair Display", "Noto Sans SC", serif')).toBe('Playfair Display');
    expect(firstFamily(undefined)).toBe('');
  });
});

describe('block style', () => {
  it('clears longhands when writing shorthands', () => {
    expect(boxProps('padding', 24.4)).toMatchObject({ padding: '24px', 'padding-left': null, 'padding-top': null });
    expect(radiusProps(8)).toMatchObject({ 'border-radius': '8px', 'border-top-left-radius': null });
    // the live frame applies props in order: longhands must be cleared before the shorthand is set
    expect(Object.keys(boxProps('margin', 1)).at(-1)).toBe('margin');
    expect(Object.keys(radiusProps(1)).at(-1)).toBe('border-radius');
    expect(borderProps('solid', 0)).toEqual({ 'border-style': 'solid', 'border-width': '1px' });
    expect(borderProps('none', 3)).toEqual({ 'border-style': 'none' });
  });

  it('recognises shadow presets in inline style regardless of spacing', () => {
    expect(shadowPresetId(SHADOW_PRESETS[1].css)).toBe('soft');
    expect(shadowPresetId('0 4px 14px rgba(0, 0, 0, 0.12)')).toBe('soft');
    expect(shadowPresetId('1px 1px red')).toBeNull();
    expect(shadowPresetId(null)).toBeNull();
  });
});

describe('images', () => {
  it('lists distinct img sources of the document', () => {
    const imgs = docImages(idx);
    expect(imgs).toHaveLength(2);
    expect(imgs[0]!.id).toBe(byAttr(idx, 'im'));
    expect(imgs[1]!.src).toContain('x.test');
  });

  it('validates blobs', () => {
    expect(() => checkImageBlob(new Blob(['x'], { type: 'text/plain' }))).toThrow(ImageLoadError);
    expect(() => checkImageBlob(new Blob(['x'], { type: 'image/png' }))).not.toThrow();
  });

  it('normalises typed URLs', () => {
    expect(normalizeImageUrl(' example.com/a.png ')).toBe('https://example.com/a.png');
    expect(normalizeImageUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeImageUrl('')).toBeNull();
    expect(normalizeImageUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
  });

  it('embeds fetched images and reports failures', async () => {
    const ok = (async () => new Response(new Blob(['abc'], { type: 'image/png' }))) as unknown as typeof fetch;
    expect(await urlToDataURL('https://x.test/a.png', ok)).toMatch(/^data:image\/png;base64,/);
    const notImage = (async () => new Response(new Blob(['abc'], { type: 'text/html' }))) as unknown as typeof fetch;
    await expect(urlToDataURL('https://x.test/a', notImage)).rejects.toMatchObject({ reason: 'notImage' });
    const cors = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(urlToDataURL('https://x.test/a.png', cors)).rejects.toMatchObject({ reason: 'fetch' });
    const missing = (async () => new Response('no', { status: 404 })) as unknown as typeof fetch;
    await expect(urlToDataURL('https://x.test/a.png', missing)).rejects.toMatchObject({ reason: 'fetch' });
    expect(await blobToDataURL(new Blob(['a'], { type: 'image/gif' }))).toMatch(/^data:image\/gif/);
  });
});
