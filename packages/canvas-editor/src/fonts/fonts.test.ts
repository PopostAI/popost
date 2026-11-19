import { describe, expect, it, vi } from 'vitest';
import { buildFontMenu, bytesToBase64, cjkFallbackId, containsCJK, createInlineFontCache, fontFamilyStack, fontUrls, initFontSelect, inlineFontCSS, linkedFontCSS, loadPalette, menuLabel, parsePalette, renderFontSelect, selectFont } from './index';
import type { PaletteRole } from './index';

const role = (id: string, family: string, label: string, group: string, extra: Partial<PaletteRole> = {}): PaletteRole => ({
  id, family, label, group, fallback: 'sans-serif', weights: '400-700', cssPath: `css/${id}.css`, licensePath: `${id}/LICENSE`, package: `@pkg/${id}`, packageVersion: '1.0.0', ...extra,
});

const roles = [
  role('inter', 'Inter Variable', 'Inter', 'Sans'),
  role('lora', 'Lora Variable', 'Lora Serif', 'Serif', { fallback: 'serif' }),
  role('cjk-sans', 'Noto Sans SC Variable', 'Noto Sans SC', 'CJK'),
  role('cjk-sans-tc', 'Noto Sans TC Variable', 'Noto Sans TC', 'CJK'),
  role('x-tc', 'X TC', 'X TC', 'Sans'),
  role('dm', 'DM Sans', 'Other', 'Sans'),
];

describe('menu', () => {
  it('labels: family without Variable when equal to label, else "label · family"', () => {
    expect(menuLabel(roles[0]!)).toBe('Inter');
    expect(menuLabel(roles[1]!)).toBe('Lora Serif · Lora');
  });

  it('groups by role.group in palette order and defaults the group to Fonts', () => {
    const menu = buildFontMenu([...roles, role('nog', 'No Group', 'No Group', '')]);
    expect(menu.map((g) => g.label)).toEqual(['Sans', 'Serif', 'CJK', 'Fonts']);
    expect(menu[0]!.options.map((o) => o.fontId)).toEqual(['inter', 'x-tc', 'dm']);
    expect(menu[0]!.options[0]).toEqual({ label: 'Inter', value: 'Inter Variable', title: 'Sans · 400-700 · OFL-1.1', fontId: 'inter' });
  });

  it('renders optgroups and options with data-font-id', () => {
    const select = document.createElement('select');
    renderFontSelect(select, buildFontMenu(roles));
    expect(select.querySelectorAll('optgroup').length).toBe(3);
    const ids = [...select.querySelectorAll<HTMLOptionElement>('option[data-font-id]')].map((o) => o.dataset.fontId);
    expect(ids).toEqual(roles.filter((r) => r.group === 'Sans').concat(roles.filter((r) => r.group === 'Serif'), roles.filter((r) => r.group === 'CJK')).map((r) => r.id));
    expect(select.querySelector<HTMLOptionElement>('option[data-font-id="lora"]')?.value).toBe('Lora Variable');
  });

  it('initFontSelect shows an error option when the palette fails', async () => {
    const select = document.createElement('select');
    await initFontSelect(select, async () => {
      throw new Error('nope');
    });
    expect(select.options.length).toBe(1);
    expect(select.options[0]!.text).toBe('字体库加载失败');
    expect(select.title).toBe('nope');
    await initFontSelect(select, async () => ({ roles }));
    expect(select.disabled).toBe(false);
    expect(select.options.length).toBe(roles.length);
  });
});

describe('selection', () => {
  it('detects CJK in U+3400..U+9FFF', () => {
    expect(containsCJK('abc')).toBe(false);
    expect(containsCJK('a中')).toBe(true);
    expect(containsCJK('㐀')).toBe(true);
    expect(containsCJK('鿿')).toBe(true);
    expect(containsCJK('ꀀ')).toBe(false);
  });

  it('picks the traditional fallback for -tc roles', () => {
    expect(cjkFallbackId('x-tc')).toBe('cjk-sans-tc');
    expect(cjkFallbackId('inter')).toBe('cjk-sans');
  });

  it('builds the stack with CJK fallback and generic', () => {
    expect(selectFont(roles, 'Lora Variable', '中文').stack).toBe('"Lora Variable", "Noto Sans SC Variable", serif');
    expect(selectFont(roles, 'Lora Variable', 'abc').stack).toBe('"Lora Variable", serif');
    expect(selectFont(roles, 'X TC', '中').needed.map((r) => r.id)).toEqual(['x-tc', 'cjk-sans-tc']);
    expect(selectFont(roles, 'Noto Sans SC Variable', '中').fallback).toBeNull();
    expect(fontFamilyStack({ ...roles[0]!, fallback: '' }, null)).toBe('"Inter Variable", sans-serif');
  });

  it('rejects unknown families', () => {
    expect(() => selectFont(roles, 'Nope', '')).toThrow('该字体不在公共字体库中');
  });
});

