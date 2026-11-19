import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DownloadError, applyTheme, initialCanvasSize, installStoreChanges, installTheme, parseImageOrigins, parseParams, readImageOrigins, postToHost, ratioToSize, readLocalBoot, readParams, requestImageDownload } from './index';

function setParent(value: unknown): void {
  Object.defineProperty(window, 'parent', { value, configurable: true });
}

function deliver(data: unknown, init: { source?: unknown; origin?: string } = {}): void {
  window.dispatchEvent(new MessageEvent('message', { data, source: (init.source ?? window.parent) as MessageEventSource, origin: init.origin ?? window.location.origin }));
}

afterEach(() => {
  delete window.__POPOST_PARAMS__;
  delete window.__POPOST_LOCAL__;
  document.documentElement.className = '';
  vi.useRealTimers();
});

describe('imageOrigins parameter', () => {
  const q = (value: string) => `store=host&imageOrigins=${encodeURIComponent(value)}`;

  it('reads a comma separated list in host mode and ignores invalid entries', () => {
    expect(parseImageOrigins(q('https://a.example.com,https://b.example.com:8443'), 'host')).toEqual(['https://a.example.com', 'https://b.example.com:8443']);
    expect(parseImageOrigins(q('https://a.example.com,http://b.example.com,*,https://c.example.com/x,https://*.d.example.com'), 'host')).toEqual(['https://a.example.com']);
  });

  it('keeps at most four origins', () => {
    const list = ['a', 'b', 'c', 'd', 'e'].map((n) => `https://${n}.example.com`);
    expect(parseImageOrigins(q(list.join(',')), 'host')).toEqual(list.slice(0, 4));
  });

  it('is empty when absent, empty or when the store is not host', () => {
    expect(parseImageOrigins('store=host', 'host')).toEqual([]);
    expect(parseImageOrigins(q(''), 'host')).toEqual([]);
    expect(parseImageOrigins(q('https://a.example.com'), 'browser')).toEqual([]);
    expect(parseImageOrigins('imageOrigins=https%3A%2F%2Fa.example.com', parseParams('imageOrigins=https%3A%2F%2Fa.example.com').store)).toEqual([]);
  });

  it('readImageOrigins follows the page query, only for store=host and never in local mode', () => {
    window.__POPOST_PARAMS__ = q('https://a.example.com');
    expect(readImageOrigins()).toEqual(['https://a.example.com']);
    window.__POPOST_PARAMS__ = 'imageOrigins=https%3A%2F%2Fa.example.com';
    expect(readImageOrigins()).toEqual([]);
    window.__POPOST_PARAMS__ = q('https://a.example.com');
    window.__POPOST_LOCAL__ = { projectId: 'p', width: 1, height: 1 };
    expect(readImageOrigins()).toEqual([]);
  });
});

describe('params', () => {
  it('has defaults', () => {
    expect(parseParams('')).toEqual({ popost: false, file: null, ratio: null, lang: 'zh', name: null, embedded: true, theme: null, store: 'browser' });
  });

  it('reads every parameter', () => {
    const p = parseParams('popost=1&file=p1.html&ratio=9%3A16&lang=en&revision=3&name=%E5%9B%BE&embedded=0&theme=dark&store=host');
    expect(p).toEqual({ popost: true, file: 'p1.html', ratio: '9:16', lang: 'en', name: '图', embedded: false, theme: 'dark', store: 'host' });
  });

  it('maps unknown lang to zh, unknown theme to null and unknown store to browser', () => {
    const p = parseParams('lang=vi&theme=blue&store=cloud');
    expect(p.lang).toBe('zh');
    expect(p.theme).toBeNull();
    expect(p.store).toBe('browser');
  });

  it('prefers __POPOST_PARAMS__ over location.search', () => {
    window.__POPOST_PARAMS__ = 'file=x.html&lang=en';
    expect(readParams().file).toBe('x.html');
    window.__POPOST_PARAMS__ = '';
    expect(readParams().file).toBeNull();
    window.__POPOST_PARAMS__ = 42;
    expect(readParams().lang).toBe('zh');
  });
});

