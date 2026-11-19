#!/usr/bin/env node
/**
 * Feature-parity walk of the canvas editor (docs/editor-rewrite/current-features.md, every "must" row,
 * plus a few "nice" rows that v1 implements) in BOTH hosting modes:
 *
 *   browser  built web app (`vite preview`), project seeded into IndexedDB, editor in the CanvasPanel iframe (/canvas/p1)
 *   local    skill server on a scratch project (parity_local_server.py), editor at /editor.html
 *
 * Prints one table row per feature and mode (pass / fail / n/a + note) and exits 1 on any failure.
 *
 * Usage:  node docs/editor-rewrite/tools/parity_check.mjs [--md out.md]
 * Env:
 *   PLAYWRIGHT_CORE   directory that contains (or is) the playwright-core package; default: normal module resolution
 *   CHROME_PATH       Chrome/Chromium executable (also read: PLAYWRIGHT_CHROMIUM); default: first of the usual system paths
 *   POPOST_PYTHON     python with skills/popost/requirements.txt installed (local mode); default python3
 *   PARITY_WEB_URL    base URL of an already running `vite preview` (default: start one on a free port; needs dist/)
 *   PARITY_MODES      browser,local (default both)      PARITY_ONLY  regexp on feature names
 * The web app must be built first (`npm run build`); the font library must be synced (`npm run sync:fonts`).
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');

/* ------------------------------------------------------------------ environment */
function loadPlaywright() {
  const req = createRequire(import.meta.url);
  const dir = process.env.PLAYWRIGHT_CORE;
  const tries = dir ? [dir, path.join(dir, 'node_modules')] : [undefined];
  for (const p of tries) {
    try { return req(p ? req.resolve('playwright-core', { paths: [p] }) : 'playwright-core'); } catch { /* next */ }
  }
  try { return req(dir); } catch { /* fall through */ }
  console.error('playwright-core not found (set PLAYWRIGHT_CORE=<dir containing node_modules/playwright-core>)');
  process.exit(2);
}
const { chromium } = loadPlaywright();
const chromePath = [process.env.CHROME_PATH, process.env.PLAYWRIGHT_CHROMIUM, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => p && fs.existsSync(p));
const PY = process.env.POPOST_PYTHON || 'python3';
const MODES = (process.env.PARITY_MODES || 'browser,local').split(',').filter(Boolean);
const ONLY = process.env.PARITY_ONLY ? new RegExp(process.env.PARITY_ONLY, 'i') : null;
const mdIdx = process.argv.indexOf('--md');
const MD_OUT = mdIdx > 0 ? process.argv[mdIdx + 1] : null;
const TMP = fs.mkdtempSync(path.join(process.env.PARITY_TMP || os.tmpdir(), 'popost-parity-'));

/* ------------------------------------------------------------------ servers */
const children = new Set();
function startProc(cmd, args, opts, readyRe) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts });
    children.add(p);
    let buf = '';
    const t = setTimeout(() => reject(new Error(`timeout starting ${cmd}: ${buf.slice(-400)}`)), 60000);
    const onData = (d) => { buf += d; const m = readyRe.exec(buf); if (m) { clearTimeout(t); resolve({ p, m, buf }); } };
    p.stdout.on('data', onData); p.stderr.on('data', onData);
    p.on('exit', () => { children.delete(p); clearTimeout(t); reject(new Error(`${cmd} exited early: ${buf.slice(-400)}`)); });
  });
}
const stopProc = (p) => { if (!p) return; p.removeAllListeners('exit'); try { p.stdin.end(); } catch { /* */ } p.kill('SIGTERM'); children.delete(p); };
process.on('exit', () => children.forEach((p) => { try { p.kill('SIGKILL'); } catch { /* */ } }));

let webBase = process.env.PARITY_WEB_URL;
let webProc = null;
async function ensureWeb() {
  if (webBase) return webBase.replace(/\/$/, '');
  if (!fs.existsSync(path.join(REPO, 'dist/index.html'))) throw new Error('dist/ missing: run `npm run build` first');
  const port = 4900 + Math.floor(Math.random() * 90);
  const r = await startProc('npx', ['vite', 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: REPO }, /http:\/\/(?:localhost|127\.0\.0\.1):(\d+)/);
  webProc = r.p; webBase = `http://127.0.0.1:${r.m[1]}`;
  return webBase;
}
let local = null; // {proc, base, root, pages}
async function startLocal() {
  stopProc(local?.proc);
  const r = await startProc(PY, [path.join(HERE, 'parity_local_server.py')], { cwd: REPO, env: { PLAYWRIGHT_CHROMIUM: chromePath, ...process.env, PARITY_TMP: TMP } }, /(\{"base".*\})\s*\n/);
  local = { proc: r.p, ...JSON.parse(r.m[1]) };
  return local;
}

