import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictError } from '../contracts';
import { HostStoreError, requestFromHost } from '../host';
import { createHostStore } from './host-store';

interface StoreRequest {
  source: string;
  type: string;
  id: string;
  requestId: string;
  op: string;
  content?: string;
  rev?: string;
  force?: boolean;
}

function setParent(value: unknown): void {
  Object.defineProperty(window, 'parent', { value, configurable: true });
}

function deliver(data: unknown, init: { source?: unknown; origin?: string } = {}): void {
  window.dispatchEvent(new MessageEvent('message', { data, source: (init.source ?? window.parent) as MessageEventSource, origin: init.origin ?? window.location.origin }));
}

let post: ReturnType<typeof vi.fn>;
let parent: { postMessage: ReturnType<typeof vi.fn> };

const lastRequest = (): StoreRequest => post.mock.calls.at(-1)?.[0] as StoreRequest;
const reply = (request: StoreRequest, body: Record<string, unknown>): void =>
  deliver({ source: 'popost-workspace', type: 'store-result', id: request.id, requestId: request.requestId, ...body }, { source: parent });

beforeEach(() => {
  post = vi.fn();
  parent = { postMessage: post };
  setParent(parent);
});
afterEach(() => {
  setParent(window);
  vi.useRealTimers();
});

describe('M6/M7 store requests', () => {
  it('posts M6 to the host origin and resolves only on a matching trusted M7', async () => {
    const promise = requestFromHost('p1', 'load');
    const m6 = lastRequest();
    expect(post.mock.calls.at(-1)?.[1]).toBe(window.location.origin);
    expect(m6).toMatchObject({ source: 'popost-editor', type: 'store', id: 'p1', op: 'load' });
    deliver({ source: 'popost-workspace', type: 'store-result', id: 'p1', requestId: 'wrong', ok: true, result: 1 }, { source: parent });
    deliver({ source: 'popost-workspace', type: 'store-result', id: 'other', requestId: m6.requestId, ok: true, result: 2 }, { source: parent });
    deliver({ source: 'popost-workspace', type: 'store-result', id: 'p1', requestId: m6.requestId, ok: true, result: 3 }, { source: {} });
    deliver({ source: 'popost-workspace', type: 'store-result', id: 'p1', requestId: m6.requestId, ok: true, result: 4 }, { source: parent, origin: 'https://evil.example' });
    deliver({ source: 'popost-editor', type: 'store-result', id: 'p1', requestId: m6.requestId, ok: true, result: 5 }, { source: parent });
    reply(m6, { ok: true, result: 6 });
    await expect(promise).resolves.toBe(6);
  });

  it('keeps overlapping requests apart', async () => {
    const first = requestFromHost('p1', 'load');
    const a = lastRequest();
    const second = requestFromHost('p1', 'initial');
    const b = lastRequest();
    reply(b, { ok: true, result: 'b' });
    reply(a, { ok: true, result: 'a' });
    await expect(first).resolves.toBe('a');
    await expect(second).resolves.toBe('b');
  });

  it('rejects with the host error code, and when not embedded or timed out', async () => {
    const failing = requestFromHost('p1', 'save');
    reply(lastRequest(), { ok: false, error: { code: 'forbidden', message: 'No access' } });
    await expect(failing).rejects.toMatchObject({ code: 'forbidden', message: 'No access' });

    vi.useFakeTimers();
    const slow = requestFromHost('p1', 'load', {}, 1000);
    vi.advanceTimersByTime(1000);
    await expect(slow).rejects.toMatchObject({ code: 'timeout' });

    setParent(window);
    await expect(requestFromHost('p1', 'load')).rejects.toBeInstanceOf(HostStoreError);
    await expect(requestFromHost('', 'load')).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('createHostStore', () => {
  const store = () => createHostStore({ file: 'p1.html', name: null }, { fontBase: 'https://fonts.example/', fetch: vi.fn() });

  it('loads content, revision and name from the host', async () => {
    const promise = store().load();
    reply(lastRequest(), { ok: true, result: { content: '<div class="slide"></div>', rev: '7', name: 'Brief' } });
    await expect(promise).resolves.toEqual({ content: '<div class="slide"></div>', rev: '7', name: 'Brief', path: 'p1.html' });
  });

  it('falls back to the param name, then the id, and refuses a reply without content', async () => {
    const named = createHostStore({ file: 'p1.html', name: 'From URL' }).load();
    reply(lastRequest(), { ok: true, result: { content: 'x', rev: '1' } });
    await expect(named).resolves.toMatchObject({ name: 'From URL' });

    const unnamed = store().load();
    reply(lastRequest(), { ok: true, result: { content: 'x', rev: '1', name: '' } });
    await expect(unnamed).resolves.toMatchObject({ name: 'p1' });

    const empty = store().load();
    reply(lastRequest(), { ok: true, result: { rev: '1' } });
    await expect(empty).rejects.toMatchObject({ code: 'invalid-reply' });
  });

  it('saves with rev and force, and maps a conflict to ConflictError', async () => {
    const saved = store().save('<html>', { rev: '7' });
    const m6 = lastRequest();
    expect(m6).toMatchObject({ op: 'save', content: '<html>', rev: '7', force: false });
    reply(m6, { ok: true, result: { rev: '8' } });
    await expect(saved).resolves.toEqual({ rev: '8' });

    const stale = store().save('<html>', { rev: '7' });
    reply(lastRequest(), { ok: false, error: { code: 'conflict', message: 'File changed' } });
    await expect(stale).rejects.toBeInstanceOf(ConflictError);

    const forced = store().save('<html>', { rev: '7', force: true });
    expect(lastRequest()).toMatchObject({ force: true });
    reply(lastRequest(), { ok: true, result: { rev: '9' } });
    await expect(forced).resolves.toEqual({ rev: '9' });
  });

  it('reports the initial layout as available only with content', async () => {
    const withContent = store().initial();
    reply(lastRequest(), { ok: true, result: { content: '<a>', available: true, reliable: true, source: 'create', createdAt: '2026-11-01T00:00:00Z' } });
    await expect(withContent).resolves.toEqual({ content: '<a>', available: true, reliable: true, source: 'create', createdAt: '2026-11-01T00:00:00Z' });

    const without = store().initial();
    reply(lastRequest(), { ok: true, result: { available: true } });
    await expect(without).resolves.toEqual({ content: '', available: false, reliable: false, source: 'host', createdAt: '' });
  });

  it('behaves like browser mode for previews and downloads', async () => {
    const s = store();
    expect(s.mode).toBe('browser');
    expect(await s.preview('<p>', 'n')).toMatch(/^blob:/);
    const download = s.downloadAll('<html>', { rev: '3' });
    const m4 = post.mock.calls.at(-1)?.[0] as { type: string; id: string; requestId: string };
    expect(m4).toMatchObject({ type: 'download-images', id: 'p1' });
    deliver({ source: 'popost-workspace', type: 'download-images-result', id: 'p1', requestId: m4.requestId }, { source: parent });
    await expect(download).resolves.toEqual({ rev: '3' });
  });
});