describe('palette loading', () => {
  it('parses roles and fails on bad data', async () => {
    expect(parsePalette({ roles }).roles.length).toBe(roles.length);
    expect(() => parsePalette({})).toThrow('公共字体库无法读取');
    const ok = vi.fn(async () => new Response(JSON.stringify({ ok: true, roles })));
    expect((await loadPalette('/p.json', ok as unknown as typeof fetch)).roles.length).toBe(roles.length);
    const bad = vi.fn(async () => new Response('x', { status: 404 }));
    await expect(loadPalette('/p.json', bad as unknown as typeof fetch)).rejects.toThrow('公共字体库无法读取');
  });
});

function fakeLibrary(): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const files: Record<string, Uint8Array | string> = {
    '/fonts/popost/css/inter.css': '@font-face{font-family:"Inter Variable";src:url(../inter/a.woff2) format("woff2")}@font-face{font-family:"Inter Variable";src:url("../inter/a.woff2")}',
    '/fonts/popost/inter/a.woff2': new Uint8Array([0, 1, 2, 250, 255]),
    '/fonts/popost/inter/LICENSE': 'SIL OPEN FONT LICENSE',
  };
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    const body = files[url.pathname];
    return body === undefined ? new Response('', { status: 404 }) : new Response(body as BodyInit);
  };
  return { fetch: impl as typeof fetch, calls };
}

describe('browser embedding', () => {
  const base = new URL('http://h.test/fonts/popost/');

  it('base64-encodes bytes and lists unique urls', () => {
    expect(bytesToBase64(new Uint8Array([0, 1, 2, 250, 255]))).toBe(btoa('\x00\x01\x02\xfa\xff'));
    expect(fontUrls('a{src:url(x.woff2)} b{src:url("x.woff2")} c{src:url( \'y.woff2\' )}')).toEqual(['x.woff2', 'y.woff2']);
  });

  it('produces licence comment + @font-face with data URIs', async () => {
    const lib = fakeLibrary();
    const css = await inlineFontCSS(roles[0]!, base, lib.fetch);
    expect(css.startsWith('/* @pkg/inter@1.0.0\nSIL OPEN FONT LICENSE\n*/\n@font-face')).toBe(true);
    expect(css).toContain('url("data:font/woff2;base64,AAEC+v8=")');
    expect(css).not.toContain('../inter/a.woff2');
    expect(lib.calls.filter((p) => p.endsWith('a.woff2')).length).toBe(1);
  });

  it('links font files by root-relative path in host mode, with the licence comment and no font downloads', async () => {
    const lib = fakeLibrary();
    const css = await linkedFontCSS(roles[0]!, base, lib.fetch);
    expect(css.startsWith('/* @pkg/inter@1.0.0\nSIL OPEN FONT LICENSE\n*/\n@font-face')).toBe(true);
    expect(css).toContain('url("/fonts/popost/inter/a.woff2")');
    expect(css).not.toContain('data:font');
    expect(lib.calls.some((p) => p.endsWith('.woff2'))).toBe(false);
    const linked = createInlineFontCache(base, lib.fetch, linkedFontCSS);
    expect(await linked(roles[0]!)).toBe(css);
  });

  it('reports missing css, font and licence files', async () => {
    const lib = fakeLibrary();
    await expect(inlineFontCSS(roles[1]!, base, lib.fetch)).rejects.toThrow('字体样式缺失：Lora Serif');
  });

  it('caches per role and drops failures', async () => {
    const lib = fakeLibrary();
    const inline = createInlineFontCache(base, lib.fetch);
    const [a, b] = await Promise.all([inline(roles[0]!), inline(roles[0]!)]);
    expect(a).toBe(b);
    const before = lib.calls.length;
    await inline(roles[0]!);
    expect(lib.calls.length).toBe(before);
    await expect(inline(roles[1]!)).rejects.toThrow();
    const failed = lib.calls.length;
    await expect(inline(roles[1]!)).rejects.toThrow();
    expect(lib.calls.length).toBeGreaterThan(failed);
  });
});
