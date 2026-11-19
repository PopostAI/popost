import { beforeEach, describe, expect, it } from 'vitest';
import { documentTitle, LANG_KEY, LOCAL_BASE_HREF, previewBaseHref, resolveLang } from './boot';

describe('resolveLang', () => {
  beforeEach(() => localStorage.clear());

  it('prefers the query (remembered), then our key, then the legacy key', () => {
    expect(resolveLang('?lang=en', ['zh-CN'])).toBe('en');
    expect(localStorage.getItem(LANG_KEY)).toBe('en');
    expect(resolveLang('', ['zh-CN'])).toBe('en');
    localStorage.clear();
    localStorage.setItem('gs9_editor_lang', 'zh');
    expect(resolveLang('?file=a.html', ['en-US'])).toBe('zh');
  });

  it('otherwise follows the browser language without pinning it', () => {
    expect(resolveLang('', ['zh-CN', 'en'])).toBe('zh');
    expect(resolveLang('', ['zh-Hant-TW'])).toBe('zh');
    expect(resolveLang('', ['en-GB', 'zh-CN'])).toBe('en');
    expect(resolveLang('', ['fr-FR'])).toBe('en');
    expect(resolveLang('', [])).toBe('en');
    expect(resolveLang('?lang=vi', ['en-US'])).toBe('en'); // an unknown query value is no choice
    expect(localStorage.getItem(LANG_KEY)).toBeNull();
  });
});

describe('documentTitle', () => {
  it('marks unsaved documents with a bullet and falls back to Popost', () => {
    expect(documentTitle('Post', false)).toBe('Post');
    expect(documentTitle('Post', true)).toBe('• Post');
    expect(documentTitle('', false)).toBe('Popost');
  });
});

describe('previewBaseHref', () => {
  const local = { projectId: 'p', width: 1080, height: 1440, name: 'P' };

  it('uses /pages/ in local mode, the absolute site root in host mode, and nothing in browser mode', () => {
    expect(previewBaseHref({ store: 'host' }, local, 'https://app.example')).toBe(LOCAL_BASE_HREF);
    expect(previewBaseHref({ store: 'host' }, null, 'https://app.example')).toBe('https://app.example/');
    expect(previewBaseHref({ store: 'browser' }, null, 'https://app.example')).toBeUndefined();
  });
});
