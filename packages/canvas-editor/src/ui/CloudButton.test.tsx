import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudAdapter, CloudStatus } from '../contracts';
import { CloudButton, CloudView, failureText } from './CloudButton';
import type { CloudViewProps } from './CloudButton';
import { createT, I18nProvider } from './i18n';
import type { Lang } from './i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WEB = 'https://popost.ai/en/workspace/projects/d1';
const base: CloudStatus = { ok: true, mode: 'anonymous', state: 'idle', dirty: true };
const noop = (): void => undefined;

const view = (props: Partial<CloudViewProps> & { status: CloudStatus | null }, lang: Lang = 'en'): string =>
  renderToStaticMarkup(
    <I18nProvider lang={lang}>
      <CloudView mode="anonymous" link={null} copied={false} busy={null} onStart={noop} onPush={noop} onRetry={noop} onCopy={noop} {...props} />
    </I18nProvider>,
  );

describe('CloudView states', () => {
  it('anonymous idle: the owner\'s copy, with the tooltip', () => {
    const en = view({ status: base });
    expect(en).toContain('Save to Cloud');
    expect(en).toContain('title="Manage all your assets on the Popost website"');
    const zh = view({ status: base }, 'zh');
    expect(zh).toContain('保存到云端');
    expect(zh).toContain('title="在popost网页端管理你的所有资产"');
    expect(view({ status: null })).toContain('Save to Cloud');
  });

  it('anonymous idle after an upload with later local changes: "Local changes not uploaded"', () => {
    expect(view({ status: { ...base, webUrl: WEB, deckId: 'd1' } })).toContain('Local changes not uploaded');
    expect(view({ status: { ...base, webUrl: WEB, deckId: 'd1' } }, 'zh')).toContain('本地改动未上传');
  });

  it('keyed idle offers a manual sync', () => {
    expect(view({ mode: 'keyed', status: { ...base, mode: 'keyed' } })).toContain('Sync now');
  });

  it('waiting: spinner, text, copy button, and the login link only when it is needed', () => {
    const waiting: CloudStatus = { ...base, state: 'waiting' };
    const plain = view({ status: waiting });
    expect(plain).toContain('Waiting for login…');
    expect(plain).toContain('Copy link');
    expect(plain).toContain('class="spinner small"');
    expect(plain).not.toContain('<input');
    const withLink = view({ status: waiting, link: 'https://popost.ai/en/workspace/cloud-save?v=1' });
    expect(withLink).toContain('<input');
    expect(withLink).toContain('value="https://popost.ai/en/workspace/cloud-save?v=1"');
    expect(view({ status: waiting, copied: true })).toContain('Link copied');
  });

  it('uploading (and starting a push) shows a spinner and plain text', () => {
    expect(view({ status: { ...base, state: 'uploading' } })).toContain('Uploading…');
    expect(view({ mode: 'keyed', status: { ...base, mode: 'keyed', state: 'uploading' } })).toContain('Syncing…');
    expect(view({ status: base, busy: 'push' })).toContain('Uploading…');
    expect(view({ status: base, busy: 'start' })).toContain('Waiting for login…');
  });

  it('saved: "Saved" with an Open link (anonymous) and "Synced" (keyed)', () => {
    const saved = view({ status: { ...base, state: 'saved', dirty: false, webUrl: WEB } });
    expect(saved).toContain('Saved');
    expect(saved).toContain(`href="${WEB}"`);
    expect(saved).toContain('>Open<');
    expect(saved).toContain('rel="noopener noreferrer"');
    expect(view({ mode: 'keyed', status: { ...base, mode: 'keyed', state: 'saved', dirty: false, webUrl: WEB } })).toContain('Synced');
    expect(view({ status: { ...base, state: 'saved', webUrl: WEB } }, 'zh')).toContain('已保存');
  });

  it('failed: a readable message by code, the raw text only in the tooltip, and Retry', () => {
    const failed = view({ status: { ...base, state: 'failed', error: { code: 'STORAGE_FULL', message: '云端存储空间已满 [STORAGE_FULL]' } } });
    expect(failed).toContain('Your cloud storage is full.');
    expect(failed).toContain('title="云端存储空间已满 [STORAGE_FULL]"');
    expect(failed).toContain('Retry');
    expect(view({ status: { ...base, state: 'failed', error: { code: 'WHO_KNOWS', message: 'x' } } })).toContain('Upload failed. Try again.');
    expect(view({ status: { ...base, state: 'failed' } })).toContain('Upload failed. Try again.');
    for (const code of ['UNAUTHORIZED', 'STORAGE_FULL', 'RATE_LIMITED', 'DECK_INVALID', 'NETWORK'])
      expect(failureText(createT('zh'), code), code).not.toBe(failureText(createT('zh'), 'other'));
  });

  it('conflict: "Edited on the web" with Open, and Overwrite only with a key', () => {
    const conflict = view({ status: { ...base, state: 'conflict', webUrl: WEB, error: { code: 'DECK_CONFLICT', message: 'x' } } });
    expect(conflict).toContain('Edited on the web');
    expect(conflict).toContain(`href="${WEB}"`);
    // overwriting needs the user's key: an upload credential may not replace edits made on the web
    expect(conflict).not.toContain('Overwrite');
    expect(view({ mode: 'keyed', status: { ...base, mode: 'keyed', state: 'conflict', webUrl: WEB } })).toContain('Overwrite');
    expect(view({ status: { ...base, state: 'conflict', webUrl: WEB } }, 'zh')).toContain('网页端已有修改');
  });

  it('never shows a pulsing dot or any glow in any state', () => {
    for (const state of ['idle', 'waiting', 'uploading', 'saved', 'failed', 'conflict'] as const) {
      const html = view({ status: { ...base, state, webUrl: WEB } });
      expect(html, state).not.toMatch(/state-dot|pulse|sparkle|glow/);
    }
  });
});

