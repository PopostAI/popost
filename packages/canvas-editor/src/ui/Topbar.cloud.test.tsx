import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createEditorController } from '../app';
import { FakeFrame, FakeStore, flush } from '../app/fakes';
import type { CloudAdapter, HostParams } from '../contracts';
import { I18nProvider } from './i18n';
import { Topbar } from './Topbar';

const PARAMS: HostParams = { popost: true, file: 'p1.html', ratio: null, lang: 'en', name: null, embedded: true, theme: null, store: 'browser' };

const cloud: CloudAdapter = {
  mode: 'anonymous',
  status: async () => ({ ok: true, mode: 'anonymous', state: 'idle', dirty: true }),
  start: async () => ({ authorizeUrl: 'https://popost.ai/en/workspace/cloud-save', expiresAt: '' }),
  push: async () => ({ ok: true, mode: 'anonymous', state: 'idle', dirty: true }),
};

const topbar = async (store: FakeStore): Promise<string> => {
  const controller = createEditorController({ store, frame: new FakeFrame(), params: PARAMS });
  await controller.start();
  await flush();
  return renderToStaticMarkup(
    <I18nProvider lang="en">
      <Topbar controller={controller} snap={controller.getSnapshot()} onSize={() => undefined} comparing={false} onCompare={() => undefined} />
    </I18nProvider>,
  );
};

describe('Topbar cloud slot', () => {
  it('shows the cloud button between export and save when the store offers cloud save', async () => {
    const store = new FakeStore();
    store.cloud = cloud;
    const html = await topbar(store);
    expect(html).toContain('Save to Cloud');
    expect(html.indexOf('id="btn-export"')).toBeLessThan(html.indexOf('class="cloud"'));
    expect(html.indexOf('class="cloud"')).toBeLessThan(html.indexOf('id="btn-save"'));
  });

  it('renders nothing for stores without it: browser mode and every embedding host', async () => {
    const html = await topbar(new FakeStore());
    expect(html).not.toContain('cloud');
    expect(html).not.toContain('Save to Cloud');
    expect(html).toContain('id="btn-save"');
  });

  it('the controller exposes exactly the store\'s adapter', async () => {
    const store = new FakeStore();
    const without = createEditorController({ store, frame: new FakeFrame(), params: PARAMS });
    expect(without.cloud).toBeUndefined();
    store.cloud = cloud;
    expect(createEditorController({ store, frame: new FakeFrame(), params: PARAMS }).cloud).toBe(cloud);
  });
});