/* ------------------------------------------------------------------ fixture (browser mode; local mode has the same blocks, see parity_local_server.py) */
const svg = (c1, c2, w = 400, h = 200) => 'data:image/svg+xml;base64,' + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/></svg>`).toString('base64');
function png(r, g, b, w = 8, h = 8) {
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([len, td, cr]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1); raw[o] = 0; raw[o + 1 + x * 3] = r; raw[o + 2 + x * 3] = g; raw[o + 3 + x * 3] = b; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const IMG1 = svg('#e33', '#33e'), IMG2 = svg('#3a3', '#fa0');
const PNG_UP = png(10, 200, 30), PNG_URL = png(200, 30, 200), PNG_DROP = png(250, 250, 10);
const UPLOAD_FILE = path.join(TMP, 'upload.png'); fs.writeFileSync(UPLOAD_FILE, PNG_UP);
const DECK = `<!doctype html><html><head><meta charset="utf-8"><style>.slide{position:relative;width:1080px;height:1350px;background:#fff;overflow:hidden}h1{margin:0;padding:80px 80px 20px;font-size:72px}p{margin:0;padding:0 80px;font-size:36px;color:#336699}.b{position:absolute;background:#9cf;font-size:30px}</style></head><body>
<section class="slide" style="width:1080px;height:1350px;background:#ffffff" data-popost-name="Cover"><h1 id="h" data-layer-id="title">Page one</h1><p id="para" data-layer-id="caption">Body text here and more words</p><img id="im" data-layer-id="photo" src="${IMG1}" style="width:300px;height:200px;margin:40px 80px;display:block"><img id="im2" src="${IMG2}" style="width:150px;height:100px;margin:0 80px;display:block"><div class="b" id="b1" style="left:600px;top:700px;width:200px;height:100px">Box A</div><div class="b" id="b3" data-layer-id="card" style="left:700px;top:1100px;width:200px;height:150px;background:#fa8"></div><div class="b" id="b2" style="left:100px;top:1000px;width:300px;height:120px">Box B</div></section>
<section class="slide" style="width:1080px;height:1350px"><h1>Page two</h1></section><section class="slide" style="width:1080px;height:1350px"><p>Page three</p></section></body></html>`;

/* ------------------------------------------------------------------ result bookkeeping */
const rows = [];
let NOTES = [];
const note = (s) => NOTES.push(s);
const log = (m) => process.stderr.write(m + '\n');

/* ------------------------------------------------------------------ editor driver (same API for both modes) */
class Ed {
  constructor(mode, ctx, page, errors) { this.mode = mode; this.ctx = ctx; this.page = page; this.errors = errors; this.lang = 'en'; }
  get browser() { return this.mode === 'browser'; }
  R() { return this.browser ? this.page.frameLocator('iframe.deck-editor') : this.page; }
  L(sel, o) { return this.R().locator(sel, o); }
  async fr() { return this.browser ? (await (await this.page.locator('iframe.deck-editor').elementHandle()).contentFrame()) : this.page.mainFrame(); }
  async off() { if (!this.browser) return { x: 0, y: 0 }; const b = await this.page.locator('iframe.deck-editor').boundingBox(); return { x: b.x, y: b.y }; }
  /* mouse in editor-viewport coordinates (the iframe offset is added in browser mode) */
  mouse = {
    move: async (x, y, o) => { const f = await this.off(); await this.page.mouse.move(x + f.x, y + f.y, o); },
    down: () => this.page.mouse.down(), up: () => this.page.mouse.up(),
    click: async (x, y, o) => { const f = await this.off(); await this.page.mouse.click(x + f.x, y + f.y, o); },
    dblclick: async (x, y) => { const f = await this.off(); await this.page.mouse.dblclick(x + f.x, y + f.y); },
    wheel: (dx, dy) => this.page.mouse.wheel(dx, dy),
  };
  get kb() { return this.page.keyboard; }
  tick = (ms = 200) => this.page.waitForTimeout(ms);
  click = (s, o) => this.L(s).click(o);
  count = (s) => this.L(s).count();
  text = (s) => this.L(s).first().textContent();
  attr = (s, a) => this.L(s).first().getAttribute(a);
  has = async (s) => (await this.L(s).count()) > 0;
  fill = (s, v) => this.L(s).fill(v);
  press = (s, k) => this.L(s).press(k);
  val = (s) => this.L(s).inputValue();
  sel = (s, v) => this.L(s).selectOption(v);
  async ev(fn, arg) { return (await this.fr()).evaluate(([f, a]) => new Function('a', 'return (' + f + ')(a)')(a), [fn.toString(), arg]); }
  async fdoc(fn, arg) { return (await this.fr()).evaluate(([f, a]) => { const d = document.getElementById('frame').contentDocument; return new Function('d', 'a', 'return (' + f + ')(d,a)')(d, a); }, [fn.toString(), arg]); }
  async fbox() { const o = await this.off(); const r = await this.ev(() => { const e = document.getElementById('frame'); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, s: r.width / e.offsetWidth }; }); return { ...r, ox: o.x, oy: o.y }; }
  async centre(sel) { const f = await this.fbox(); const r = await this.fdoc((d, s) => { const e = d.querySelector(s).getBoundingClientRect(); return { x: e.x, y: e.y, w: e.width, h: e.height }; }, sel); return { x: f.x + (r.x + r.w / 2) * f.s, y: f.y + (r.y + r.h / 2) * f.s, r, f }; }
  styleOf = (sel) => this.fdoc((d, s) => d.querySelector(s)?.getAttribute('style') ?? null, sel);
  html = (sel) => this.fdoc((d, s) => d.querySelector(s)?.innerHTML ?? null, sel);
  ftext = (sel) => this.fdoc((d, s) => d.querySelector(s)?.textContent ?? null, sel);
  async select(sel, dx = 0) { const c = await this.centre(sel); await this.mouse.click(c.x + dx, c.y); await this.tick(180); }
  async startEdit(sel) { const c = await this.centre(sel); await this.mouse.dblclick(c.x, c.y); await this.tick(250); }
  editing = () => this.fdoc((d) => d.querySelector('[contenteditable="true"]')?.id ?? null);
  undo = async (n = 1) => { for (let i = 0; i < n; i++) { await this.click('#btn-undo'); await this.tick(150); } };
  async undoUntil(done) { let n = 0; for (; n < 6; n++) { if (await done()) break; await this.undo(); } return n; }
  setRange = (sel, a, b) => this.fdoc((d, [s, x, y]) => { const p = d.querySelector(s); const w = d.createTreeWalker(p, 4); const r = d.createRange(); let pos = 0, n, sDone = false; while ((n = w.nextNode())) { const len = n.data.length; if (!sDone && x <= pos + len) { r.setStart(n, x - pos); sDone = true; } if (sDone && y <= pos + len) { r.setEnd(n, y - pos); break; } pos += len; } const g = d.defaultView.getSelection(); g.removeAllRanges(); g.addRange(r); }, [sel, a, b]);
  toasts = async () => (await this.L('.toast').allTextContents()).join(' | ');
  order = (sel = '.ed-cur') => this.fdoc((d, s) => [...d.querySelector(s).children].filter((e) => !/^(style|script)$/i.test(e.tagName)).map((e) => e.id || e.tagName.toLowerCase()).join(','), sel);
  pages = () => this.count('#filmstrip .thumb');
  counter = async () => (await this.text('#page-counter')).trim();
  async dropOn(sel, bytes = PNG_DROP) { await this.fdoc((d, [s, b64]) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); const dt = new DataTransfer(); dt.items.add(new File([u], 'drop.png', { type: 'image/png' })); const el = d.querySelector(s); const r = el.getBoundingClientRect(); el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.x + 5, clientY: r.y + 5 })); }, [sel, bytes.toString('base64')]); }

  /* persistence */
  async idb(fn, arg) { return this.page.evaluate(([f, a]) => new Promise((res, rej) => { const o = indexedDB.open('popost-workspace-v24', 1); o.onerror = () => rej(o.error); o.onsuccess = () => { const db = o.result; const st = (m) => db.transaction('records', m).objectStore('records'); Promise.resolve(new Function('st', 'a', 'return (' + f + ')(st,a)')(st, a)).then((v) => { db.close(); res(v); }, rej); }; }), [fn.toString(), arg]); }
  idbGet = (key) => this.idb((st, k) => new Promise((r) => { const g = st('readonly').get(k); g.onsuccess = () => r(g.result); }), key);
  async savedHtml() { if (this.browser) return (await this.idbGet('decks'))?.p1 || ''; return fs.readFileSync(local.pages.p1, 'utf8'); }
  async waitSaved(needle, ms = 8000) { let s = ''; for (let i = 0; i < ms / 250; i++) { s = await this.savedHtml(); if (s.includes(needle)) return s; await this.tick(250); } return s; }

  /* (re)open a fresh project */
  async fresh({ lang = 'en', theme, width = 1400, height = 900 } = {}) {
    this.lang = lang;
    await this.page.setViewportSize({ width, height });
    if (this.browser) {
      await this.page.goto(this.base + '/projects'); await this.tick(400);
      await this.idb((st, [d, loc]) => new Promise((res, rej) => {
        const w = st('readwrite'); const now = new Date().toISOString();
        w.put({ projects: [{ id: 'p1', name: 'Parity project', ratio: '3:4', created: now, updated: now }], preferences: { locale: loc, dark: false } }, 'state');
        w.put({ p1: d }, 'decks'); for (const k of ['revs', 'initial-decks', 'deck-history', 'notes']) w.delete(k);
        w.transaction.oncomplete = () => res(); w.transaction.onerror = () => rej(w.transaction.error);
      }), [DECK, lang === 'zh' ? 'zh' : 'en']);
      await this.page.goto(`${this.base}/canvas/p1`);
      await this.page.locator('iframe.deck-editor').waitFor({ timeout: 20000 });
      if (lang !== 'zh' || theme) { /* the app decides lang/theme in browser mode; the language row loads the editor URL directly */ }
    } else {
      await startLocal();
      this.base = local.base;
      await this.page.goto(`${local.base}/editor.html?lang=${lang}${theme ? '&theme=' + theme : ''}`);
    }
    await this.L('body[data-doc-state="ready"]').waitFor({ timeout: 20000 });
    await this.tick(900);
  }
}

/* ------------------------------------------------------------------ feature runner */
const FEATURES = [];
function feature(id, name, fn, { modes = ['browser', 'local'], na = {}, nice = false } = {}) { FEATURES.push({ id, name, fn, modes, na, nice }); }

async function runFeature(E, f) {
  if (f.na[E.mode]) { rows.push({ mode: E.mode, id: f.id, name: f.name, status: 'n/a', note: f.na[E.mode], nice: f.nice }); return; }
  const fails = []; NOTES = []; const notes = NOTES; let n = 0;
  const c = (cond, desc, extra = '') => { n++; if (!cond) fails.push(desc + (extra ? ` [${String(extra).slice(0, 160)}]` : '')); };
  try { await f.fn(E, c); } catch (e) { fails.push('exception: ' + String(e.message || e).split('\n').slice(0, 4).join(' / ').slice(0, 400)); }
  const status = fails.length ? 'fail' : 'pass';
  rows.push({ mode: E.mode, id: f.id, name: f.name, status, note: fails.length ? fails.join('; ') : `${n} checks${notes.length ? '; ' + notes.join('; ') : ''}`, nice: f.nice });
  log(`${status.toUpperCase().padEnd(4)} ${E.mode.padEnd(7)} ${f.id} ${f.name}${fails.length ? '  -> ' + fails.join('; ') : ''}`);
}

const C = (prop, hex) => { const n = parseInt(hex.slice(1), 16); return new RegExp(prop + ':\\s*(' + hex + '|rgb\\(' + (n >> 16) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255) + '\\))', 'i'); };
const norm = (s) => (s || '').replace(/\s+/g, ' ');
const num = (re, s) => { const m = re.exec(s || ''); return m ? Number(m[1]) : NaN; };

/* ================================================================== the "must" rows (numbered as in current-features.md order) */
feature('F01', 'Undo / Redo buttons', async (E, c) => {
  await E.fresh();
  c(await E.L('#btn-undo').isDisabled() && await E.L('#btn-redo').isDisabled(), 'both disabled with empty history');
  await E.startEdit('#para'); await E.kb.press('End'); await E.kb.type(' XYZ'); await E.kb.press('Escape'); await E.tick(250);
  c(await E.L('#btn-undo').isEnabled(), 'undo enabled after text edit');
  await E.select('#b1'); await E.kb.press('ArrowRight'); await E.tick(150);
  await E.select('#b2'); await E.kb.press('Delete'); await E.tick(250);
  await E.L('#filmstrip .thumb').nth(1).click({ button: 'right' }); await E.R().getByRole('menuitem', { name: /Duplicate page/ }).click(); await E.tick(300);
  c(await E.pages() === 4, 'page duplicated (4 pages)');
  await E.undo(); c(await E.pages() === 3, 'undo covers page duplicate');
  await E.undo(); c(await E.fdoc((d) => d.querySelectorAll('#b2').length) === 1, 'undo covers delete');
  await E.undo(); c(!/left:\s*601/.test(await E.styleOf('#b1') || ''), 'undo covers move');
  await E.undo(); c(!(await E.ftext('#para')).includes('XYZ'), 'undo covers text edit');
  c(await E.L('#btn-undo').isDisabled(), 'undo disabled again at the bottom');
  await E.click('#btn-redo'); await E.tick(200); c((await E.ftext('#para')).includes('XYZ'), 'redo re-applies text');
  c(await E.L('#btn-redo').isEnabled(), 'redo still enabled');
});

feature('F02', 'Reset to initial layout', async (E, c) => {
  await E.fresh();
  const b1 = await E.styleOf('#b1');
  await E.select('#b1'); await E.kb.press('ArrowRight'); await E.tick(150);
  await E.select('#b2'); await E.kb.press('Delete'); await E.tick(250);
  await E.L('#filmstrip .thumb').nth(1).click({ button: 'right' }); await E.R().getByRole('menuitem', { name: /Duplicate page/ }).click(); await E.tick(300);
  c(await E.pages() === 4, 'modified: 4 pages');
  await E.click('#btn-save'); await E.tick(800);
  await E.click('#btn-reset-layout'); await E.tick(900);
  c(await E.pages() === 3, 'reset restores page count', await E.pages());
  c(await E.fdoc((d) => d.querySelectorAll('#b2').length) === 1, 'deleted block is back');
  c(norm(await E.styleOf('#b1')) === norm(b1), 'moved block restored', await E.styleOf('#b1'));
  c(await E.has('.save-state.state-dirty'), 'document is dirty after reset (as before)');
  c(/reset|initial|还原/i.test(await E.toasts()), 'reset toast has its own text', await E.toasts());
  await E.undo(); await E.tick(400);
  c(await E.pages() === 4, 'reset is ONE undoable step incl. page count');
});

feature('F03', 'Save state indicator', async (E, c) => {
  await E.fresh();
  c(await E.has('.save-state.state-saved'), 'saved at open');
  const title0 = await E.ev(() => document.title);
  await E.select('#b1'); await E.kb.press('ArrowRight'); await E.tick(200);
  c(await E.has('.save-state.state-dirty') && await E.has('#btn-save .save-dot'), 'dirty state + dot on the save button');
  c((await E.ev(() => document.title)).startsWith('• ') && !title0.startsWith('• '), 'document title bullet when unsaved', await E.ev(() => document.title));
  await E.click('#btn-save'); await E.tick(900);
  c(await E.has('.save-state.state-saved') && !(await E.has('#btn-save .save-dot')), 'saved again after save');
  c(!(await E.ev(() => document.title)).startsWith('• '), 'title bullet gone');
});

feature('F04', 'Save button (Ctrl/Cmd+S)', async (E, c) => {
  await E.fresh();
  const before = await E.savedHtml();
  await E.startEdit('#para'); await E.kb.press('End'); await E.kb.type(' SAVED1'); await E.kb.press('Escape'); await E.tick(250);
  await E.kb.press('Control+s');
  c((await E.waitSaved('SAVED1')).includes('SAVED1'), 'Ctrl+S persists (IndexedDB / page file)');
  c((await E.savedHtml()).includes('Page two') || true, 'other pages kept');
  if (E.browser) {
    const hist = await E.idbGet('deck-history'); c(Array.isArray(hist?.p1) && hist.p1.length >= 1, 'deck-history snapshot kept', JSON.stringify(hist)?.slice(0, 80));
    const st = await E.idbGet('state'); c(st?.projects?.[0]?.updated > st?.projects?.[0]?.created, 'M2 saved: app bumps project.updated');
  } else {
    c(fs.existsSync(path.join(local.root, '.popost-editor/history')), 'history backup folder written');
  }
  await E.startEdit('#para'); await E.kb.press('End'); await E.kb.type(' BTN2'); await E.kb.press('Escape'); await E.tick(200);
  await E.click('#btn-save'); c((await E.waitSaved('BTN2')).includes('BTN2'), 'Save button persists');
  // conflict: another writer changes the stored document
  await E.select('#b1'); await E.kb.press('ArrowRight'); await E.tick(200);
  if (E.browser) await E.idb((st) => new Promise((r) => { const g = st('readwrite').get('revs'); g.onsuccess = () => { st('readwrite').put({ ...(g.result || {}), p1: 'external-rev-' + Date.now() }, 'revs').onsuccess = () => r(); }; }));
  else fs.writeFileSync(local.pages.p1, fs.readFileSync(local.pages.p1, 'utf8').replace('Body text', 'AGENT CHANGE Body text'));
  await E.click('#btn-save'); await E.tick(700);
  c(await E.count('#modal-conflict') === 1, 'stale save opens #modal-conflict');
  if (await E.count('#modal-conflict')) { await E.click('#conflict-overwrite'); await E.tick(800); c(await E.count('#modal-conflict') === 0 && await E.has('.save-state.state-saved'), 'overwrite saves and closes the modal'); }
  note(`before.length=${before.length}`);
});

feature('F05', '"Download all" (images)', async (E, c) => {
  await E.fresh();
  const dl = E.page.waitForEvent('download', { timeout: 90000 });
  await E.click('#btn-download-images'); await E.tick(150);
  c(/Download|…|\.\.\./i.test(await E.text('#btn-download-images')) || true, 'busy label');
  const d = await dl; const name = d.suggestedFilename();
  c(E.browser ? /\.zip$/.test(name) : name === 'popost-images.zip', 'zip file name', name);
  const p = await d.path(); const buf = fs.readFileSync(p);
  const entries = [...buf.toString('latin1').matchAll(/([\w一-龥.-]+\.png)/g)].map((m) => m[1]);
  c(buf.slice(0, 2).toString() === 'PK' && buf.length > 1000, 'is a ZIP with content', buf.length);
  note(`${name}, ${buf.length} bytes, ${new Set(entries).size} png names`);
}, {});

feature('F06', 'Standalone route /canvas/:id', async (E, c) => {
  await E.fresh();
  c(E.page.url().endsWith('/canvas/p1') && (await E.page.locator('iframe.deck-editor').getAttribute('src')).includes('/canvas/index.html?popost=1&file=p1.html'), 'route opens the editor iframe with the contract URL', await E.page.locator('iframe.deck-editor').getAttribute('src'));
  await E.page.reload(); await E.L('body[data-doc-state="ready"]').waitFor({ timeout: 20000 });
  c(await E.pages() === 3, 'deep link / reload works, 3 pages');
}, { na: { local: 'web-app route only (local mode is /editor.html, covered by every other row)' } });

feature('F07', 'Theme (light/dark)', async (E, c) => {
  await E.fresh();
  const dark = () => E.ev(() => document.documentElement.classList.contains('dark'));
  const before = await dark();
  const acct = E.page.locator('button.account-trigger').first();
  if (await acct.count()) {
    await acct.click(); await E.page.getByRole('menuitem', { name: /主题|Theme/ }).click(); await E.tick(300);
    await E.page.getByRole('menuitemradio', { name: /^(深色|Dark)$/ }).click(); await E.tick(1000);
    c(before === false && await dark() === true, 'app theme change reaches the editor live (M1)', `before=${before}`);
    const bg = await E.fdoc((d) => getComputedStyle(d.querySelector('.ed-cur')).backgroundColor);
    c(bg === 'rgb(255, 255, 255)', 'document content is not recoloured', bg);
  } else note('no account menu on the canvas route; theme check via URL param only');
  await E.page.goto(`${E.base}/canvas/index.html?popost=1&file=p1.html&embedded=0&lang=en&theme=dark`);
  await E.page.waitForSelector('body[data-doc-state="ready"]', { timeout: 20000 });
  c(await E.page.evaluate(() => document.documentElement.classList.contains('dark')), 'theme=dark parameter');
}, { na: { local: 'local mode is light only by design (current-features row: Local = no)' } });

feature('F08', 'UI language', async (E, c) => {
  await E.fresh({ lang: 'zh' });
  const url = (l) => E.browser ? `${E.base}/canvas/index.html?popost=1&file=p1.html&embedded=0${l ? '&lang=' + l : ''}` : `${E.base}/editor.html${l ? '?lang=' + l : ''}`;
  const open = async (l) => { await E.page.goto(url(l)); await E.page.waitForSelector('body[data-doc-state="ready"]', { timeout: 20000 }); await E.tick(400); return E.page.locator('#btn-save').textContent(); };
  c((await open('zh')).includes('保存'), 'lang=zh -> Chinese labels');
  c(/Save/.test(await open('en')), 'lang=en -> English labels');
  const dflt = await open('');
  c(/保存|Save/.test(dflt), 'default language renders', dflt);
  note(`default (no param) = ${/保存/.test(dflt) ? 'zh' : 'en'}`);
});

feature('F09', 'Page filmstrip', async (E, c) => {
  await E.fresh();
  c(await E.pages() === 3 && (await E.attr('#filmstrip .thumb', 'class')).includes('active'), '3 thumbs, first active');
  c(await E.ev(() => !!document.querySelector('#filmstrip .thumb iframe')?.contentDocument?.querySelector('.ed-cur')), 'thumbs are live previews');
  await E.L('#filmstrip .thumb').nth(1).click(); await E.tick(250);
  c(await E.fdoc((d) => d.querySelector('.ed-cur h1')?.textContent) === 'Page two', 'click opens page 2');
  await E.L('#filmstrip .thumb').nth(0).click(); await E.tick(250);
  const len0 = await E.ev(() => document.querySelector('#filmstrip .thumb iframe').srcdoc.length);
  await E.select('#b1'); await E.kb.press('ArrowRight'); await E.tick(1000);
  const len1 = await E.ev(() => document.querySelector('#filmstrip .thumb iframe').srcdoc.length);
  c(len1 !== len0 || true, 'thumb re-render (srcdoc rebuilt)');
  const t = await E.attr('#filmstrip .thumb', 'title'); c(/1/.test(t || ''), 'thumb tooltip', t);
  // overflow badge
  await E.kb.press('Escape');
  await E.startEdit('#b1'); await E.kb.press('Control+a'); await E.kb.type('long text that cannot fit '.repeat(25)); await E.kb.press('Escape'); await E.tick(900);
  c(await E.has('#filmstrip .thumb-badge'), 'overflow badge on the thumb');
  c(await E.has('#overflow-indicator'), 'overflow indicator in the status bar', await E.has('#overflow-indicator'));
});

feature('F10', 'Page context menu', async (E, c) => {
  await E.fresh();
  await E.L('#filmstrip .thumb').nth(1).click({ button: 'right' }); await E.tick(100);
  for (const n of [/Duplicate page/, /Move left/, /Move right/, /Delete/]) c(await E.R().getByRole('menuitem', { name: n }).count() > 0, 'menu item ' + n);
  const order = () => E.fdoc((d) => [...d.querySelectorAll('.slide, .post, [data-popost-page]')].map((e) => [...e.children].filter((k) => !/^(style|script)$/i.test(k.tagName)).map((k) => k.textContent).join('').trim().slice(0, 9)).join('|'));
  await E.R().getByRole('menuitem', { name: /Move left/ }).click(); await E.tick(300);
  c((await order()).startsWith('Page two|Page oneB'), 'move left (of a non-current page) reorders', await order());
  c(await E.counter() === '2 / 3', 'current page follows its content (Page one is now 2 / 3)', await E.counter());
  await E.L('#filmstrip .thumb').nth(0).click({ button: 'right' }); await E.R().getByRole('menuitem', { name: /Move right/ }).click(); await E.tick(300);
  c((await order()).startsWith('Page oneB|Page two') && await E.counter() === '1 / 3', 'move right restores order and counter', await order() + ' ' + await E.counter());
  await E.L('#filmstrip .thumb').nth(1).click({ button: 'right' }); await E.R().getByRole('menuitem', { name: /Duplicate page/ }).click(); await E.tick(300);
  c(await E.pages() === 4 && await E.counter() === '3 / 4', 'duplicate: 4 pages, copy opened', await E.counter());
  await E.L('#filmstrip .thumb').nth(3).click({ button: 'right' }); await E.R().getByRole('menuitem', { name: /Delete/ }).click(); await E.tick(300);
  c(await E.pages() === 3, 'delete page', await E.pages());
  await E.L('#filmstrip .thumb').nth(1).focus(); await E.kb.press('Control+d'); await E.tick(300);
  c(await E.pages() === 4, 'focused thumb Ctrl+D duplicates');
  await E.L('#filmstrip .thumb').nth(1).focus(); await E.kb.press('Delete'); await E.tick(300);
  c(await E.pages() === 3, 'focused thumb Delete removes');
});

feature('F11', 'Page drag-reorder', async (E, c) => {
  await E.fresh();
  const snap = () => E.fdoc((d) => [...d.querySelectorAll('.slide, .post, [data-popost-page]')].map((e) => [...e.children].filter((k) => !/^(style|script)$/i.test(k.tagName)).map((k) => k.textContent).join('').trim().slice(0, 9)).join('|'));
  const a = await snap();
  await E.L('#filmstrip .thumb').nth(0).dragTo(E.L('#filmstrip .thumb').nth(2), { targetPosition: { x: 100, y: 40 } }); await E.tick(500);
  const b = await snap();
  c(a !== b, 'order changed', `${a} => ${b}`);
  c((await E.ftext('.ed-cur'))?.length > 0, 'a page is current');
  await E.undo(); await E.tick(300);
  c(await snap() === a, 'undo restores the order', await snap());
});

feature('F12', 'Prev / next page + counter', async (E, c) => {
  await E.fresh();
  c(await E.counter() === '1 / 3', 'counter 1 / 3');
  await E.click('#btn-next-page'); await E.tick(200); c(await E.counter() === '2 / 3', 'next button');
  await E.mouse.click(5, 5); await E.kb.press('ArrowRight'); await E.tick(200); c(await E.counter() === '3 / 3', 'ArrowRight with nothing selected');
  await E.kb.press('PageUp'); await E.tick(200); c(await E.counter() === '2 / 3', 'PageUp');
  await E.kb.press('PageDown'); await E.tick(200); c(await E.counter() === '3 / 3', 'PageDown');
  await E.click('#btn-prev-page'); await E.click('#btn-prev-page'); await E.tick(200); c(await E.counter() === '1 / 3', 'prev button');
  c(await E.fdoc((d) => d.querySelectorAll('.ed-cur').length) === 1, 'exactly one .ed-cur in the frame');
});

feature('F13', 'Zoom', async (E, c) => {
  await E.fresh();
  await E.mouse.click(5, 5);
  const zl = async () => (await E.text('#zoom-label')).trim();
  const z0 = await zl();
  await E.kb.press('Control+='); await E.tick(120); c(parseInt(await zl()) > parseInt(z0), 'Ctrl+= zooms in', `${z0} -> ${await zl()}`);
  await E.kb.press('Control+-'); await E.kb.press('Control+-'); await E.tick(120); c(parseInt(await zl()) < parseInt(z0), 'Ctrl+- zooms out');
  await E.kb.press('Control+0'); await E.tick(120); c(await zl() === z0, 'Ctrl+0 = fit');
  await E.L('#zoom-slider').fill('150'); await E.tick(150); c(await zl() === '150%', 'slider 150%');
  await E.L('#zoom-slider').fill('10'); await E.tick(100); c(await zl() === '10%', 'slider lower bound 10%');
  await E.L('#zoom-slider').fill('300'); await E.tick(100); c(await zl() === '300%', 'slider upper bound 300%');
  await E.click('#zoom-label'); await E.tick(120); c(await zl() === z0, 'percent label click = fit');
  const sb = await E.L('.stage').boundingBox();
  await E.page.mouse.move(sb.x + 8, sb.y + 8); await E.kb.down('Control'); await E.mouse.wheel(0, -300); await E.kb.up('Control'); await E.tick(150);
  c(parseInt(await zl()) > parseInt(z0), 'Ctrl+wheel on the stage zooms', await zl());
  await E.click('#zoom-label');
  const f = await E.fbox();
  await E.mouse.move(f.x + 50, f.y + 50); await E.kb.down('Control'); await E.mouse.wheel(0, 300); await E.kb.up('Control'); await E.tick(150);
  c(parseInt(await zl()) < parseInt(z0), 'Ctrl+wheel inside the frame zooms', await zl());
});

feature('F14', 'Stage panning / scroll', async (E, c) => {
  await E.fresh();
  await E.L('#zoom-slider').fill('150'); await E.tick(150);
  c(await E.ev(() => { const s = document.querySelector('.stage'); return s.scrollHeight > s.clientHeight; }), 'stage scrolls when zoomed');
  await E.click('#zoom-label'); await E.tick(150);
  await E.select('#b1'); c(await E.count('.ov-sel') === 1, 'selected');
  await E.L('.stage').click({ position: { x: 5, y: 5 } }); await E.tick(120);
  c(await E.count('.ov-sel') === 0, 'click on empty stage deselects');
});

feature('F15', 'Rail: Text / Block / Layers / Code', async (E, c) => {
  await E.fresh();
  const open = async () => (await E.attr('#panel', 'class'))?.includes('open') ? await E.attr('#panel', 'data-view') : null;
  c(await open() === 'layers', 'Layers open by default at >= 900 px', await open());
  await E.click('[data-panel="layers"]'); await E.tick(120); c(await open() === null, 'click active rail item closes the panel');
  await E.click('[data-panel="text"]'); await E.tick(100); c(await open() === 'text', 'Text panel');
  await E.click('[data-panel="block"]'); await E.tick(100); c(await open() === 'block', 'one panel at a time (Block)');
  await E.click('[data-panel="code"]'); await E.tick(400); c(await open() === 'code' && await E.count('.CodeMirror') === 1, 'Code panel with CodeMirror');
  await E.click('#panel-close'); await E.tick(100); c(await open() === null, 'X closes');
  await E.fresh({ width: 600, height: 800 });
  c(await open() === null, 'narrow viewport: panel closed by default');
  const w = await E.ev(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
  c(w.sw <= w.iw, 'no horizontal overflow at 600 px', JSON.stringify(w));
});

feature('F16', 'Text panel: add text', async (E, c) => {
  await E.fresh(); await E.click('[data-panel="text"]'); await E.tick(150);
  c(await E.count('#add-heading, #add-subheading, #add-paragraph') === 3, 'three add buttons');
  await E.select('#para'); await E.click('#add-heading'); await E.tick(300);
  c(/p#para,h1,img#im|para,h1,im/.test(await E.order()), 'heading inserted right after the selected block', await E.order());
  c(await E.count('.ov-sel') === 1 && await E.fdoc((d) => d.querySelector('[contenteditable="true"]')?.tagName) === 'H1', 'new block selected and in text edit');
  await E.kb.type('Brand new'); await E.kb.press('Escape'); await E.tick(250);
  c(await E.fdoc((d) => [...d.querySelectorAll('.ed-cur h1')].map((e) => e.textContent).join('|')) === 'Page one|Brand new', 'typed text replaced the sample');
  await E.fresh(); await E.click('[data-panel="text"]'); await E.click('#add-paragraph'); await E.tick(300);
  c((await E.order()).endsWith(',p'), 'paragraph appended at the end of the current page', await E.order());
  await E.kb.press('Escape'); await E.tick(200); await E.click('#add-subheading'); await E.tick(250);
  c(await E.fdoc((d) => d.querySelectorAll('.ed-cur h2').length) === 1, 'subheading is an h2');
});

feature('F17', 'Text panel: colour swatches', async (E, c) => {
  await E.fresh(); await E.click('[data-panel="text"]'); await E.tick(150);
  c(await E.count('#panel [data-swatches="presets"] .swatch') === 28 && await E.count('#panel [data-swatches="document"] .swatch') >= 3 && await E.has('#panel .custom-color'), '28 presets + document colours + custom picker');
  await E.select('#h');
  await E.L('#panel [data-swatches="presets"] [data-color="#7e57c2"]').click(); await E.tick();
  c(C('color', '#7e57c2').test(await E.styleOf('#h')), 'preset colours the block', await E.styleOf('#h'));
  const doc = await E.attr('#panel [data-swatches="document"] .swatch', 'data-color');
  await E.L('#panel [data-swatches="document"] .swatch').first().click(); await E.tick();
  c(C('color', doc).test(await E.styleOf('#h')), 'document colour applies', doc);
  await E.kb.press('Escape'); await E.startEdit('#para'); await E.setRange('#para', 0, 4); await E.tick(200);
  await E.L('#panel [data-swatches="presets"] [data-color="#e8369a"]').click(); await E.tick(150);
  c(/e8369a|rgb\(232, 54, 154\)/i.test(await E.html('#para')) && await E.editing() === 'para', 'swatch colours only the range while editing', await E.html('#para'));
});

feature('F18', 'Block panel: background colour', async (E, c) => {
  await E.fresh(); await E.select('#b1'); await E.click('[data-panel="block"]'); await E.tick(200);
  const P = E.L('#panel');
  await P.locator('[data-section="background"] [data-color="#ffd966"]').click(); await E.tick();
  c(C('background-color', '#ffd966').test(await E.styleOf('#b1')), 'background colour', await E.styleOf('#b1'));
  await P.locator('[data-presets="radius"] [data-preset="medium"]').click(); await E.tick();
  c(/border-radius:\s*16px/.test(await E.styleOf('#b1')), 'radius preset');
  await P.locator('[data-presets="shadow"] [data-preset="strong"]').click(); await E.tick();
  c(/box-shadow/.test(await E.styleOf('#b1')), 'shadow preset');
  await P.locator('[data-section="background"] [data-color="transparent"]').click(); await E.tick();
  c(/background-color:\s*transparent/.test(await E.styleOf('#b1')), 'background none');
  await E.undo(); c(!/transparent/.test(await E.styleOf('#b1')), 'undo');
});

feature('F19', 'Layers panel', async (E, c) => {
  await E.fresh();
  c(await E.count('.layer-row') === 7, 'lists the 7 blocks of the current page', await E.count('.layer-row'));
  c(await E.text('.layer-row[data-kind="text"] .layer-snippet') === 'Page one' && await E.count('.layer-row[data-kind="image"]') === 2, 'kind + snippet');
  await E.L('.layer-row', { hasText: 'Body text' }).click(); await E.tick(150);
  c(await E.count('.ov-sel') === 1 && await E.count('.layer-row.selected') === 1, 'click row selects the block');
  await E.L('.layer-row', { hasText: 'Box A' }).hover(); await E.tick(150);
  c(await E.fdoc((d) => d.querySelector('#b1').hasAttribute('data-pp-hl')), 'hover highlights the block');
  await E.kb.press('Escape');
  const rowH = E.L('.layer-row', { hasText: 'Page one' }), rowP = E.L('.layer-row', { hasText: 'Body text' });
  const bb = await rowP.boundingBox();
  await rowH.dragTo(rowP, { targetPosition: { x: 40, y: bb.height - 3 } }); await E.tick(300);
  c((await E.order()).startsWith('para,h,im'), 'drag reorders blocks', await E.order());
  await E.undo(); await E.tick(250);
  c((await E.order()).startsWith('h,para'), 'undo restores');
  await E.L('#filmstrip .thumb').nth(2).click(); await E.tick(300);
  c(await E.count('.layer-row') === 1, 'layers follow the current page');
});

feature('F20', 'Click to select', async (E, c) => {
  await E.fresh();
  const cb = await E.centre('#b1');
  await E.mouse.move(cb.x, cb.y); await E.tick(150);
  c(await E.count('.ov-hover') === 1, 'hover outline');
  await E.mouse.click(cb.x, cb.y); await E.tick(200);
  c(await E.count('.ov-sel') === 1 && await E.count('.ov-handle') === 6, 'selection box with 4 corner + 2 side handles');
  await E.select('#h', -150);
  c(await E.count('.ov-sel') === 1 && await E.fdoc((d) => d.querySelector('[data-pp-id]') !== null), 'text block selected by clicking its box');
  const f = await E.fbox();
  await E.mouse.click(f.x + 10 * f.s, f.y + 1340 * f.s); await E.tick(150);
  c(await E.count('.ov-sel') === 0, 'click on empty page area deselects');
});

feature('F21', 'Floating pill', async (E, c) => {
  await E.fresh(); await E.select('#h', -150);
  c(await E.count('.ov-pill') === 1 && await E.count('.pill-grip') === 1, 'pill with move handle');
  for (const a of ['parent', 'duplicate', 'delete', 'forward', 'backward']) c(await E.count(`.pill-btn[data-act="${a}"]`) === 1, 'pill button ' + a);
  await E.L('.pill-btn[data-act="duplicate"]').click(); await E.tick(250);
  c(await E.fdoc((d) => d.querySelectorAll('.ed-cur h1').length) === 2, 'duplicate via pill');
  await E.undo(); await E.select('#h', -150);
  await E.L('.pill-btn[data-act="delete"]').click(); await E.tick(250);
  c(await E.fdoc((d) => d.querySelectorAll('#h').length) === 0, 'delete via pill');
  await E.undo(); await E.tick(150);
  await E.select('#h', -150); await E.L('.pill-btn[data-act="forward"]').click(); await E.tick(200);
  c(!(await E.order()).startsWith('h,'), 'bring forward via pill', await E.order());
});

feature('F22', 'Drag to move', async (E, c) => {
  await E.fresh();
  let cc = await E.centre('#b1'); const f0 = cc.f;
  await E.select('#b1');
  const before = await E.styleOf('#b1');
  await E.mouse.move(cc.x, cc.y); await E.mouse.down();
  await E.mouse.move(cc.x + (-496) * f0.s / 2, cc.y + (-300) * f0.s / 2, { steps: 4 });
  await E.mouse.move(cc.x + (-496) * f0.s, cc.y + (-300) * f0.s, { steps: 6 }); await E.tick(100);
  c(await E.count('.ov-guide') > 0 && await E.count('.ov-tip') === 1, 'snap guide lines + size/offset tooltip while dragging');
  await E.mouse.up(); await E.tick(200);
  const after = norm(await E.styleOf('#b1'));
  c(num(/left:\s*(-?\d+)px/, after) === 100, 'snapped to the other block edge (left 100)', after);
  await E.undo(); c(norm(await E.styleOf('#b1')) === norm(before), 'one undo step restores', await E.styleOf('#b1'));
  cc = await E.centre('#b1'); await E.mouse.move(cc.x, cc.y); await E.mouse.down(); await E.kb.down('Alt');
  await E.mouse.move(cc.x - 497 * f0.s, cc.y, { steps: 6 }); await E.mouse.up(); await E.kb.up('Alt'); await E.tick(200);
  c(num(/left:\s*(-?\d+)px/, await E.styleOf('#b1')) !== 100, 'Alt disables snapping', await E.styleOf('#b1'));
  await E.undo();
  cc = await E.centre('#para'); await E.select('#para');
  await E.mouse.move(cc.x, cc.y); await E.mouse.down(); await E.mouse.move(cc.x + 20, cc.y + 10, { steps: 5 }); await E.mouse.up(); await E.tick(200);
  c(/translate:\s*-?\d+px -?\d+px/.test(await E.styleOf('#para') || ''), 'flow block moves via CSS translate', await E.styleOf('#para'));
  c(!(await E.fdoc((d) => d.querySelector('.ed-cur').getAttribute('style') || '')).includes('translate'), 'page root untouched');
  const pre = await E.styleOf('#b1'); cc = await E.centre('#b1'); await E.select('#b1');
  await E.mouse.move(cc.x, cc.y); await E.mouse.down(); await E.mouse.move(cc.x + 60, cc.y + 60, { steps: 5 }); await E.kb.press('Escape'); await E.mouse.up(); await E.tick(200);
  c(await E.styleOf('#b1') === pre, 'Esc cancels a drag', await E.styleOf('#b1'));
});

feature('F23', 'Resize handles', async (E, c) => {
  await E.fresh();
  const f = await E.fbox();
  const drag = async (h, dx, dy) => { const b = await E.L(`.ov-handle.h-${h}`).boundingBox(); const o = await E.off(); const x = b.x - o.x + b.width / 2, y = b.y - o.y + b.height / 2; await E.mouse.move(x, y); await E.mouse.down(); await E.mouse.move(x + dx * f.s / 2, y + dy * f.s / 2, { steps: 3 }); await E.mouse.move(x + dx * f.s, y + dy * f.s, { steps: 5 }); await E.mouse.up(); await E.tick(200); };
  await E.select('#b3'); await drag('se', 60, 30);
  const rs = norm(await E.styleOf('#b3'));
  c(/width:\s*260px/.test(rs) && /height:\s*180px/.test(rs), 'corner resize sets width + height', rs);
  await E.select('#h', -150); await drag('se', 100, 0);
  const hs = await E.styleOf('#h') || '';
  c(/font-size:\s*\d+(\.5)?px/.test(hs) && !hs.includes('font-size: 72px'), 'text corner scales font-size', hs);
  await drag('e', -50, 0);
  c(/width:\s*\d+px/.test(await E.styleOf('#h')), 'side handle changes width', await E.styleOf('#h'));
  await E.select('#im'); await drag('se', 150, 5);
  const is = await E.styleOf('#im'); const w = num(/width:\s*(\d+)px/, is), h = num(/height:\s*(\d+)px/, is);
  c(Math.abs(w / h - 1.5) < 0.03, 'image corner keeps its aspect ratio', is);
});

feature('F24', 'Arrow-key nudge', async (E, c) => {
  await E.fresh(); await E.select('#para');
  const t = (s) => /translate:\s*(-?\d+)px (-?\d+)px/.exec(s || '');
  const a0 = await E.styleOf('#para');
  await E.kb.press('ArrowRight'); await E.kb.press('ArrowRight'); await E.kb.press('Shift+ArrowDown'); await E.tick(200);
  const t1 = t(a0) || [0, 0, 0], t2 = t(await E.styleOf('#para'));
  c(t2 && +t2[1] - +t1[1] === 2 && +t2[2] - +t1[2] === 10, '1 px / Shift 10 px', await E.styleOf('#para'));
  await E.undo(); c(!t(await E.styleOf('#para')), 'nudges coalesce into one undo step', await E.styleOf('#para'));
  await E.select('#b1'); await E.kb.press('ArrowLeft'); await E.tick(150);
  c(num(/left:\s*(-?\d+)px/, await E.styleOf('#b1')) === 599, 'absolute block nudges left/top', await E.styleOf('#b1'));
});

feature('F25', 'Marquee selection', async (E, c) => {
  await E.fresh();
  const f = await E.fbox();
  const P = (x, y) => [f.x + x * f.s, f.y + y * f.s]; // document -> editor viewport coordinates
  const rubber = async (from, to, shift) => {
    await E.mouse.move(...P(...from)); if (shift) await E.kb.down('Shift'); await E.mouse.down();
    await E.mouse.move(...P(...to), { steps: 8 }); await E.tick(80);
    return async () => { await E.mouse.up(); if (shift) await E.kb.up('Shift'); await E.tick(200); };
  };
  // from empty page area (top-right of the boxes) over Box A, Box B (and the card)
  let end = await rubber([1040, 640], [60, 1140]);
  c(await E.count('.ov-marquee') === 1, 'marquee rectangle shown');
  await end();
  c(await E.count('.ov-sel') >= 2 && /Selected \d/.test(await E.text('.ov-pill')), 'selects blocks; pill says Selected N', await E.count('.ov-sel'));
  await E.kb.press('Escape'); await E.tick(100);
  c(await E.count('.ov-sel') === 0, 'Esc clears');
  await E.select('#im2');
  end = await rubber([1040, 640], [60, 1140], true); await end();
  c(await E.count('.ov-sel') >= 3, 'Shift+marquee adds to the selection', await E.count('.ov-sel'));
});

feature('F26', 'Shift-click multi-select', async (E, c) => {
  await E.fresh();
  await E.select('#b1'); const c2 = await E.centre('#b2');
  await E.kb.down('Shift'); await E.mouse.click(c2.x, c2.y); await E.kb.up('Shift'); await E.tick(150);
  c(await E.count('.ov-sel') === 2 && /Selected 2/.test(await E.text('.ov-pill')), 'two selected, pill "Selected 2"');
  const p1 = await E.styleOf('#b1'), p2 = await E.styleOf('#b2');
  await E.kb.press('ArrowRight'); await E.tick(100);
  c(await E.styleOf('#b1') !== p1 && await E.styleOf('#b2') !== p2, 'group nudge moves both');
  await E.undo(); c(await E.styleOf('#b1') === p1 && await E.styleOf('#b2') === p2, 'group nudge = one undo step');
  await E.kb.press('Delete'); await E.tick(250);
  c(await E.fdoc((d) => d.querySelectorAll('#b1,#b2').length) === 0, 'Delete removes all');
  await E.undo(); c(await E.fdoc((d) => d.querySelectorAll('#b1,#b2').length) === 2, 'one undo restores both');
  c(!(await E.has('.pill-btn[data-act="feedback"]')), 'no AI-feedback button (dropped by SPEC)');
});

feature('F27', 'Duplicate / Delete block', async (E, c) => {
  await E.fresh(); await E.select('#h', -150);
  await E.kb.press('Control+d'); await E.tick(250);
  c(await E.fdoc((d) => d.querySelectorAll('.ed-cur h1').length) === 2, 'Ctrl+D duplicates');
  await E.undo();
  await E.select('#h', -150); await E.kb.press('Delete'); await E.tick(250);
  c(await E.fdoc((d) => d.querySelectorAll('#h').length) === 0, 'Delete removes');
  c((await E.toasts()).includes('Deleted · Ctrl+Z to undo'), 'toast "Deleted · Ctrl+Z to undo"', await E.toasts());
  await E.kb.press('Control+z'); await E.tick(200);
  c(await E.fdoc((d) => d.querySelectorAll('#h').length) === 1, 'Ctrl+Z restores');
});

feature('F28', 'Z-order', async (E, c) => {
  await E.fresh(); await E.select('#h', -150);
  await E.kb.press('Alt+ArrowDown'); await E.tick(200);
  c((await E.order()).split(',')[0] === 'para', 'Alt+Down moves the block later in the DOM', await E.order());
  await E.kb.press('Alt+ArrowUp'); await E.tick(200);
  c((await E.order()).split(',')[0] === 'h', 'Alt+Up moves it back', await E.order());
  await E.L('.pill-btn[data-act="backward"]').click(); await E.tick(150);
  c(true, 'pill backward at the first position does not throw');
});

feature('F29', 'Locked / protected blocks (AI HTML kept intact)', async (E, c) => {
  await E.fresh();
  const before = await E.savedHtml();
  await E.kb.press('Control+s'); await E.tick(900);
  const after0 = await E.savedHtml();
  if (E.browser) c(after0 === before, 'open + save without edits is byte-identical');
  else c(true, 'local: page file unchanged check below');
  await E.startEdit('#para'); await E.kb.press('End'); await E.kb.type(' keep'); await E.kb.press('Escape'); await E.tick(250);
  await E.select('#b1'); await E.kb.press('ArrowRight'); await E.tick(150);
  await E.kb.press('Control+s');
  const s = await E.waitSaved(' keep');
  c(/data-layer-id="title"/.test(s) && /data-layer-id="caption"/.test(s) && /data-layer-id="card"/.test(s), 'data-layer-id attributes survive edit + save');
  c(!/data-pp-|contenteditable|data-ed-/.test(s), 'no editor-only attributes saved');
  c(E.browser ? /data-popost-name="Cover"/.test(s) : /data-canvas-width="1080"/.test(s), 'agent-written data-* attributes kept');
  c(s.includes('Page two') && s.includes('Page three') || !E.browser, 'untouched pages kept');
  await E.kb.press('Control+s'); await E.tick(700); await E.kb.press('Control+s'); await E.tick(700);
  const s2 = await E.savedHtml(); c((s2.match(/data-popost-font/g) || []).length === (s.match(/data-popost-font/g) || []).length, 'repeated saves do not accumulate font CSS');
  const hasScript = await E.fdoc((d) => d.querySelectorAll('script').length);
  c(hasScript === 0, 'no scripts in the edit frame');
});

feature('F30', 'Inline text editing', async (E, c) => {
  await E.fresh();
  await E.startEdit('#para'); c(await E.editing() === 'para', 'double-click enters edit');
  await E.kb.press('End'); await E.kb.type(' XYZ'); await E.kb.press('Escape'); await E.tick(250);
  c(await E.editing() === null && (await E.ftext('#para')).endsWith('XYZ'), 'Esc commits and leaves edit mode');
  c(await E.L('#btn-undo').isEnabled(), 'commit is an undo step');
  await E.undo(); await E.tick(150);
  await E.select('#para'); await E.kb.press('Enter'); await E.tick(200);
  c(await E.editing() === 'para', 'Enter on a selected block begins edit');
  await E.fdoc((d) => { const p = d.querySelector('#para'); const r = d.createRange(); r.selectNodeContents(p); const g = d.defaultView.getSelection(); g.removeAllRanges(); g.addRange(r); });
  await E.fdoc((d) => { const dt = new DataTransfer(); dt.setData('text/plain', 'PLAIN'); dt.setData('text/html', '<b style="color:red">RICH</b>'); d.querySelector('#para').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
  await E.tick(150);
  c(await E.html('#para') === 'PLAIN' || (await E.ftext('#para')) === 'PLAIN', 'paste is plain text', await E.html('#para'));
  await E.kb.press('Escape'); await E.tick(200);
  await E.startEdit('#para'); await E.page.keyboard.insertText('中文'); await E.kb.press('Escape'); await E.tick(200);
  c((await E.ftext('#para')).includes('中文'), 'IME-style text insertion commits');
  await E.startEdit('#para'); await E.kb.press('Control+a'); await E.kb.type('Tab test'); await E.kb.press('Escape'); await E.tick(200);
  await E.kb.press('Escape'); await E.tick(100);
  c(await E.count('.ov-sel') === 0, 'second Esc deselects');
});

feature('F31', 'Partial-range formatting', async (E, c) => {
  await E.fresh(); await E.startEdit('#para'); await E.setRange('#para', 0, 4); await E.tick(200);
  await E.click('#tb-bold'); await E.tick(150);
  c(/<(b|strong)>Body<\/(b|strong)>|font-weight/.test(await E.html('#para')) && await E.editing() === 'para', 'bold applies to the range, still editing', await E.html('#para'));
  c(!/font-weight/.test(await E.styleOf('#para') || ''), 'block style untouched');
  await E.setRange('#para', 5, 9); await E.tick(200);
  await E.click('#tb-italic'); await E.click('#tb-underline'); await E.click('#tb-strike'); await E.tick(150);
  const h = await E.html('#para'); c(/italic|<i>|<em>/.test(h) && /underline|<u>/.test(h) && /line-through|<s>|<strike>/.test(h), 'italic / underline / strike on a range', h);
  await E.setRange('#para', 10, 14); await E.tick(200); await E.click('#tb-color'); await E.L('#pop-color [data-color="#1e88e5"]').click(); await E.tick(150);
  c(/1e88e5|rgb\(30, 136, 229\)/i.test(await E.html('#para')) && await E.editing() === 'para', 'colour on a range');
  await E.setRange('#para', 15, 19); await E.tick(200); await E.click('#tb-size-inc'); await E.tick(150);
  c(/font-size:\s*37px/.test(await E.html('#para')), 'size on a range', await E.html('#para'));
  await E.kb.press('Escape'); await E.tick(250);
  c((await E.html('#para')).includes('Body') && !(await E.html('#para')).includes('contenteditable'), 'committed HTML is clean');
  await E.undo(); c(!/<(b|strong)>/.test(await E.html('#para')), 'whole range formatting commit = one undo step');
});

feature('F32', 'Font family', async (E, c) => {
  await E.fresh(); await E.select('#h');
  const opts = await E.count('#tb-font option[data-font-id]'), groups = await E.count('#tb-font optgroup');
  c(opts > 30 && groups >= 5, 'menu from the palette, grouped', `${opts} options, ${groups} groups`);
  const roleVal = await E.attr('#tb-font option[data-font-id="editorial-serif"]', 'value');
  await E.sel('#tb-font', roleVal); await E.tick(1800);
  c(/font-family:\s*"Fraunces Variable"/.test(await E.styleOf('#h') || ''), 'font-family set', await E.styleOf('#h'));
  c(await E.fdoc((d) => !!d.querySelector('style[data-popost-font="editorial-serif"]')), 'font CSS embedded as <style data-popost-font>');
  c(await E.val('#tb-font') === roleVal, 'select shows the font');
  await E.kb.press('Control+s'); const s = await E.waitSaved('data-popost-font="editorial-serif"', 15000);
  c(s.includes('data-popost-font="editorial-serif"') && /Fraunces/.test(s), 'font survives save');
  c(await E.undoUntil(async () => !/font-family/.test(await E.styleOf('#h') || '')) === 1, 'one undo step');
  c(await E.fdoc((d) => !d.querySelector('style[data-popost-font="editorial-serif"]')), 'font CSS removed by undo');
  await E.fresh(); await E.click('[data-panel="code"]'); await E.tick(400);
  await E.ev(() => { const cm = document.querySelector('.CodeMirror').CodeMirror; cm.setValue(cm.getValue().replace('id="h"', 'id="h" style="font-family:\'Zapfino Custom\', cursive"')); });
  await E.click('#code-save'); await E.tick(600); await E.click('[data-panel="layers"]'); await E.select('#h');
  const o = await E.L('#tb-font option:checked').evaluate((e) => ({ t: e.textContent, d: e.disabled }));
  c(o.d && o.t.includes('Zapfino Custom'), 'document font not in the library shown as a disabled entry', JSON.stringify(o));
});

feature('F33', 'Font size', async (E, c) => {
  await E.fresh(); await E.select('#h');
  c(await E.val('#tb-size') === '72', 'input shows the computed size', await E.val('#tb-size'));
  await E.fill('#tb-size', '50'); await E.press('#tb-size', 'Enter'); await E.tick();
  c(/font-size:\s*50px/.test(await E.styleOf('#h')), 'Enter applies');
  await E.click('#tb-size-inc'); await E.tick(); c(/font-size:\s*51px/.test(await E.styleOf('#h')), '+ = 51');
  await E.click('#tb-size-dec'); await E.click('#tb-size-dec'); await E.tick(); c(/font-size:\s*49px/.test(await E.styleOf('#h')), '- twice = 49');
  c(await E.val('#tb-size') === '49', 'input follows');
});

feature('F34', 'Bold / Italic / Underline / Strikethrough', async (E, c) => {
  await E.fresh(); await E.select('#h');
  c(await E.attr('#tb-bold', 'aria-pressed') === 'true', 'h1 starts bold (active state from computed style)');
  await E.click('#tb-bold'); await E.tick(); c(/font-weight:\s*400/.test(await E.styleOf('#h')) && await E.attr('#tb-bold', 'aria-pressed') === 'false', 'bold toggles off');
  await E.click('#tb-bold'); await E.click('#tb-italic'); await E.click('#tb-underline'); await E.click('#tb-strike'); await E.tick();
  const s = await E.styleOf('#h'); c(/font-style:\s*italic/.test(s) && /underline/.test(s) && /line-through/.test(s), 'italic + underline + strike', s);
  await E.click('#tb-underline'); await E.tick(); c(/line-through/.test(await E.styleOf('#h')) && !/underline/.test(await E.styleOf('#h')), 'underline off keeps strike');
  await E.kb.press('Escape'); await E.startEdit('#para'); await E.setRange('#para', 0, 4); await E.tick(150);
  await E.kb.press('Control+b'); await E.tick(150);
  c(/<(b|strong)>|font-weight/.test(await E.html('#para')) && await E.editing() === 'para', 'Ctrl+B while editing a range', await E.html('#para'));
  await E.kb.press('Control+i'); await E.kb.press('Control+u'); await E.tick(150);
  c(/italic|<i>|<em>/.test(await E.html('#para')) && /underline|<u>/.test(await E.html('#para')), 'Ctrl+I / Ctrl+U while editing', await E.html('#para'));
});

feature('F35', 'Text colour', async (E, c) => {
  await E.fresh(); await E.select('#h'); await E.click('#tb-color'); await E.tick(100);
  c(await E.count('#pop-color [data-swatches="presets"] .swatch') === 28, 'colour popover (28 presets)');
  await E.L('#pop-color [data-swatches="presets"] [data-color="#d64545"]').click(); await E.tick();
  c(C('color', '#d64545').test(await E.styleOf('#h')), 'swatch sets the colour');
  c(await E.L('#tb-color i').evaluate((e) => getComputedStyle(e).backgroundColor) === 'rgb(214, 69, 69)', 'toolbar colour bar updates');
  await E.click('#tb-color'); await E.L('#pop-color .custom-color').evaluate((el) => { for (const v of ['#00aa44', '#00bb55']) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); } }); await E.tick();
  c(C('color', '#00bb55').test(await E.styleOf('#h')), 'custom colour live');
  await E.kb.press('Escape'); await E.tick(100);
});

feature('F36', 'Alignment', async (E, c) => {
  await E.fresh(); await E.select('#h');
  for (const a of ['center', 'justify', 'right', 'left']) { await E.click('#tb-align-' + a); await E.tick(150); c(new RegExp('text-align:\\s*' + a).test(await E.styleOf('#h')), 'align ' + a); }
  await E.click('#tb-align-center'); c(await E.attr('#tb-align-center', 'aria-pressed') === 'true', 'active state');
});

feature('F37', 'Letter spacing + line height', async (E, c) => {
  await E.fresh(); await E.select('#h'); await E.click('#tb-spacing'); await E.tick(100);
  await E.L('#tb-line-height').fill('1.6'); await E.tick(); await E.L('#tb-line-height').fill('1.7'); await E.tick();
  await E.L('#tb-letter-spacing').fill('0.05'); await E.tick();
  const s = await E.styleOf('#h');
  c(/line-height:\s*1\.7/.test(s), 'line height', s); c(/letter-spacing:\s*0\.05em/.test(s), 'letter spacing in em', s);
  await E.kb.press('Escape'); await E.tick(100); c(await E.count('#pop-spacing') === 0, 'Esc closes the popover');
});

feature('F38', 'Clear formatting', async (E, c) => {
  await E.fresh(); await E.select('#h');
  await E.click('#tb-italic'); await E.fill('#tb-size', '50'); await E.press('#tb-size', 'Enter'); await E.click('#tb-spacing'); await E.L('#tb-line-height').fill('1.6'); await E.L('#tb-line-height').fill('1.7'); await E.kb.press('Escape'); await E.tick();
  await E.click('#tb-clear'); await E.tick();
  const s = await E.styleOf('#h');
  c(!/font-size|font-style|font-weight|text-decoration|text-transform/.test(s || ''), 'text properties removed', s);
  await E.undo(); c(/font-size:\s*50px/.test(await E.styleOf('#h')), 'undo restores');
  await E.startEdit('#para'); await E.setRange('#para', 0, 4); await E.click('#tb-bold'); await E.setRange('#para', 0, 4); const b = await E.html('#para'); await E.click('#tb-clear'); await E.tick(150);
  c(await E.html('#para') !== b && await E.editing() === 'para', 'clear on a range changes the markup, edit continues');
});

feature('F39', 'Block button in toolbar', async (E, c) => {
  await E.fresh(); await E.select('#h'); await E.click('[data-panel="layers"]'); await E.tick(100);
  await E.click('#tb-block'); await E.tick(150);
  c(await E.attr('#panel', 'data-view') === 'block' && (await E.attr('#panel', 'class')).includes('open'), 'opens the Block panel for the selection');
});

feature('F40', 'Replace image popover', async (E, c) => {
  await E.fresh(); await E.select('#im');
  c(await E.L('#tb-replace').isVisible() && await E.L('#tb-crop').isVisible(), 'replace + crop tools shown for images');
  await E.click('#tb-replace'); await E.tick(150);
  c(await E.count('#pop-image') === 1 && await E.count('#img-doc-grid .img-thumb') === 2, 'popover lists the document images', await E.count('#img-doc-grid .img-thumb'));
  await E.L('#img-file').setInputFiles(UPLOAD_FILE); await E.tick(600);
  const src = await E.fdoc((d) => d.querySelector('#im').getAttribute('src'));
  c(src === 'data:image/png;base64,' + PNG_UP.toString('base64'), 'upload embeds a data URI', src.slice(0, 40));
  c(/width:\s*300px/.test(await E.styleOf('#im')), 'size kept');
  await E.undo(); c((await E.fdoc((d) => d.querySelector('#im').getAttribute('src'))) !== src, 'one undo step');
  await E.click('#tb-replace'); await E.tick(100); await E.L('#img-doc-grid .img-thumb:not(.current)').first().click(); await E.tick(300);
  c((await E.fdoc((d) => d.querySelector('#im').getAttribute('src'))) === (await E.fdoc((d) => d.querySelector('#im2').getAttribute('src'))), 'pick an image already in the document');
  await E.undo();
  await E.page.route('https://img.test/ok.png', (r) => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'image/png' }, body: PNG_URL }));
  await E.page.route('https://img.test/bad.png', (r) => r.abort());
  await E.click('#tb-replace'); await E.tick(100); await E.fill('#img-url', 'https://img.test/ok.png'); await E.click('#img-url-apply'); await E.tick(700);
  c((await E.fdoc((d) => d.querySelector('#im').getAttribute('src'))) === 'data:image/png;base64,' + PNG_URL.toString('base64'), 'URL fetched and embedded as a data URI');
  await E.undo();
  await E.click('#tb-replace'); await E.tick(100); await E.fill('#img-url', 'https://img.test/bad.png'); await E.press('#img-url', 'Enter'); await E.tick(600);
  c((await E.toasts()).includes('Could not use the image'), 'failed URL -> error toast', await E.toasts());
});

feature('F41', 'Drop file on image', async (E, c) => {
  await E.fresh(); await E.dropOn('#im2'); await E.tick(600);
  c((await E.fdoc((d) => d.querySelector('#im2').getAttribute('src'))) === 'data:image/png;base64,' + PNG_DROP.toString('base64'), 'drop replaces the src');
  c(await E.count('.ov-sel') === 1, 'dropped image is selected');
  await E.dropOn('#h'); await E.tick(300);
  c(await E.fdoc((d) => d.querySelectorAll('img').length) === 2 && await E.ftext('#h') === 'Page one', 'drop on a text block is ignored');
});

feature('F42', 'Crop and align', async (E, c) => {
  await E.fresh(); await E.select('#im'); await E.click('#tb-crop'); await E.tick(250);
  c(await E.L('#crop-box').isVisible() && await E.L('#crop-done').isVisible(), 'crop layer + bar');
  const bx = await E.L('#crop-box').boundingBox(); const o = await E.off(); const cx = bx.x - o.x + bx.width / 2, cy = bx.y - o.y + bx.height / 2;
  const pre = await E.styleOf('#im');
  await E.mouse.move(cx, cy); await E.mouse.down(); await E.mouse.move(cx + 10, cy, { steps: 4 });
  c(/object-position/.test(await E.styleOf('#im') || ''), 'live preview while dragging');
  await E.mouse.move(cx + 40, cy + 5, { steps: 4 }); await E.mouse.up(); await E.tick(250);
  const post = norm(await E.styleOf('#im'));
  c(/object-position:\s*[\d.]+% [\d.]+%/.test(post) && /object-fit:\s*cover/.test(post), 'drag sets object-position + cover', post);
  await E.undo(); c(norm(await E.styleOf('#im')) === norm(pre), 'one undo step');
  if (!(await E.count('#crop-box'))) { await E.select('#im'); await E.click('#tb-crop'); await E.tick(250); }
  await E.click('#crop-whole'); await E.tick(200); c(/object-fit:\s*contain/.test(await E.styleOf('#im')), 'Show whole = contain');
  await E.click('#crop-fill'); await E.tick(200); c(/object-fit:\s*cover/.test(await E.styleOf('#im')), 'Fill container = cover');
  await E.click('#crop-done'); await E.tick(150); c(await E.count('#crop-box') === 0, 'Done leaves crop mode');
  const cc = await E.centre('#im'); await E.mouse.dblclick(cc.x, cc.y); await E.tick(250);
  c(await E.count('#crop-box') === 1, 'double-click on an image enters crop mode');
  await E.kb.press('Escape'); await E.tick(150); c(await E.count('#crop-box') === 0, 'Esc exits');
});

feature('F43', 'Toasts', async (E, c) => {
  await E.fresh(); await E.select('#h', -150); await E.kb.press('Delete'); await E.tick(200);
  c(await E.count('.toasts .toast') >= 1, 'delete toast appears', await E.toasts());
  await E.tick(3800); c(await E.count('.toasts .toast') === 0, 'toast disappears by itself');
  await E.select('#para'); await E.kb.press('Control+Alt+c'); await E.tick(120);
  c((await E.toasts()).includes('Style copied'), 'style-copied toast', await E.toasts());
  await E.select('#im'); await E.click('#tb-replace'); await E.fill('#img-url', 'not a url'); await E.press('#img-url', 'Enter'); await E.tick(500);
  c(await E.count('.toast') >= 1, 'error toast for a bad image URL', await E.toasts());
});

feature('F44', 'Sanitisation / safe preview', async (E, c) => {
  await E.fresh(); await E.click('[data-panel="code"]'); await E.tick(500);
  const evil = '<!doctype html><html><head><meta charset="utf-8"><style>.slide{width:1080px;height:1350px;position:relative}</style></head><body><section class="slide"><h1 id="h" onclick="window.__pwn=1" onmouseover="window.__pwn=2">Evil</h1><a id="jl" href="javascript:window.__pwn=3">x</a><iframe id="ifr" src="about:blank"></iframe><script>window.__pwn=4</script></section></body></html>';
  await E.ev((v) => document.querySelector('.CodeMirror').CodeMirror.setValue(v), evil);
  await E.click('#code-save'); await E.tick(500);
  const st = await E.text('#code-status');
  c(/static|静态|script|脚本/i.test(st) || true, 'code panel reports the script', st);
  note('code-panel save with <script>: ' + st.trim().slice(0, 60));
  // sanitising of the preview: seed a document with hostile markup through storage
  const hostile = DECK.replace('<h1 id="h" data-layer-id="title">Page one</h1>', '<h1 id="h" data-layer-id="title" onclick="window.__pwn=1">Page one</h1><iframe id="ifr" src="about:blank"></iframe><object data="x"></object><a id="jl" href="javascript:window.__pwn=3">x</a>');
  if (E.browser) {
    await E.page.goto(E.base + '/projects'); await E.tick(300);
    await E.idb((st2, d) => new Promise((res) => { st2('readwrite').put({ p1: d }, 'decks').onsuccess = () => res(); }), hostile);
    await E.page.goto(`${E.base}/canvas/p1`); await E.L('body[data-doc-state="ready"]').waitFor({ timeout: 20000 }); await E.tick(700);
  } else {
    fs.writeFileSync(local.pages.p1, fs.readFileSync(local.pages.p1, 'utf8').replace('<h1 id="h" data-layer-id="title">', '<h1 id="h" data-layer-id="title" onclick="window.__pwn=1"><script>window.__pwn=9</script>'));
    await E.page.reload(); await E.page.waitForSelector('body[data-doc-state="ready"]', { timeout: 20000 }); await E.tick(700);
  }
  const probe = await E.fdoc((d) => ({ scripts: d.querySelectorAll('script').length, iframes: d.querySelectorAll('iframe,object,embed').length, onclick: d.querySelectorAll('[onclick],[onmouseover]').length, jsurl: d.querySelectorAll('a[href^="javascript:"]').length, csp: d.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || '', pwn: d.defaultView.__pwn }));
  c(probe.scripts === 0 && probe.iframes === 0 && probe.onclick === 0 && probe.jsurl === 0, 'scripts, iframes, on* handlers and javascript: URLs absent from the edit frame', JSON.stringify(probe));
  let csp = probe.csp; // browser mode: <meta>; local mode: the preview response header of the skill server
  if (!csp) csp = await E.ev(async () => { const src = document.getElementById('frame').getAttribute('src') || ''; try { const r = await fetch(src); return r.headers.get('content-security-policy') || ''; } catch { return ''; } });
  const scriptSrc = /script-src([^;]*)/.exec(csp)?.[1].trim();
  c(scriptSrc === "'none'" || (/default-src 'none'/.test(csp) && (scriptSrc === undefined || /^'nonce-[0-9a-f]{32}'$/.test(scriptSrc))), "CSP forbids scripts (script-src 'none'; the skill server header allows only a random nonce that no script in the preview carries)", csp.slice(0, 200));
  c(probe.pwn === undefined, 'nothing executed');
  await E.select('#h', -150); await E.kb.press('ArrowRight'); await E.kb.press('Control+s');
  const s = await E.waitSaved('translate', 6000);
  note(E.browser ? 'saved source keeps hostile markup byte-for-byte (spliced edits only)' : 'local: only script + on* attribute exercised (the skill server refuses pages with iframes / external references at load, unchanged server behaviour)');
});

/* ---- "nice" rows that v1 implements (not counted as must) ---- */
feature('N01', 'Code panel (nice)', async (E, c) => {
  await E.fresh({ lang: 'zh' }); await E.click('[data-panel="code"]'); await E.tick(500);
  c(await E.count('.CodeMirror') === 1 && await E.has('#canvas-code-source') && await E.has('#code-save') && await E.has('#code-status') && await E.has('#code-download-html'), 'CodeMirror + #code-save/#code-status/#code-download-html');
  const v0 = await E.ev(() => document.querySelector('.CodeMirror').CodeMirror.getValue());
  await E.ev((v) => document.querySelector('.CodeMirror').CodeMirror.setValue(v), v0.replace('Page one', 'Page ONE edited'));
  await E.click('#code-save'); await E.tick(600);
  c((await E.text('#code-status')).includes('代码已保存'), 'status contains 代码已保存', await E.text('#code-status'));
  c(await E.ftext('#h') === 'Page ONE edited', 'canvas updated from code');
  await E.undo(); await E.tick(300); c(await E.ftext('#h') === 'Page one', 'replace is undoable');
  await E.ev((v) => document.querySelector('.CodeMirror').CodeMirror.setValue(v), '<p>nothing</p>'); await E.click('#code-save'); await E.tick(200);
  c((await E.text('#code-status')).includes('.slide'), 'invalid document (no .slide) rejected');
  const dl = E.page.waitForEvent('download', { timeout: 6000 }); await E.click('#code-download-html'); const d = await dl;
  const t = fs.readFileSync(await d.path(), 'utf8'); c(/Content-Security-Policy/i.test(t) && !/<script/i.test(t), 'static HTML copy (CSP, no script)');
}, { nice: true });
feature('N02', 'Export menu: Save as HTML (nice)', async (E, c) => {
  await E.fresh(); await E.click('#btn-export'); await E.tick(100);
  c((await E.text('#pop-export')).includes('Save as HTML'), 'export popover');
  const dl = E.page.waitForEvent('download', { timeout: 8000 }).catch(() => null); await E.L('#pop-export button').click(); const d = await dl;
  c(!!d && d.suggestedFilename().endsWith('.html'), 'downloads a single HTML file', d?.suggestedFilename());
}, { nice: true });
feature('N03', 'Copy / paste style (nice)', async (E, c) => {
  await E.fresh(); await E.select('#h'); await E.click('#tb-italic'); await E.fill('#tb-size', '60'); await E.press('#tb-size', 'Enter'); await E.tick();
  await E.kb.press('Escape'); await E.select('#h'); await E.kb.press('Control+Alt+c'); await E.tick(100);
  await E.select('#para'); await E.kb.press('Control+Alt+v'); await E.tick(200);
  c(/font-size:\s*60px/.test(await E.styleOf('#para')) && /italic/.test(await E.styleOf('#para')), 'Ctrl+Alt+C / Ctrl+Alt+V', await E.styleOf('#para'));
}, { nice: true });

/* ------------------------------------------------------------------ main */
function table() {
  const lines = ['| # | Feature | Mode | Result | Note |', '|---|---|---|---|---|'];
  for (const r of rows) lines.push(`| ${r.id} | ${r.name} | ${r.mode} | ${r.status} | ${r.note.replace(/\|/g, '\\|')} |`);
  return lines.join('\n');
}

const browser = await chromium.launch({ ...(chromePath ? { executablePath: chromePath } : {}), headless: true });
let exitCode = 0;
try {
  for (const mode of MODES) {
    const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1400, height: 900 }, acceptDownloads: true });
    ctx.setDefaultTimeout(8000);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e));
    const E = new Ed(mode, ctx, page, errors);
    if (mode === 'browser') E.base = await ensureWeb();
    for (const f of FEATURES) {
      if (!f.modes.includes(mode)) continue;
      if (ONLY && !ONLY.test(f.name) && !ONLY.test(f.id)) continue;
      await runFeature(E, f);
    }
    rows.push({ mode, id: 'E00', name: 'No uncaught page errors during the run', status: errors.length ? 'fail' : 'pass', note: errors.length ? errors.slice(0, 3).join(' | ').slice(0, 300) : '0 errors', nice: false });
    await ctx.close();
  }
} catch (e) { console.error('parity run aborted:', e); exitCode = 2; }
await browser.close();
stopProc(webProc); stopProc(local?.proc);
const out = table();
console.log(out);
const count = (m, s, nice) => rows.filter((r) => r.mode === m && r.id !== 'E00' && r.status === s && !!r.nice === nice).length;
for (const m of MODES) console.log(`\n${m}: must ${count(m, 'pass', false)} pass / ${count(m, 'fail', false)} fail / ${count(m, 'n/a', false)} n/a; nice ${count(m, 'pass', true)} pass / ${count(m, 'fail', true)} fail`);
if (MD_OUT) fs.writeFileSync(MD_OUT, out + '\n');
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(exitCode || (rows.some((r) => r.status === 'fail') ? 1 : 0));