interface Fake extends CloudAdapter {
  statuses: CloudStatus[];
  statusCalls: number;
  start: ReturnType<typeof vi.fn>;
  push: ReturnType<typeof vi.fn>;
}

const fake = (mode: CloudAdapter['mode'], statuses: CloudStatus[]): Fake => {
  const adapter = {
    mode,
    statuses,
    statusCalls: 0,
    status: async () => adapter.statuses[Math.min(adapter.statusCalls++, adapter.statuses.length - 1)]!,
    start: vi.fn(async () => ({ authorizeUrl: 'https://popost.ai/en/workspace/cloud-save?v=1', expiresAt: '2026-11-14T12:10:00Z' })),
    push: vi.fn(async () => statuses.at(-1)!),
  };
  return adapter as Fake;
};

describe('CloudButton behaviour', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const opened: { location: { href: string }; opener: unknown; close: () => void }[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    opened.length = 0;
    vi.stubGlobal('open', vi.fn(() => {
      const win = { location: { href: '' }, opener: 'x', close: vi.fn() };
      opened.push(win);
      return win;
    }));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const mount = async (cloud: CloudAdapter, saveState: 'saved' | 'dirty' = 'saved', lang: Lang = 'en', saveLocal = async () => true) => {
    await act(async () => {
      root.render(<I18nProvider lang={lang}><CloudButton cloud={cloud} saveState={saveState} saveLocal={saveLocal} /></I18nProvider>);
    });
  };
  const click = async (text: string) => {
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
    if (!button) throw new Error(`no button "${text}" in ${host.innerHTML}`);
    await act(async () => {
      button.click();
    });
  };
  const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

  it('anonymous: Save opens the login in the window made by the click, then polls until saved and stops', async () => {
    const waiting: CloudStatus = { ...base, state: 'waiting' };
    const saved: CloudStatus = { ...base, state: 'saved', dirty: false, webUrl: WEB, deckId: 'd1' };
    const cloud = fake('anonymous', [base, waiting, waiting, saved]);
    await mount(cloud);
    expect(host.textContent).toContain('Save to Cloud');
    await click('Save to Cloud');
    expect(cloud.start).toHaveBeenCalledWith('en');
    expect(window.open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(opened[0]!.location.href).toBe('https://popost.ai/en/workspace/cloud-save?v=1');
    expect(opened[0]!.opener).toBeNull();
    expect(host.textContent).toContain('Waiting for login…');
    expect(host.querySelector('input')).toBeNull();
    await tick(2000);
    expect(host.textContent).toContain('Waiting for login…');
    await tick(2000);
    expect(host.textContent).toContain('Saved');
    expect(host.querySelector('a')?.getAttribute('href')).toBe(WEB);
    const calls = cloud.statusCalls;
    await tick(10_000);
    expect(cloud.statusCalls).toBe(calls);
  });

  it('saves local changes before requesting a login and does not upload if saving fails', async () => {
    const cloud = fake('anonymous', [base, { ...base, state: 'waiting' }]);
    const save = vi.fn(async () => true).mockResolvedValueOnce(false);
    await mount(cloud, 'dirty', 'en', save);
    await click('Save to Cloud');
    expect(host.textContent).toContain('Could not save local edits');
    expect(opened[0]!.close).toHaveBeenCalled();
    expect(cloud.start).not.toHaveBeenCalled();
    await click('Retry');
    expect(save.mock.invocationCallOrder[1]).toBeLessThan(cloud.start.mock.invocationCallOrder[0]!);
  });

  it('shows the login link for copying when the browser blocks the window', async () => {
    vi.stubGlobal('open', vi.fn(() => null));
    const cloud = fake('anonymous', [base, { ...base, state: 'waiting' }]);
    await mount(cloud, 'saved', 'zh');
    await click('保存到云端');
    expect(cloud.start).toHaveBeenCalledWith('zh');
    expect(host.querySelector('input')?.getAttribute('value')).toBe('https://popost.ai/en/workspace/cloud-save?v=1');
  });

  it('copies the link, and falls back to the visible field when the clipboard refuses', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const cloud = fake('anonymous', [base, { ...base, state: 'waiting' }]);
    await mount(cloud);
    await click('Save to Cloud');
    await click('Copy link');
    expect(writeText).toHaveBeenCalledWith('https://popost.ai/en/workspace/cloud-save?v=1');
    expect(host.textContent).toContain('Link copied');
    writeText.mockRejectedValueOnce(new Error('denied'));
    await click('Link copied');
    expect(host.querySelector('input')).not.toBeNull();
  });

  it('a failed start closes the blank window and offers Retry; Retry starts again', async () => {
    const cloud = fake('anonymous', [base]);
    cloud.start.mockRejectedValueOnce(new Error('offline'));
    await mount(cloud);
    await click('Save to Cloud');
    expect(host.textContent).toContain('Retry');
    expect((opened[0]!.close as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    await click('Retry');
    expect(cloud.start).toHaveBeenCalledTimes(2);
  });

  it('conflict: Overwrite pushes with force; Open links to the web copy', async () => {
    const conflict: CloudStatus = { ...base, mode: 'keyed', state: 'conflict', webUrl: WEB, error: { code: 'DECK_CONFLICT', message: 'x' } };
    const cloud = fake('keyed', [conflict, { ...conflict, state: 'saved', dirty: false, error: undefined }]);
    cloud.push.mockResolvedValue({ ...conflict, state: 'saved', dirty: false });
    await mount(cloud);
    expect(host.querySelector('a')?.getAttribute('href')).toBe(WEB);
    await click('Overwrite');
    expect(cloud.push).toHaveBeenCalledWith({ force: true, lang: 'en' });
    expect(host.textContent).toContain('Synced');
  });

  it('a push that needs a login falls back to starting one', async () => {
    const cloud = fake('anonymous', [{ ...base, state: 'failed', error: { code: 'NETWORK', message: 'x' } }]);
    cloud.push.mockResolvedValue({ ...base, ok: false, error: { code: 'LOGIN_REQUIRED', message: 'x' } });
    await mount(cloud);
    await click('Retry');
    expect(cloud.push).toHaveBeenCalledWith({ force: false, lang: 'en' });
    expect(cloud.start).toHaveBeenCalledWith('en');
  });

  it('asks for a new login straight away when the old credential is gone', async () => {
    const cloud = fake('anonymous', [{ ...base, state: 'failed', error: { code: 'UNAUTHORIZED', message: 'x' } }]);
    await mount(cloud);
    await click('Retry');
    expect(cloud.push).not.toHaveBeenCalled();
    expect(cloud.start).toHaveBeenCalledTimes(1);
  });

  it('keyed: polls while changes wait to sync, shows Synced, and refreshes after each save of the editor', async () => {
    const pending: CloudStatus = { ...base, mode: 'keyed', state: 'idle', dirty: true };
    const synced: CloudStatus = { ...pending, state: 'saved', dirty: false, webUrl: WEB };
    const cloud = fake('keyed', [pending, pending, synced]);
    await mount(cloud);
    expect(cloud.statusCalls).toBe(1);
    await tick(2000);
    await tick(2000);
    expect(host.textContent).toContain('Synced');
    const calls = cloud.statusCalls;
    await tick(10_000);
    expect(cloud.statusCalls).toBe(calls);
    await mount(cloud, 'dirty');
    expect(cloud.statusCalls).toBe(calls + 1);
  });
});
