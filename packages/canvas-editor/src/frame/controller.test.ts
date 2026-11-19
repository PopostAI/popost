import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createIdSource } from '../core/ids';
import { pageRoots } from '../core/pages';
import { parseIndex } from '../core/source';
import type { FrameToShell } from '../contracts';
import { createFrameController, FRAME_CSS } from './index';
import { randomNonce } from './controller';
import { resetDoc, el } from './test-dom';

const SOURCE = `<!doctype html><html><head><title>t</title></head><body>
<section class="slide" data-popost-width="1080"><p>One</p></section>
<section class="slide"><p>Two</p></section></body></html>`;
const index = () => parseIndex(SOURCE, createIdSource());

/** Minimal iframe stand-in: `src` assignment loads `doc` asynchronously. */
function fakeIframe(doc: Document | null, hold = false) {
  const target = new EventTarget();
  const f = Object.assign(target, {
    contentDocument: doc,
    srcs: [] as string[],
    fire: () => target.dispatchEvent(new Event('load')),
  });
  Object.defineProperty(f, 'src', {
    set(v: string) {
      f.srcs.push(v);
      if (!hold) queueMicrotask(() => target.dispatchEvent(new Event('load')));
    },
  });
  return f as unknown as HTMLIFrameElement & { srcs: string[]; fire: () => void };
}

describe('createFrameController.mount', () => {
  beforeEach(() => (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL('http://localhost/frame'));

  it('builds the preview, loads it, then emits ready and fontsReady + rects', async () => {
    resetDoc(`<section class="slide" data-pp-id="n1"><p data-pp-id="n2" data-pp-sel="text">x</p></section><section class="slide" data-pp-id="n3"></section>`);
    const idx = index();
    const preview = vi.fn(async (html: string) => `blob:${html.includes('data-pp-frame') ? 'ok' : 'bad'}`);
    const c = createFrameController({ store: { preview }, baseHref: '/pages/', nonce: () => 'a'.repeat(32) });
    const events: FrameToShell[] = [];
    c.on((m) => events.push(m));
    const iframe = fakeIframe(document);
    await c.mount(iframe, idx, { currentPageId: null });
    expect(preview).toHaveBeenCalledOnce();
    expect(preview.mock.calls[0][0]).toContain(FRAME_CSS);
    expect(preview.mock.calls[0][0]).toContain('<base href="/pages/">');
    expect((preview.mock.calls[0] as unknown[])[1]).toBe('a'.repeat(32));
    expect(iframe.srcs).toEqual(['blob:ok']);
    expect(events[0]).toEqual({ type: 'ready', pages: expect.any(Array) });
    expect((events[0] as { pages: string[] }).pages).toHaveLength(2);
    await vi.waitFor(() => expect(events.map((e) => e.type)).toEqual(['ready', 'fontsReady', 'rects']));
    c.dispose();
  });

  it('passes the host image origins into the preview CSP', async () => {
    resetDoc(`<section class="slide" data-pp-id="n1"></section>`);
    const preview = vi.fn(async () => 'blob:x');
    const c = createFrameController({ store: { preview }, baseHref: 'https://app.example/', imageOrigins: ['https://img.example.com'] });
    await c.mount(fakeIframe(document), index(), { currentPageId: null });
    expect((preview.mock.calls[0] as unknown[])[0]).toContain("img-src data: blob: 'self' https://img.example.com;");
    c.dispose();
  });

  it('throws a clear error when the frame document is not accessible', async () => {
    const c = createFrameController({ store: { preview: async () => 'blob:x' } });
    await expect(c.mount(fakeIframe(null), index(), { currentPageId: null })).rejects.toThrow(/same-origin/);
  });

  it('enables page switching while images keep the document load event pending', async () => {
    const idx = index();
    const ids = pageRoots(idx).map((page) => page.id);
    resetDoc(ids.map((id) => `<section class="slide" data-pp-id="${id}"></section>`).join(''));
    const ready = vi.spyOn(document, 'readyState', 'get').mockReturnValue('interactive');
    const c = createFrameController({ store: { preview: async () => window.location.href } });
    try {
      await c.mount(fakeIframe(document, true), idx, { currentPageId: ids[0]! });
      c.send({ type: 'currentPage', id: ids[1]! });
      expect(el(ids[1]!).classList.contains('ed-cur')).toBe(true);
      expect(el(ids[0]!).classList.contains('ed-cur')).toBe(false);
    } finally {
      c.dispose();
      ready.mockRestore();
    }
  });

  it('a newer mount supersedes a pending one: no double listeners, no stale ready', async () => {
    resetDoc(`<section class="slide" data-pp-id="n1"><p data-pp-id="n2" data-pp-sel="text">x</p></section>`);
    const c = createFrameController({ store: { preview: async (h) => `blob:${h.length}` } });
    const events: FrameToShell[] = [];
    c.on((m) => events.push(m));
    const first = fakeIframe(document, true);
    const p1 = c.mount(first, index(), { currentPageId: null });
    await Promise.resolve();
    await Promise.resolve();
    const second = fakeIframe(document);
    const p2 = c.mount(second, index(), { currentPageId: null });
    await Promise.all([p1, p2]);
    first.fire(); // late load of the stale mount
    expect(events.filter((e) => e.type === 'ready')).toHaveLength(1);
    // exactly one listener set: one pointer event -> one emitted down
    events.length = 0;
    const e = new window.MouseEvent('pointerdown', { bubbles: true, button: 0 });
    Object.defineProperty(e, 'isPrimary', { value: true });
    el('n2').dispatchEvent(e);
    expect(events.filter((m) => m.type === 'pointer')).toHaveLength(1);
    c.dispose();
  });

  it('remounting disposes the previous session listeners', async () => {
    resetDoc(`<section class="slide" data-pp-id="n1"><p data-pp-id="n2" data-pp-sel="text">x</p></section>`);
    const c = createFrameController({ store: { preview: async () => 'blob:x' } });
    const events: FrameToShell[] = [];
    c.on((m) => events.push(m));
    await c.mount(fakeIframe(document), index(), { currentPageId: null });
    await c.mount(fakeIframe(document), index(), { currentPageId: null });
    events.length = 0;
    const e = new window.MouseEvent('pointerdown', { bubbles: true, button: 0 });
    Object.defineProperty(e, 'isPrimary', { value: true });
    el('n2').dispatchEvent(e);
    expect(events.filter((m) => m.type === 'pointer')).toHaveLength(1);
    c.dispose();
  });

  it('is inert before mount and after dispose', () => {
    const c = createFrameController({ store: { preview: async () => 'blob:x' } });
    expect(() => c.send({ type: 'highlight', ids: [] })).not.toThrow();
    expect(c.measure('page')).toEqual({ rects: {}, overflow: [] });
    expect(c.styles('n1', ['color'])).toEqual({});
    c.dispose();
  });

  it('unsubscribes listeners', async () => {
    const c = createFrameController({ store: { preview: async () => 'blob:x' } });
    const l = vi.fn();
    const off = c.on(l);
    off();
    resetDoc(`<section class="slide" data-pp-id="n1"></section>`);
    await c.mount(fakeIframe(document), index(), { currentPageId: null });
    expect(l).not.toHaveBeenCalled();
    c.dispose();
  });
});

describe('randomNonce', () => {
  it('is 32 lowercase hex characters', () => {
    expect(randomNonce()).toMatch(/^[0-9a-f]{32}$/);
    expect(randomNonce()).not.toBe(randomNonce());
  });
});
