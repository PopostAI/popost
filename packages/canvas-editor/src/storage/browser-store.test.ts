import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocStore } from '../contracts';

type Mod = typeof import('./browser-store');
type Storage = typeof import('./browser-storage');

let store: DocStore;
let storage: Storage;
let mod: Mod;
let post: ReturnType<typeof vi.fn>;

function setParent(value: unknown): void {
  Object.defineProperty(window, 'parent', { value, configurable: true });
}

async function setup(seed: Record<string, unknown>): Promise<void> {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  vi.resetModules();
  storage = await import('./browser-storage');
  mod = await import('./browser-store');
  await storage.initStorage();
  for (const [k, v] of Object.entries(seed)) storage.writeStored(k, v);
  await storage.flushStorage();
  store = mod.createBrowserStore({ file: 'p1.html', name: null });
}

const state = { projects: [{ id: 'p1', name: 'Post One' }] };

beforeEach(() => {
  post = vi.fn();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  setParent(window);
  vi.useRealTimers();
});

describe('load', () => {
  it('returns the deck with rev 1 before any save', async () => {
    await setup({ state, decks: { p1: '<html>A</html>' } });
    expect(await store.load()).toEqual({ content: '<html>A</html>', rev: '1', name: 'Post One', path: 'p1.html' });
  });

  it('refreshes state and decks written by another window and uses revs[id]', async () => {
    await setup({ state, decks: { p1: 'old' }, revs: { p1: '77' } });
    const other = await (async () => {
      vi.resetModules();
      return import('./browser-storage');
    })();
    await other.initStorage();
    other.writeStored('decks', { p1: 'new' });
    await other.flushStorage();
    const loaded = await store.load();
    expect(loaded.content).toBe('new');
    expect(loaded.rev).toBe('77');
  });

  it('throws for unknown projects and missing content', async () => {
    await setup({ state: { projects: [] }, decks: {} });
    await expect(store.load()).rejects.toThrow('Project not found');
    await setup({ state, decks: {} });
    await expect(store.load()).rejects.toThrow('Project content missing');
  });

  it('prefers the name parameter', async () => {
    await setup({ state, decks: { p1: 'x' } });
    const named = mod.createBrowserStore({ file: 'p1.html', name: 'From URL' });
    expect((await named.load()).name).toBe('From URL');
  });
});

describe('save', () => {
  it('writes deck and rev, keeps history newest-first max 5, seeds the initial deck', async () => {
    await setup({ state, decks: { p1: 'v0' } });
    let rev = '1';
    for (let i = 1; i <= 7; i++) {
      vi.setSystemTime(1000 + i);
      rev = (await store.save(`v${i}`, { rev })).rev;
      expect(rev).toBe(String(1000 + i));
    }
    expect(storage.readStored('decks', {})).toEqual({ p1: 'v7' });
    expect(storage.readStored<Record<string, string>>('revs', {}).p1).toBe('1007');
    const history = storage.readStored<Record<string, Array<{ name: string; content: string }>>>('deck-history', {}).p1!;
    expect(history.map((h) => h.content)).toEqual(['v6', 'v5', 'v4', 'v3', 'v2']);
    expect(history[0]!.name).toBe('1007');
    const initial = storage.readStored<Record<string, { content: string; source: string }>>('initial-decks', {}).p1;
    // No history existed at the first save; the second save seeded it from the oldest retained entry.
    expect(initial).toMatchObject({ content: 'v0', source: 'earliest-retained-history' });
  });

  it('is durable in IndexedDB when it returns', async () => {
    await setup({ state, decks: { p1: 'v0' } });
    await store.save('v1', { rev: '1' });
    vi.resetModules();
    const fresh = await import('./browser-storage');
    await fresh.initStorage();
    expect(fresh.readStored('decks', {})).toEqual({ p1: 'v1' });
  });

  it('applies the 409 rule', async () => {
    await setup({ state, decks: { p1: 'v0' }, revs: { p1: '500' } });
    const { ConflictError } = await import('../contracts');
    await expect(store.save('x', { rev: '499' })).rejects.toBeInstanceOf(ConflictError);
    await expect(store.save('x', { rev: '499' })).rejects.toMatchObject({ status: 409, message: 'File changed' });
    expect(storage.readStored('decks', {})).toEqual({ p1: 'v0' });
    await expect(store.save('forced', { rev: '499', force: true })).resolves.toBeDefined();
    vi.setSystemTime(9000);
    const current = storage.readStored<Record<string, string>>('revs', {}).p1!;
    await expect(store.save('same', { rev: current })).resolves.toBeDefined();
  });

  it('never conflicts without a stored rev or an empty rev', async () => {
    await setup({ state, decks: { p1: 'v0' } });
    await expect(store.save('a', { rev: '1' })).resolves.toBeDefined();
    await expect(store.save('b', { rev: '' })).resolves.toBeDefined();
  });

  it('seeds initial-decks from the oldest retained history on a later save', async () => {
    await setup({ state, decks: { p1: 'v2' }, 'deck-history': { p1: [{ name: '2', content: 'v1' }, { name: '1', content: 'v0' }] } });
    vi.setSystemTime(2000);
    const { rev } = await store.save('v3', { rev: '1' });
    const initial = storage.readStored<Record<string, { content: string; source: string; createdAt: string }>>('initial-decks', {}).p1!;
    expect(initial.content).toBe('v0');
    expect(initial.source).toBe('earliest-retained-history');
    await store.save('v4', { rev });
    expect(storage.readStored<Record<string, { content: string }>>('initial-decks', {}).p1!.content).toBe('v0');
  });

  it('rejects unknown projects', async () => {
    await setup({ state: { projects: [] }, decks: {} });
    await expect(store.save('x', { rev: '1' })).rejects.toThrow('Project not found');
  });

  it('posts saved to the parent only after the flush and only when embedded', async () => {
    await setup({ state, decks: { p1: 'v0' } });
    vi.setSystemTime(3000);
    const { rev } = await store.save('a', { rev: '1' });
    expect(post).not.toHaveBeenCalled();
    setParent({ postMessage: post });
    const order: string[] = [];
    const flush = vi.spyOn(storage, 'flushStorage');
    post.mockImplementation(() => order.push('post'));
    flush.mockImplementation(async () => void order.push('flush'));
    await store.save('b', { rev });
    expect(order).toEqual(['flush', 'post']);
    expect(post).toHaveBeenCalledWith({ source: 'popost-editor', type: 'saved', id: 'p1' }, window.location.origin);
  });
});