describe('local boot and sizes', () => {
  it('returns null without a valid global', () => {
    expect(readLocalBoot()).toBeNull();
    window.__POPOST_LOCAL__ = { projectId: 'a', width: 0, height: 10 };
    expect(readLocalBoot()).toBeNull();
  });

  it('reads the injected boot object', () => {
    window.__POPOST_LOCAL__ = { projectId: 'abc', width: 1080, height: 1350, name: 'Brief' };
    expect(readLocalBoot()).toEqual({ projectId: 'abc', width: 1080, height: 1350, name: 'Brief' });
    window.__POPOST_LOCAL__ = { projectId: 'abc', width: 1, height: 2 };
    expect(readLocalBoot()?.name).toBe('Popost');
  });

  it('reads the cloud mode the server offers and ignores anything else', () => {
    for (const mode of ['keyed', 'anonymous']) {
      window.__POPOST_LOCAL__ = { projectId: 'abc', width: 1, height: 2, cloud: { mode } };
      expect(readLocalBoot()?.cloud).toEqual({ mode });
    }
    for (const cloud of [{ mode: 'off' }, { mode: 1 }, {}, null, 'keyed', undefined]) {
      window.__POPOST_LOCAL__ = { projectId: 'abc', width: 1, height: 2, cloud };
      expect(readLocalBoot(), JSON.stringify(cloud)).not.toHaveProperty('cloud');
    }
  });

  it('maps ratios to canvas sizes', () => {
    expect(ratioToSize(null)).toEqual({ width: 1280, height: 720 });
    expect(ratioToSize('1:1')).toEqual({ width: 1080, height: 1080 });
    expect(ratioToSize('3:4')).toEqual({ width: 1080, height: 1440 });
    expect(ratioToSize('9:16')).toEqual({ width: 1080, height: 1920 });
    expect(ratioToSize('4:5')).toEqual({ width: 1080, height: 1350 });
    const params = parseParams('ratio=1:1');
    expect(initialCanvasSize(params, null)).toEqual({ width: 1080, height: 1080 });
    expect(initialCanvasSize(params, { projectId: 'a', width: 800, height: 600, name: '' })).toEqual({ width: 800, height: 600 });
  });
});

