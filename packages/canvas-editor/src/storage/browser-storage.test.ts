import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Storage = typeof import('./browser-storage');

async function freshModule(): Promise<Storage> {
  vi.resetModules();
  return import('./browser-storage');
}

function rawRead(key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('popost-workspace-v24', 1);
    open.onsuccess = () => {
      const request = open.result.transaction('records', 'readonly').objectStore('records').get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    };
    open.onerror = () => reject(open.error);
  });
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
});

describe('browser-storage', () => {
  it('persists writes after flush and reloads them in a fresh module', async () => {
    const a = await freshModule();
    await a.initStorage();
    a.writeStored('decks', { p1: '<html>1</html>' });
    await a.flushStorage();
    expect(await rawRead('decks')).toEqual({ p1: '<html>1</html>' });
    const b = await freshModule();
    await b.initStorage();
    expect(b.readStored('decks', {})).toEqual({ p1: '<html>1</html>' });
  });

  it('snapshots values at write time', async () => {
    const s = await freshModule();
    const value = { n: 1 };
    s.writeStored('k', value);
    value.n = 2;
    await s.flushStorage();
    expect(await rawRead('k')).toEqual({ n: 1 });
    expect(s.readStored('k', null)).toEqual({ n: 1 });
  });

  it('serialises writes in call order', async () => {
    const s = await freshModule();
    for (let i = 0; i < 5; i++) s.writeStored('k', i);
    await s.flushStorage();
    expect(await rawRead('k')).toBe(4);
  });

  it('migrates popost-product:* from localStorage, keeping the old copies and skipping malformed ones', async () => {
    localStorage.setItem('popost-product:state', JSON.stringify({ projects: [] }));
    localStorage.setItem('popost-product:bad', '{nope');
    localStorage.setItem('other:key', '1');
    const s = await freshModule();
    expect(s.readStored('state', 'fallback')).toEqual({ projects: [] });
    await s.initStorage();
    expect(await rawRead('state')).toEqual({ projects: [] });
    expect(await rawRead('bad')).toBeUndefined();
    expect(localStorage.getItem('popost-product:state')).toBe(JSON.stringify({ projects: [] }));
    expect(localStorage.getItem('popost-product:bad')).toBe('{nope');
  });

  it('does not overwrite IndexedDB values with legacy localStorage copies', async () => {
    const a = await freshModule();
    a.writeStored('state', 'new');
    await a.flushStorage();
    localStorage.setItem('popost-product:state', '"old"');
    const b = await freshModule();
    await b.initStorage();
    expect(b.readStored('state', null)).toBe('new');
  });

  it('readStored falls back to localStorage before init, then to the fallback', async () => {
    localStorage.setItem('popost-product:a', '{"x":1}');
    const s = await freshModule();
    expect(s.readStored('a', null)).toEqual({ x: 1 });
    expect(s.readStored('missing', 'fb')).toBe('fb');
  });

  it('refreshStored picks up writes of another module instance', async () => {
    const a = await freshModule();
    const b = await freshModule();
    await a.initStorage();
    await b.initStorage();
    b.writeStored('decks', { p: 'x' });
    await b.flushStorage();
    expect(a.readStored('decks', {})).toEqual({});
    expect(await a.refreshStored('decks', {})).toEqual({ p: 'x' });
    expect(a.readStored('decks', {})).toEqual({ p: 'x' });
    expect(await a.refreshStored('absent', 'fb')).toBe('fb');
  });

  it('dispatches popost-storage-error and rejects flush when the transaction fails', async () => {
    const s = await freshModule();
    await s.initStorage();
    const events: string[] = [];
    const listener = (e: Event): void => void events.push((e as CustomEvent<string>).detail);
    window.addEventListener('popost-storage-error', listener);
    const spy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    s.writeStored('k', 1);
    await expect(s.flushStorage()).rejects.toThrow('quota exceeded');
    expect(events).toEqual(['quota exceeded']);
    spy.mockRestore();
    s.writeStored('k', 2);
    await expect(s.flushStorage()).resolves.toBeUndefined();
    window.removeEventListener('popost-storage-error', listener);
  });
});