describe('initial', () => {
  it('maps record sources to available/reliable', async () => {
    await setup({ state, 'initial-decks': { p1: { content: 'orig', source: 'create', createdAt: 't' } } });
    expect(await store.initial()).toEqual({ content: 'orig', available: true, reliable: true, source: 'create', createdAt: 't' });
    await setup({ state, 'initial-decks': { p1: { content: 'h', source: 'earliest-retained-history', createdAt: 't' } } });
    expect(await store.initial()).toMatchObject({ available: true, reliable: false });
    await setup({ state, 'initial-decks': { p1: { content: 'c', source: 'current', createdAt: 't' } } });
    expect(await store.initial()).toMatchObject({ available: false, reliable: false });
  });

  it('seeds from history, or reports an unavailable empty record without storing', async () => {
    await setup({ state, 'deck-history': { p1: [{ name: '1', content: 'oldest' }] } });
    expect(await store.initial()).toMatchObject({ content: 'oldest', source: 'earliest-retained-history', available: true, reliable: false });
    await setup({ state });
    expect(await store.initial()).toEqual({ content: '', available: false, reliable: false, source: 'current', createdAt: '' });
    expect(storage.readStored('initial-decks', {})).toEqual({});
  });
});

describe('preview', () => {
  it('returns a blob URL of the html, revoked after 600 000 ms', async () => {
    await setup({ state });
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    expect(await store.preview('<p>hi</p>', 'n')).toBe('blob:x');
    const blob = create.mock.calls[0]![0] as Blob;
    expect(await blob.text()).toBe('<p>hi</p>');
    vi.advanceTimersByTime(599_999);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revoke).toHaveBeenCalledWith('blob:x');
  });
});

describe('fonts', () => {
  it('loads the palette from the font base and embeds role CSS', async () => {
    await setup({ state });
    const files: Record<string, string> = {
      '/fonts/popost/palette.json': JSON.stringify({ roles: [{ id: 'inter', family: 'Inter Variable', label: 'Inter', group: 'Sans', fallback: 'sans-serif', cssPath: 'css/inter.css', licensePath: 'inter/LICENSE', package: 'p', packageVersion: '1' }] }),
      '/fonts/popost/css/inter.css': '@font-face{src:url(../inter/a.woff2)}',
      '/fonts/popost/inter/a.woff2': 'AB',
      '/fonts/popost/inter/LICENSE': 'LIC',
    };
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const body = files[new URL(String(input)).pathname];
      return body === undefined ? new Response('', { status: 404 }) : new Response(body);
    });
    const s = mod.createBrowserStore({ file: 'p1.html', name: null }, { fontBase: 'http://h.test/fonts/popost/', fetch: fetchStub as unknown as typeof fetch });
    expect((await s.fontPalette()).roles.map((r) => r.id)).toEqual(['inter']);
    const result = await s.fontCSS(['inter'], { rev: '5' });
    expect(result.rev).toBe('5');
    expect(result.css.inter).toContain('data:font/woff2;base64,QUI=');
    expect(result.css.inter!.startsWith('/* p@1\nLIC\n*/\n')).toBe(true);
    await expect(s.fontCSS(['nope'], { rev: '5' })).rejects.toThrow('该字体不在公共字体库中');
  });
});

describe('downloadAll', () => {
  it('relays M4 and resolves on M5', async () => {
    await setup({ state });
    const parent = { postMessage: post };
    setParent(parent);
    const promise = store.downloadAll('<html></html>', { rev: '1' });
    const m4 = post.mock.calls[0]![0] as { requestId: string; id: string; html: string; type: string };
    expect(m4).toMatchObject({ type: 'download-images', id: 'p1', html: '<html></html>' });
    window.dispatchEvent(new MessageEvent('message', { data: { source: 'popost-workspace', type: 'download-images-result', id: 'p1', requestId: m4.requestId }, source: parent as unknown as MessageEventSource, origin: window.location.origin }));
    await expect(promise).resolves.toEqual({ rev: '1' });
  });
});
