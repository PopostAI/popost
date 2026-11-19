import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import type { DocStore, HostParams } from '../contracts';
import { createEditorController } from './index';
import type { EditorHandle } from './index';
import { FakeFrame, flush, idByAttr } from './fakes';

const PARAMS: HostParams = { popost: true, file: 'p1.html', ratio: null, lang: 'en', name: null, embedded: true, theme: null, store: 'browser' };

/** Odd-but-valid bytes: CRLF, comments, uneven whitespace, entities. */
const SOURCE =
  '<!DOCTYPE html>\r\n<html lang="en">\r\n<head><meta charset="utf-8"><title>Odd &amp; even</title>\r\n' +
  '<style>.slide{position:relative}</style></head>\r\n<body  class="x">\r\n<!-- one -->\r\n' +
  '<section class=slide style="width:1080px;height:1350px">\r\n  <h1 data-layer-id="title"   style="color:red">Hello &amp; bye</h1>\r\n' +
  '  <p data-layer-id="body">Line<br>two</p>\r\n</section>\r\n</body>\r\n</html>\r\n';

async function open(): Promise<{ store: DocStore; c: EditorHandle; frame: FakeFrame }> {
  const { createBrowserStore } = await import('../storage/browser-store');
  const store = createBrowserStore({ file: 'p1.html', name: null });
  const frame = new FakeFrame();
  const c = createEditorController({ store, frame, params: PARAMS });
  await c.start();
  c.attachFrame(document.createElement('iframe'));
  await flush();
  return { store, c, frame };
}

describe('controller with the real browser store', () => {
  it('opens, edits, saves and reopens with the edited bytes; an unedited save is byte-identical', async () => {
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
    const storage = await import('../storage/browser-storage');
    await storage.initStorage();
    storage.writeStored('state', { projects: [{ id: 'p1', name: 'Post One' }] });
    storage.writeStored('decks', { p1: SOURCE });
    await storage.flushStorage();

    const first = await open();
    expect(first.c.getSnapshot()).toMatchObject({ docState: 'ready', name: 'Post One', saveState: 'saved' });
    expect(first.c.index().source).toBe(SOURCE);
    await first.c.save({ force: true });
    expect(storage.readStored<Record<string, string>>('decks', {}).p1).toBe(SOURCE);

    const title = idByAttr(first.c, 'title');
    first.c.beginTextEdit(title);
    first.frame.editHtml = 'Changed &lt;text&gt;';
    first.c.endTextEdit(true);
    first.c.apply({ kind: 'setStyle', id: title, props: { color: 'blue' } });
    expect(first.c.getSnapshot().saveState).toBe('dirty');
    await first.c.save();
    expect(first.c.getSnapshot().saveState).toBe('saved');
    const edited = first.c.index().source;
    expect(edited).toBe(
      SOURCE.replace('style="color:red">Hello &amp; bye', 'style="color:blue">Changed &lt;text&gt;'),
    );

    await storage.flushStorage();
    const second = await open();
    expect(second.c.index().source).toBe(edited);
    expect(second.c.getSnapshot().saveState).toBe('saved');
    second.c.undo();
    expect(second.c.getSnapshot().canUndo).toBe(false);
  });
});
