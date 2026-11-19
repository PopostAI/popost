import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { EditorController } from '../contracts';

vi.mock('./panels/BlockPanel', () => ({ BlockPanel: () => null }));
vi.mock('./panels/CodePanel', () => ({ CodePanel: () => null }));
vi.mock('./panels/LayersPanel', () => ({ LayersPanel: () => null }));
vi.mock('./panels/TextPanel', () => ({ TextPanel: () => null }));

import { PanelHost } from './SidePanel';
import { I18nProvider } from './i18n';

const controller = {} as EditorController;
const render = (open: 'layers' | 'code' | null) =>
  renderToStaticMarkup(
    <I18nProvider lang="en">
      <PanelHost open={open} controller={controller} onClose={() => undefined} />
    </I18nProvider>,
  );

describe('PanelHost external hooks', () => {
  it('always renders #panel; `.open` and data-view only while a panel is open', () => {
    const closed = render(null);
    expect(closed).toContain('id="panel"');
    expect(closed).not.toMatch(/class="[^"]*\bopen\b/);
    const layers = render('layers');
    expect(layers).toMatch(/id="panel" class="panel open"/);
    expect(layers).toContain('data-view="layers"');
    expect(render('code')).toContain('data-view="code"');
  });
});