describe('postToHost', () => {
  it('never posts when parent === window', () => {
    const spy = vi.spyOn(window, 'postMessage');
    expect(postToHost({ source: 'popost-editor', type: 'saved', id: 'a' })).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('posts with targetOrigin = location.origin when embedded', () => {
    const post = vi.fn();
    setParent({ postMessage: post });
    expect(postToHost({ source: 'popost-editor', type: 'saved', id: 'a' })).toBe(true);
    expect(post).toHaveBeenCalledWith({ source: 'popost-editor', type: 'saved', id: 'a' }, window.location.origin);
    setParent(window);
  });
});

describe('theme', () => {
  let parent: { postMessage: () => void };
  beforeEach(() => {
    parent = { postMessage: vi.fn() };
    setParent(parent);
  });
  afterEach(() => setParent(window));

  it('applies the param and follows only trusted M1 messages', () => {
    const dispose = installTheme({ theme: 'dark' });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    deliver({ source: 'popost-workspace', type: 'popost-theme', mode: 'light' }, { source: parent });
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    deliver({ source: 'popost-workspace', type: 'popost-theme', mode: 'dark' }, { source: {} });
    deliver({ source: 'popost-workspace', type: 'popost-theme', mode: 'dark' }, { source: parent, origin: 'https://evil.example' });
    deliver({ source: 'other', type: 'popost-theme', mode: 'dark' }, { source: parent });
    deliver({ source: 'popost-workspace', type: 'popost-theme', mode: 'blue' }, { source: parent });
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    dispose();
    deliver({ source: 'popost-workspace', type: 'popost-theme', mode: 'dark' }, { source: parent });
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    applyTheme('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});

describe('store changes (M8)', () => {
  let parent: { postMessage: () => void };
  beforeEach(() => {
    parent = { postMessage: vi.fn() };
    setParent(parent);
  });
  afterEach(() => setParent(window));

  it('fires only for trusted store-changed messages about this project', () => {
    const onChange = vi.fn();
    const dispose = installStoreChanges('p1', onChange);
    deliver({ source: 'popost-workspace', type: 'store-changed', id: 'p1' }, { source: parent });
    expect(onChange).toHaveBeenCalledTimes(1);
    deliver({ source: 'popost-workspace', type: 'store-changed', id: 'p2' }, { source: parent });
    deliver({ source: 'popost-workspace', type: 'store-changed', id: 'p1' }, { source: {} });
    deliver({ source: 'popost-workspace', type: 'store-changed', id: 'p1' }, { source: parent, origin: 'https://evil.example' });
    deliver({ source: 'other', type: 'store-changed', id: 'p1' }, { source: parent });
    deliver({ source: 'popost-workspace', type: 'popost-theme', id: 'p1' }, { source: parent });
    expect(onChange).toHaveBeenCalledTimes(1);
    dispose();
    deliver({ source: 'popost-workspace', type: 'store-changed', id: 'p1' }, { source: parent });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('download relay (M4/M5)', () => {
  let post: ReturnType<typeof vi.fn>;
  let parent: { postMessage: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    post = vi.fn();
    parent = { postMessage: post };
    setParent(parent);
  });
  afterEach(() => setParent(window));

  function lastRequest(): { requestId: string; id: string; html: string } {
    return post.mock.calls.at(-1)?.[0] as { requestId: string; id: string; html: string };
  }

  it('posts M4 and resolves on a matching M5', async () => {
    const promise = requestImageDownload('p1', '<html></html>');
    const m4 = lastRequest();
    expect(post.mock.calls.at(-1)?.[1]).toBe(window.location.origin);
    expect(m4).toMatchObject({ source: 'popost-editor', type: 'download-images', id: 'p1', html: '<html></html>' });
    deliver({ source: 'popost-workspace', type: 'download-images-result', id: 'p1', requestId: 'wrong' }, { source: parent });
    deliver({ source: 'popost-workspace', type: 'download-images-result', id: 'other', requestId: m4.requestId }, { source: parent });
    deliver({ source: 'popost-workspace', type: 'download-images-result', id: 'p1', requestId: m4.requestId }, { source: {} });
    deliver({ source: 'popost-workspace', type: 'download-images-result', id: 'p1', requestId: m4.requestId }, { source: parent });
    await expect(promise).resolves.toBeUndefined();
  });

  it('rejects with the host error text', async () => {
    const promise = requestImageDownload('p1', 'x');
    deliver({ source: 'popost-workspace', type: 'download-images-result', id: 'p1', requestId: lastRequest().requestId, error: 'boom' }, { source: parent });
    await expect(promise).rejects.toMatchObject({ reason: 'host', message: 'boom' });
  });

  it('allows one request at a time', async () => {
    const first = requestImageDownload('p1', 'x');
    await expect(requestImageDownload('p1', 'y')).rejects.toMatchObject({ reason: 'busy' });
    deliver({ source: 'popost-workspace', type: 'download-images-result', id: 'p1', requestId: lastRequest().requestId }, { source: parent });
    await first;
    const second = requestImageDownload('p1', 'z');
    deliver({ source: 'popost-workspace', type: 'download-images-result', id: 'p1', requestId: lastRequest().requestId }, { source: parent });
    await expect(second).resolves.toBeUndefined();
  });

  it('times out after 120 000 ms', async () => {
    vi.useFakeTimers();
    const promise = requestImageDownload('p1', 'x');
    const assertion = expect(promise).rejects.toMatchObject({ reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(119_999);
    await vi.advanceTimersByTimeAsync(2);
    await assertion;
  });

  it('refuses when not embedded or without id', async () => {
    await expect(requestImageDownload('', 'x')).rejects.toBeInstanceOf(DownloadError);
    setParent(window);
    await expect(requestImageDownload('p1', 'x')).rejects.toMatchObject({ reason: 'unavailable' });
  });
});
