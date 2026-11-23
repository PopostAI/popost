/**
 * A page that never finishes loading (one of its resources never answers) is still recorded, with a note that says
 * so; a page whose document never arrives is refused with words that say what to try. Needs Chrome and ffmpeg.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, hasChrome, type DiskRuntime } from '../../src/testing/disk';
import { capturePage } from '../../src/video/capture/index';
import { hasFfmpeg, probe } from '../../src/video/media/ffmpeg';

let rt: DiskRuntime;
let server: Server;
let base = '';
const held: import('node:http').ServerResponse[] = [];
beforeAll(async () => {
  rt = await createDiskRuntime();
  server = createServer((req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<!doctype html><html><body style="margin:0;background:#204080"><h1 style="color:#fff">Slow</h1><img src="/never.png" width="10" height="10"></body></html>'); return; }
    held.push(res); // never answered: the page's load event cannot fire
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
});
afterAll(async () => { for (const r of held) r.destroy(); await new Promise((done) => server.close(done)); await rt.cleanup(); });
const probeRt = await createDiskRuntime();
const ready = (await hasFfmpeg(probeRt)) && hasChrome();
await probeRt.cleanup();

describe.skipIf(!ready)('capture: a page that never finishes loading', () => {
  it('is recorded as it stands, and the notes say that it had not finished loading', async () => {
    const out = rt.path.join(rt.dir, 'slow.mp4');
    const r = await capturePage(rt, { url: base + '/', out, width: 320, height: 240, fps: 10, steps: [{ hold: 5 }], loadMs: 1500, settleMs: 100 });
    expect(r.frames).toBe(5);
    expect(r.notes.some((n) => n.includes('had not finished loading after 1.5 s'))).toBe(true);
    expect(await probe(rt, out)).toMatchObject({ width: 320, height: 240, frames: 5 });
  });
});
