# Current editor: external contracts (clean-room inventory)

> **Path note (2026-11-01).** This is a historical record written before the repository was restructured. Paths in it refer to the old Popost-ai layout: `src/`, `public/`, `index.html` → `apps/web/…`; `editor/` → `packages/canvas-editor/`; `PROGRESS.md` → `docs/history/oss-cleanup-progress.md`; `docs/后端接口对接说明.md` → `docs/backend/integration-contracts.zh-CN.md`. Line numbers may have drifted. Later the same day `apps/web/` and `docs/backend/` were removed from this repository (it now holds only the skill and the canvas editor); the web app is part of the popost.ai website.

Scope: every contract that code OUTSIDE the editor (web app, Python skill, build scripts, tests, user data on disk or in IndexedDB) relies on today, for the canvas editor vendored at `public/vendor/html-deck/` (byte-identical copy in `skills/popost/assets/editor/`, plus `shared-source.json`).

Rules of this document: contracts only (names, parameters, shapes, semantics, timing) with `file:line` citations. No html-deck source is reproduced. Paths are relative to the repo root `Popost-ai/`. "Editor dir" = `public/vendor/html-deck/` (abbreviated `HD/`). Line numbers were taken from the tree as read on 2026-10-30 (branch `chore/oss-cleanup`).

Product-team files (may be ported verbatim): `HD/js/services/browser-storage.mjs`, `local-api.mjs`, `font-library.mjs`, `HD/js/ui/canvas-download.mjs`, `HD/js/ui/panels/code.mjs`, `HD/css/popost.css`, `HD/css/v35-surface.css`, and the Popost patches inside `HD/js/services/api.mjs`, `HD/js/editor/state.mjs`, `HD/js/editor/document.mjs`, `HD/index.html` (head script, lines 8-13). Everything else under `HD/` is upstream html-deck and must be re-implemented, not copied.

Contents

1. Web app embedding
2. Shared browser storage
3. Browser-mode API emulation
4. Local skill mode
5. Document/markup contract
6. Exports
7. Fonts
8. Build and packaging touchpoints
9. Tests touching the editor
10. Compatibility checklist (must-keep, and accidental/unsafe)

---

## 1. Web app embedding

Files: `src/components/CanvasPanel.tsx` (20 lines, the only embedder), `src/components/TaskWorkbench.tsx:26` (mounts `CanvasPanel embedded`), `src/pages/CanvasPage.tsx:3` (mounts `CanvasPanel` standalone), `src/pages/SessionPage.tsx:49` (supplies `revision`), `src/lib/popost.ts`, `src/preview.d.ts:2`.

### 1.1 Who mounts the iframe

| Caller | Props to `CanvasPanel` | Result |
|---|---|---|
| `CanvasPage` (route `/canvas/:id`) | `projectId=id`, `onBack`, `embedded=false`, `revisionKey=0` | full-page canvas |
| `TaskWorkbench` (side panel in `/sessions/:id`) | `projectId=active.id`, `embedded` (true), `revisionKey=revision` (from SessionPage state) | embedded canvas, one iframe per active tab (`key={active.id}`) |

`SessionPage.applyReply` (`SessionPage.tsx:32-36`) increments `revision` after a chat reply replaced the open deck (`putDeck` then `setRevision(v=>v+1)`), which re-keys and thus reloads the iframe. Artifacts of other projects are written with `putDeck` but do not bump `revision`.

### 1.2 Iframe element

- `<iframe class="deck-editor" title="图文画布编辑器"|"Post canvas editor">`, no `sandbox` attribute, no `allow`.
- React `key` = `<project.id>-<preferences.locale>-<revisionKey>` (`CanvasPanel.tsx:19`). Changing project, UI locale or revision destroys and recreates the iframe (full editor reload, undo history lost).
- CSS hooks owned by the web app (not by the editor): `.canvas-page.canvas-v12>.deck-editor` fills the container (`src/workspace-v12.css:3`), `.canvas-embedded` hides the web canvas header (`src/workspace-v11.css:28`). The editor must fill 100% of the iframe and not depend on a minimum size beyond the layout rules in section 9.
- Project not found in `state.projects`: no iframe; empty-state with back button (`CanvasPanel.tsx:16`).

### 1.3 Iframe URL (`src` mode)

`editorSrc` (`CanvasPanel.tsx:17`) = `BASE + "vendor/html-deck/index.html?" + params`, where `BASE = BASE_URL without trailing slashes + "/"` (`src/lib/popost.ts:5`). Parameters in this exact order, every value URL-encoded where noted:

| Param | Value | Allowed values / format | Set by | Consumed by editor at |
|---|---|---|---|---|
| `popost` | `1` | constant | web app | presence checked: `js/services/live-sync.mjs:29` (disables the `/api/watch` SSE stream). Local server also forces `popost=1` (`canvas_bridge.py:65`). |
| `file` | `encodeURIComponent(project.id + ".html")` | `<projectId>.html` (id is a UUID in the mock; any string present in `state.projects[].id`) | web app | `HD/js/app.mjs:71` (document to open, wins over last-file), `HD/index.html:8-9` (stores `gs9_editor_mode:<file>=deck`), `js/ui/canvas-download.mjs:19` (derives project id by stripping `.html`) |
| `ratio` | `encodeURIComponent(project.ratio)` | `1:1`, `3:4`, `9:16`, anything else (incl. `4:5`) | web app, from project | `js/editor/state.mjs:5-6`: width 1080 whenever a ratio is present; height 1080 (1:1), 1440 (3:4), 1920 (9:16), else 1350. No ratio param: 1280x720. |
| `lang` | `preferences.locale` | `zh` or `en` in practice (editor also knows `zh-Hant`, `vi`) | web app | `HD/index.html:8` writes it into `localStorage.gs9_editor_lang` BEFORE modules load (default `zh` if absent); `js/i18n.mjs:1739-1743` reads that key |
| `revision` | `revisionKey` integer | 0..n | web app | not read by the editor; exists only to make the URL differ |
| `name` | `encodeURIComponent(project.name)` | arbitrary text | web app | `js/ui/chrome.mjs:56`: document title = `[bullet if dirty] <name or 图文画布> · popost` |
| `embedded` | `1` / `0` | `1` inside TaskWorkbench, `0` on CanvasPage | web app | `js/app.mjs:40`: `0` toggles class `standalone-canvas` on `<html>` (extra left padding on topbar, `css/popost.css:7`) |
| `theme` | `dark` / `light` | resolved web theme | web app | `HD/index.html:11`: toggles class `dark` on `<html>` |

Resolved theme (`CanvasPanel.tsx:8`): `theme==='system'` uses `matchMedia('(prefers-color-scheme: dark)')`; else `theme==='dark'`, or (no theme and legacy `dark` flag).

Other query params the editor understands but the web app never sends: `htmldeck-fault` (test hook, only if server config `test_hooks`; `app.mjs:69`), `embedded` absent.

### 1.4 `srcDoc` mode (`window.__POPOST_EDITOR_HTML__`)

- Declared in `src/preview.d.ts:2` as `string`. It is never assigned inside this repo (docs say a single-file build injects it, with `__POPOST_PREVIEW__` and `__POPOST_ASSETS__`; `docs/后端接口对接说明.md:19`, `docs/interface-contracts.json:11`). The producer lives OUTSIDE the repository; its exact output is therefore unknown here and must be confirmed before the rewrite ships.
- When set, `CanvasPanel.tsx:18-19`: the string must contain the literal token `__POPOST_PARAMS_INIT__`; the FIRST occurrence is replaced with `JSON.stringify(<query string of editorSrc, i.e. text after "?">)` with every `<` escaped to `<`; the result goes to `srcDoc` and `src` is omitted. So the token sits where a JS string expression is expected, and the document must expose that string as `window.__POPOST_PARAMS__`.
- Editor side: `HD/index.html:8` reads `window.__POPOST_PARAMS__` (if a non-empty string) in preference to `location.search`, but ONLY for `lang`, `file` and `theme`. Other modules read `location.search` directly (`state.mjs:5` ratio, `app.mjs:40,69,71` embedded/file/fault, `canvas-download.mjs:19` file, `chrome.mjs:56` name, `live-sync.mjs:29` popost). In a real `srcdoc` iframe `location.search` is empty, so those reads would see nothing unless the unknown single-file bundler rewrites them. RISK: the rewrite should read ALL parameters from one helper that prefers `window.__POPOST_PARAMS__` then `location.search`.
- A `srcdoc` iframe inherits the parent origin, so `location.origin` equals the app origin and the origin checks in section 1.6 still pass.

### 1.5 Message inventory

All messages are plain objects with a `source` discriminator. Both directions are same-window parent/child only.

| # | Direction | `source` | `type` | Fields | `targetOrigin` | Sent when | Receiver action |
|---|---|---|---|---|---|---|---|
| M1 | web app to editor | `popost-workspace` | `popost-theme` | `mode`: `dark` or `light` | `'*'` (`CanvasPanel.tsx:9`) | in an effect on mount and on change of `resolvedDark`, `projectId`, `preferences.locale`, `revisionKey`. Note: on first mount/re-key it fires before the new iframe has loaded, so it is effectively lost; the initial theme comes from the `theme=` param. Real effect: live theme toggle while the editor is open. | `HD/index.html:12`: if `e.data.type==='popost-theme'` toggle class `dark` per `mode`. NO origin/source/`source`-field check on the editor side. |
| M2 | editor to web app | `popost-editor` | `saved` | `id` = project id (file name without `.html`) | `location.origin` (`js/services/api.mjs:12`) | after every successful browser-mode `/api/save`, after storage flush (`api.mjs:29`) | `CanvasPanel.tsx:11`: `await refreshStored('decks')`, `refreshStored('revs')` (reload those two keys from IndexedDB into the in-memory cache), set `projects[id].updated = now` via `updateState`, then `await flushStorage()` |
| M3 | editor to web app | `popost-editor` | `notes` | `id` | `location.origin` | after a browser-mode `/api/notes` call that changed notes (`api.mjs:30`) | ignored (the receiver only handles `saved` and `download-images`) |
| M4 | editor to web app | `popost-editor` | `download-images` | `id`, `requestId` (`crypto.randomUUID()`), `html` (full current document, string, from `contentForSave().content` after flushing pending text edits) | `location.origin` (`canvas-download.mjs:21`) | click on `#btn-download-images` when embedded (browser mode). Editor shows busy state and a 120 000 ms timeout toast ("Download timed out. Please retry."). Refused locally with a toast when there is no file id or `window.parent===window`. | `CanvasPanel.tsx:12-14`: requires `typeof html==='string'` and `typeof requestId==='string'`; if an export is running replies with error "图片正在下载，请稍候"/"Download in progress"; else `validateDeck(html)`, `exportImages(html, project.name or "图文项目"/"Post project")`, then replies M5 |
| M5 | web app to editor | `popost-workspace` | `download-images-result` | `id` (project id), `requestId` (echo), optional `error` (string) | `location.origin` | after export finished or failed (also on `toast.error(message)` in the web app) | `canvas-download.mjs:22`: accepted only if `event.source===window.parent`, `event.origin===location.origin`, `data.source==='popost-workspace'`, type matches, a request is pending and `requestId` and `id` equal the pending ones; clears timeout, ends busy state, toast error text or success "All images downloaded"/"全部图片已下载" |

Editor-internal messaging that is NOT part of the web-app contract but exists: the present-mode host/session protocol (`js/present/session.mjs`, `render.mjs`, namespace `ns`, versioned, session id plus doc revision, target origin `cfg.preview_origin`); and direct function bridges between the editor window and the nested edit frame, `window.parent.__edKey`, `__edWheel`, `__edInput` (installed by the guard script injected into the edit frame, `js/editor/state.mjs:40-43`, bound in `js/ui/keyboard.mjs`). These matter only if the rewrite keeps a same-origin nested edit frame.

### 1.6 Origin and identity checks (web app side, `CanvasPanel.tsx:10`)

A message is processed only if ALL hold: `e.origin===location.origin`; `e.source===editor.current.contentWindow`; `e.data.source==='popost-editor'`; `e.data.id===projectId` (the panel's own project). The listener is re-registered when `projectId`, `project.name`, `t` or `updateState` change. Replies M5 are posted to `editor.contentWindow` with `location.origin`.

### 1.7 Web-app handling of other projects' decks

- `SessionPage.tsx:26-27` decides whether to show the "open workbench" affordance by checking `store.get('decks')[id]`.
- `ProjectPreview.tsx:5` renders thumbnail previews from `getDeck(id)`: parses the HTML, keeps only the FIRST `.slide`, removes `script,iframe,object,embed,base` and `on*` attributes, injects a style (body flex-centre, `.slide{margin:0!important}`), renders in an `iframe sandbox=""` at width 1080 and height by ratio (1:1 1080, 9:16 1920, 3:4 1440, else 1350). So decks must remain renderable stand-alone with `.slide` as the page element and a 1080-wide design.

---

## 2. Shared browser storage

Module: `HD/js/services/browser-storage.mjs` (83 lines). It is imported by BOTH the editor (via `api.mjs`) and the React app (`src/lib/popost.ts:3` imports it by relative path `../../public/vendor/html-deck/js/services/browser-storage.mjs` and re-exports `initStorage`, `flushStorage`, `refreshStored`). The rewrite must keep this file path (or update `popost.ts`) and these four/five exports. Same origin means one IndexedDB shared by the app and the editor iframe.

### 2.1 Module API

| Export | Signature | Behaviour | Line |
|---|---|---|---|
| `initStorage()` | `() => Promise<void>` (memoised; one init per page) | opens DB, loads ALL records into an in-memory `Map`, migrates legacy localStorage keys, resolves when done | :29-50 |
| `readStored(key, fallback)` | sync | returns the in-memory value if the key is known, else tries `JSON.parse(localStorage["popost-product:"+key])`, else `fallback` (note `null` results fall back via `??`) | :51-54 |
| `writeStored(key, value)` | sync, returns void | `structuredClone(value)` immediately (so later mutation by the caller is harmless), sets it in memory, then appends an async write to a single promise chain (`await initStorage()` then one readwrite transaction `put(value,key)`); on failure stores the error, dispatches `window` CustomEvent `popost-storage-error` with `detail` = message (default "项目保存失败，请检查浏览器存储权限。"), the chain stays rejected-but-handled | :55-67 |
| `flushStorage()` | `() => Promise<void>` | awaits init and the pending chain; throws the last write failure (cleared by the next successful write) | :68-72 |
| `refreshStored(key, fallback)` | `async` | awaits init, reads `key` directly from IndexedDB (`fallback` if absent), REPLACES the in-memory copy, returns it. Used to pick up writes from another window (the editor iframe or another tab) | :73-83 |

Semantics that callers depend on: writes are serialised in call order; the in-memory map is the read source for `readStored` (reads never touch IndexedDB after init); a pending write can be lost if the page unloads before `flushStorage()` (callers flush explicitly before reporting success). Nothing listens to `popost-storage-error` inside the repo.

### 2.2 IndexedDB schema

- Database name `popost-workspace-v24`, version `1` (`:5`, `:12`). The name carries a version suffix; do not change it (data of existing users).
- One object store `records` created in `onupgradeneeded`, no `keyPath`, no indexes (out-of-line keys). `openDatabase` rejects with the Chinese message "浏览器项目存储被占用，请关闭旧工作台页面后重试。" on `onblocked`.
- Values are structured-clone-able JS values (objects/strings/arrays), NOT JSON strings.
- Separate IndexedDB `gs9_editor`, store `drafts` (keyPath `key`), is private to the editor (`js/services/drafts.mjs:16`): record `{key, base, content, savedAt, name, rev}`, key `server:<path>` or `local:<name>:<hash>`; autosave 1500 ms after change, offered back on next open of the same file. The web app never reads it.

### 2.3 localStorage migration

`initStorage` (`:39-47`): after loading IndexedDB it scans `localStorage` for keys starting `popost-product:`; for each whose suffix key is NOT already in IndexedDB it JSON-parses the value, adds it to memory and writes it to IndexedDB in one transaction. Malformed JSON is skipped and left untouched. Legacy localStorage keys are never deleted or rewritten afterwards (they remain a fallback copy). `readStored` also consults localStorage for keys not in memory (before init finishes). `test_product_fonts.py` relies on this migration (seeds localStorage only).

### 2.4 Keys and who touches them

All keys live in store `records`. "Web" = React shell (`src/**`), "Editor" = html-deck iframe.

| Key | Value shape | Web writes | Web reads | Editor reads | Editor writes |
|---|---|---|---|---|---|
| `state` | `IState` = `{projects: IProject[], sessions, roles, inspirations, materials, preferences:{locale:'zh'\|'en', dark, theme?}}` (`src/data/types.ts:15`). `IProject` includes `id, name, ratio, slides, createdAt?, updated` ... | every UI change via `updateState` (`src/hooks/usePopost.ts:8`); `putDeck` does not touch it; `CanvasPanel` bumps `projects[i].updated` after M2 | everywhere | `/api/config`-less: only `validId` (project must exist: `state.projects.some(p=>p.id===id)`, `api.mjs:10`), `list_html` (uses `createdAt || updated`, `api.mjs:26`); `/api/load` calls `refreshStored('state')` first (`:27`) | never |
| `decks` | `Record<projectId, string>` full HTML document of the whole project | `putDeck` (`popost.ts:18-28`: awaits init, spreads existing map, adds id, captures initial, flushes); mock services read | `getDeck`, `ProjectPreview`, `SessionPage:26`, Settings backup (`SettingsPage.tsx:10`), mock-services | `/api/load`, `/api/list_html` (size) | `/api/save` (read-modify-write of the whole map) |
| `initial-decks` | `Record<projectId, {content: string, source: 'create'\|'earliest-retained-history'\|'current', createdAt: ISO string}>`; immutable once written | `captureInitialDeck` (`popost.ts:17`): only if id absent, `source:'create'` | `getInitialDeck` (unused by UI) | `/api/initial`, `/api/save` (seeds via `ensureInitialDeck`, `api.mjs:43`) | seeds `earliest-retained-history` when missing (`api.mjs:43`) |
| `revs` | `Record<projectId, string>` decimal `Date.now()` stamp as string | never writes; `refreshStored('revs')` after M2 | refresh only | `/api/load` returns `revs[id] \|\| "1"` | `/api/save` sets `revs[id]=stamp()` |
| `deck-history` | `Record<projectId, Array<{name: string(stamp), content: string}>>` newest first, max 5 | never | never | `ensureInitialDeck` (oldest = last element) | `/api/save`: prepends `{name: stamp, content: <previous deck>}` then `slice(0,5)` |
| `notes` | `Record<projectId, Note[]>` (see 2.6) | never | never | `/api/notes` | `/api/notes` |
| `display-name` | string | Settings/Layout/mock-services | same | no | no |
| `sidebar-collapsed` | boolean | `Layout.tsx:33` | `Layout.tsx:17` | no | no |
| `mock-billing`, `mock-signed-in`, `mock-used-codes`, API-key namespace, `skill-favorites` | app internal (mock services, `src/lib/api-key-service.ts`, `skill-library.ts`) | web | web | no | no |

Other editor storage (browser `localStorage`, same origin, not under the `popost-product:` prefix): `gs9_editor_lang` (written from `lang` param at boot, `index.html:8`), `gs9_editor_mode:<file>` (per-file display mode, forced to `deck` for embedded file, `index.html:9`, `document.mjs:20-26`), `gs9_editor_last_file` (`document.mjs:18`), `gs9_editor_page_width` (`ui/chrome.mjs:12`), `htmldeck_trust:<path>` and `htmldeck_export_remote` (upstream features, inert in Popost since scripts are disabled/hidden).

### 2.5 Revision and 409 semantics

- `rev` is an opaque string. Browser mode: stamp of last save per project, absent before the first save.
- `/api/load` returns `rev: revs[id] || "1"` (`api.mjs:27`). Editor keeps it in `S.source.rev` and sends it back on save together with `mtime_ns` (ignored).
- `/api/save` conflict rule (`api.mjs:29`): conflict iff `body.rev` is truthy AND `revs[id]` exists AND they differ AND not `body.force`. Then it throws an `Error("File changed")` with `status=409`; the editor shows its conflict dialog (`save.mjs:72,101-111`: choices force-save, download my version, cancel).
- Note: the web app's `putDeck` does not bump `revs` and does not write `deck-history`, so an editor tab that is open on an older version is NOT detected as stale after the app regenerates the deck (the iframe is re-keyed via `revisionKey` only in the same tab).
- History retention: 5 revisions per project, the previous content before each save (`api.mjs:29`). No UI in browser mode reads it (`/api/backups` returns an empty list, `api.mjs:33`); it exists as data safety and feeds `initial-decks` seeding.
- Local mode (disk) uses a different rev: SHA-256 of the canonical manifest+html JSON (section 4.5).

### 2.6 Note record shape (shared by browser and local mode)

Created by the editor (`js/features/feedback/notes.mjs:202-206`): `{id: random 8 chars, note: string, status: 'open'|'done', created: ISO, selector: CSS path, tag, text: snippet (<=160 chars), line: source line or null, slide: index or null}` plus, for region notes, `kind:'region', region, canvas, targets[]`. Operations (`api.mjs:30`, `canvas_bridge.py:42-54`): `{op:'add', note}`, `{op:'update', id, patch}`, `{op:'delete', id}` applied in order; response `{notes, command: string}`. The notes UI and the review panel are hidden by CSS in Popost (`css/popost.css:4`), so notes are write-capable only through leftover code paths, but the storage shape must stay readable (agents read `.popost-editor/notes.json`).

---

## 3. Browser-mode API emulation (`HD/js/services/api.mjs`, 43 lines)

The editor calls an `api(url, opts)` / `postJSON(url, body)` pair (`api.mjs:21,37`). In browser mode nothing goes over the network. The rewrite drops fake URLs but must keep these operations and their semantics.

Dispatch: if `window.__POPOST_LOCAL__` is truthy, delegate to `local-api.mjs` (`:22`); otherwise `await initStorage()`, parse `url` against `location.origin`, JSON-parse `opts.body` (or `{}`), `path = body.path || ?path=`. `withKey(url)` is identity (`:5`); `SERVER_DOWN` string exported (`:6`). Project id = `path` minus a trailing `.html` (`:9`). `validId` throws `Error("Project not found")` if no `state.projects[].id` matches.

| Route | Request | Response | Behaviour |
|---|---|---|---|
| `/api/config` (`:25`) | none | `{explicit:true, default_path: <?file= value or null>, trusted:false, root:"Popost browser workspace", preview_origin: location.origin}` | `trusted:false` means no workspace scripts; `explicit:true` makes `?file=` win |
| `/api/list_html` (`:26`) | none | `{files:[{path:"<id>.html", size: deck length, mtime: Date.parse(createdAt or updated) or 0}]}` | only projects that have a stored deck |
| `/api/load` (`:27`) | `?path=<id>.html` | `{content, path:"<id>.html", filename:"<id>.html", mtime_ns:"1", rev: revs[id] or "1", size: content.length}` | first `refreshStored('state')` and `('decks')`; throws `Project not found` or `Project content missing` |
| `/api/preview` (`:28`) | body `{content, nonce?, path?, target?, trust_remote?, no_scripts?}` | `{url: blob: URL}` (revoked after 600 000 ms) | content is sanitised by `safePreview` (see below); used for the edit frame, present mode, PDF print copy |
| `/api/save` (`:29`) | body `{path, content, mtime_ns, rev, force}` | `{file: path, bytes_written: content.length, mtime_ns: newRev, rev: newRev, backup: "browser/history"}` | refreshes `decks, revs, deck-history, initial-decks`; validates project; `ensureInitialDeck`; 409 rule (section 2.5); pushes previous deck into `deck-history` (max 5); writes `decks[id]=content`, `revs[id]=stamp`; `flushStorage()`; THEN posts M2 `saved` to the parent. Whole-map read-modify-write of `decks`, `revs`, `deck-history`. |
| `/api/notes` (`:30`) | GET `?path=` or POST `{path, ops}` | `{notes:[...], command:"Feedback stays in this browser."}` | applies ops (2.6); only a POST with `ops` writes (and posts M3 `notes`) |
| `/api/export` (`:31`) | `{content, path, remote}` | `{html: safePreview(content), embedded:0, missing:[], remote:[]}` | single-file HTML export; no asset inlining in browser mode (relies on data URIs already in the deck) |
| `/api/initial` (`:32`) | `?path=` | `{content, source, createdAt, available, reliable}` | refresh `initial-decks`, `ensureInitialDeck`; `available = content non-empty and source in {create, earliest-retained-history}`; `reliable = source==='create'` |
| `/api/backups` (`:33`) | `?path=` | `{backups:[], file: path}` | always empty |
| `/api/trust` (`:34`) | any | throws "图文脚本已禁用 / Scripts are disabled" | |
| anything else (`:35`) | | throws "此操作暂不可用 / Operation unavailable" | includes `/api/restore`, `/api/watch` (SSE disabled by `popost` param) |

`ensureInitialDeck(id)` (`:43`): return existing record; else if no history return `{content:'', source:'current', createdAt:''}` (not stored); else take the OLDEST retained history entry, store `{content, source:'earliest-retained-history', createdAt: now}` and return it. A record is written once and never overwritten.

`safePreview(content, nonce)` (`:13-20`): parse as HTML; remove every `<script>` unless it carries `nonce` equal to the supplied one; remove `iframe, object, embed, base, meta[http-equiv="refresh"]`; strip all `on*` attributes and `javascript:` in `href|src|xlink:href`; prepend a CSP `<meta>` with: `default-src 'none'`, `img-src data: blob: 'self'`, `style-src 'unsafe-inline'`, `font-src data: 'self'`, `script-src 'nonce-<nonce>'` (or `'none'` when no nonce), `connect-src 'none'`, `form-action 'none'`, `base-uri 'none'`; return `<!doctype html>` + serialised document.

Pre-save document edit rule used by the app: `saved` is posted only AFTER the storage flush, so the app's `refreshStored` always sees the new values.

---

## 4. Local skill mode

Components: `skills/popost/scripts/server.py` (528 lines), `scripts/canvas_bridge.py` (70), `scripts/project_core.py`, `scripts/editor_handoff.py`, `scripts/font_palette.py`, `scripts/project_bundle.py`; editor side `HD/js/services/local-api.mjs` (159 lines), `font-library.mjs`, `canvas-download.mjs`.

### 4.1 Serving the editor

- Server binds `127.0.0.1` only, `ThreadingHTTPServer` (`server.py:523-528`); prints one JSON line `{"ok":true,"listening":"http://127.0.0.1:<port>","project":"<root>"}` that `editor_handoff.present` parses.
- `GET /`, `/editor.html`, `/index.html` (`server.py:374-377`): reads `assets/editor/index.html` and calls `canvas_bridge.editor_html(project, source, query)`; responds `text/html; charset=utf-8`, `Cache-Control: no-store`, no CSP header on the editor page.
- `GET /_editor/<path>` (`:378-384`): serves files under `skills/popost/assets/editor/` (path resolved, must stay inside, else 404 JSON `{"ok":false,"error":"editor resource not found"}`); `.mjs`/`.js` served as `text/javascript`, others via `mimetypes`, fallback `application/octet-stream`. Legacy `/editor.js`, `/editor.css` branch (`:385`) points at files that do not exist.
- Injection (`canvas_bridge.py:57-70`): the `<head>` tag is replaced by `<head>` + `<base href="/_editor/">` + a script that sets two globals. This means every relative URL in `index.html` (css, js modules, `assets/logo.svg`, `codemirror/*`) resolves under `/_editor/`, while absolute `/api/*`, `/css/*`, `/pages/*`, `/assets/*`, `/fonts/*` hit the project. `index.html` MUST contain a literal `<head>` with exactly that spelling (first occurrence is replaced).

| Global | Shape | Source |
|---|---|---|
| `window.__POPOST_LOCAL__` | `{projectId, width, height, name}`; `projectId = manifest.projectId or sha256(project.root)[:32]`; `width/height` of the FIRST page; `name = manifest.brief[:80] or "Popost"`; JSON with ASCII escaping and `<` as `<` | `canvas_bridge.py:61-63,67-68` |
| `window.__POPOST_PARAMS__` | URL-encoded query string: the request's own query params (first value each) plus forced `file=pages/<projectId>.html` and `popost=1`; `lang` defaults to `zh` | `canvas_bridge.py:64-66,69` |

There is no nonce/CSP injected by the server into the editor page; the nonce mechanism is for the preview frame and is generated by the editor (section 4.3). Local mode is never nested in the web app (it is its own top-level page, in a host side panel), so there are no postMessages in local mode.

Editor effects of `__POPOST_LOCAL__`: switches `api.mjs` to `local-api.mjs`; fixes `DECK_W/DECK_H` (`state.mjs:5-6`); per-slide size on slide change (`selection.mjs:84-87`: reads `data-popost-width|height` of the shown page and re-applies `--ed-deck-w/h`); duplicate-slide assigns a fresh page id (`slide-actions.mjs:72`); save never asks about "rewriting" (`save.mjs:21-22`); disables SSE watch (`live-sync.mjs:29`); font install via server (`font-library.mjs:39`); "download all" via server export (`canvas-download.mjs:11-15`).

### 4.2 HTTP endpoints

All JSON replies are `{ok:true,...}` or `{ok:false,error:string}` with `Content-Type: application/json; charset=utf-8`, `Access-Control-Allow-Origin: http://127.0.0.1:<port>`. POST requires an `Origin` header whose host equals the `Host` header or `127.0.0.1:<port>` or `localhost:<port>`; otherwise `403 {"error":"origin/csrf rejected"}` (`server.py:311-321,419-421`). Editor `fetch` always sends `cache:'no-store'` (`local-api.mjs:7`) and treats `!response.ok` or `data.ok===false` as an error (message = `data.error`, `error.status` = HTTP status; 409 drives the conflict dialog).

| Method and path | Called by editor? | Request | Response | Errors |
|---|---|---|---|---|
| `GET /api/editor-info` (`:335`) | no (used by `editor_handoff._probe`, agents) | none | `{ok, schema:"popost-editor-info.v1", version:"3.3.1", projectId, projectIdentity: sha256(resolved root), capabilities:["edit-text","edit-layout","save-local","export-png","export-project"]}` | |
| `GET /api/project` (`:345`) | yes (`local-api.mjs:132`, after save `:115`) | none | `{ok, manifest: <manifest with each page's html injected>, canvasRev}`; re-reads manifest from disk each time | |
| `POST /api/project` (`:497`) | yes (save) | `{pages: [{id, name?, width?, height?, role?, html}], canvasRev, force}` (also accepts `{manifest:{...}}`, optional `mode`) | `{ok, saved:[{id, sha256}], revision, canvasRev}` | `409` if `canvasRev` given, differs from current, and not `force` ("工程已被另一窗口或 Agent 修改，请重新加载或处理冲突。"); `400` on validation; `500` otherwise |
| `GET /api/canvas-initial` (`:351`) | yes (`:133,139`) | none | `{manifest:{... pages with html}, createdAt}` read from `.popost-editor/initial.json`; created on first call | |
| `GET /api/canvas-notes` (`:354`), `POST /api/canvas-notes` (`:514`) | yes (`local-api.mjs:140`) | POST `{ops:[...]}` | `{notes, command:"Feedback stays in this local project."}` | 400 on bad ops |
| `POST /api/canvas-preview` (`:428`) | yes (every mount) | `{content, nonce}`, body must be 1..16 MiB else `413` | `{ok, url:"/_preview/<uuid>.html"}`; `400` for invalid nonce | |
| `GET /_preview/<uuid>.html` (`:338`) | iframe navigation | | sanitised HTML with `Content-Security-Policy` header and `Cache-Control: no-store`; entries expire after 600 s monotonic, max 16 cached (oldest evicted) | `404 "preview expired; reopen the document"` |
| `GET /api/export?page=<id>\|all` (`:357`) | yes (`page=all`) | | PNG (`image/png`) or ZIP (`application/zip`) with `Content-Disposition: attachment; filename="<basename>"`; the single-page route is not called by the editor | `500 {error}` |
| `GET /api/font-palette` (`:367`) | yes | | `{ok, roles:[...palette roles]}` | |
| `POST /api/font-install` (`:468`) | yes | `{roles:"id1,id2", resourceOnly:true, canvasRev}` | `{ok, installed:{...}, cssInjected: !resourceOnly, canvasRev}` | `409` stale canvasRev (same Chinese message, "重新加载后选择字体"); `400` unknown role; `500` |
| `GET /api/project-bundle` (`:370`) | no (tests, humans, agents) | | ZIP `project.popost.zip` | `400 {error}` |
| `POST /api/import-project` (`:443`) | no | raw ZIP bytes | `{ok, project: <new dir>}`; switches the running server to the imported project | `400` |
| `POST /api/import-image` (`:452`) | no (editor never calls it; uploads become data URIs) | raw bytes or `{dataUri}` | `{ok, asset:{id,path,sha256,kind}}` | `500` |
| `GET /<rel>` (`:388-395`) | yes (pages, assets, css, fonts via the preview's `<base>`) | project-root-relative static files, `realpath` confined to project root | file bytes | `404 {"error":"not found"}` |

Editor-initiated routes that local mode refuses: `/api/restore`, `/api/trust`, `/api/watch` (default branch throws "此操作暂不可用", `local-api.mjs:143`).

### 4.3 Preview frame and nonce/CSP

- The editor builds the edit-frame document itself (`renderHTML(nonce)`, `js/editor/live-document.mjs:53-75`): clone of the model, scripts neutered for non-trusted sources, editor guard + freeze scripts prepended, editor CSS appended; the editor generates a 32-hex nonce (`js/core/sanitize.mjs:5-7`, 16 random bytes) and tags its own injected scripts with it.
- Local `preview()` (`local-api.mjs:117-125`) additionally strips non-nonce scripts, `iframe/object/embed/base/meta[http-equiv]`, `on*`, `javascript:` URLs, adds `<base href="<origin>/pages/">` and a CSP meta, then POSTs to `/api/canvas-preview`; the server runs the document through its own sanitiser (`preview_html`, `server.py:124-139`): validates nonce `^[a-f0-9]{32}$` or null (else `ValueError` -> 400), keeps only inline `<script nonce=NONCE>` without `src`, drops `base` and `meta[http-equiv]`, then inserts `<base href="/pages/">` after `<head>` and returns the CSP header: `default-src 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'nonce-<n>' | 'none'; connect-src 'none'; form-action 'none'; base-uri 'self'`.
- The edit iframe `src` therefore is `/_preview/<uuid>.html` (asserted by `test_shared_canvas.py`, `src.startswith('/_preview/')`). The frame element is `#frame`. Same-origin HTTP (not blob) is required because blob frames hang in embedded WebViews (comment in `server.py:125`).
- Browser mode uses `blob:` URLs with the same sanitiser rules (section 3).

### 4.4 Server-side HTML sanitiser (applies on every save and in previews)

`server.py:22-118` (`sanitize_html`, `clean_css`): drops `script, iframe, object, embed` (with content); drops `on*` attributes; drops `src`/`href` whose value starts `http(s)://` or `//` (external); drops `src`/`href` using `javascript:`, `vbscript:` or `data:` unless `data:image`; `<style>` keeps only attributes `id`, `type`, `media`, `data-*` and its CSS is cleaned: `@import` removed, `url(http(s)://...)` and `url(//...)` removed, `expression(...)` and `javascript:` removed; inline `style=` values cleaned the same way; attribute values re-escaped (`&`, `"`); void tags self-closed with `/>`; text escaped. Consequences the editor depends on: `data:font/woff2` URLs in `<style>` and `data:image/*` in `src` survive; `<link rel=stylesheet href="../css/x.css">` (relative) survives; `<meta>`, `<link>` and unknown attributes survive; `data-*` attributes survive on all elements; comments are dropped (HTMLParser handlers do not re-emit them); `<!doctype>` is dropped by the sanitiser (the document is stored without a doctype per page: the editor re-adds it when compiling).

### 4.5 Project on disk and revision

- Manifest `social-studio-project.json` (`MANIFEST_NAME`, `project_core.py`), schema checked on load; pages in `pages/<id>.html`, id `^[A-Za-z0-9_-]{1,64}$`, width/height integers 1..16384; fonts in `fonts/<role>/`, `css/<role>.css`, `fonts-manifest.json`; assets in `assets/`; exports in `exports/`.
- Page manifest entry written by save: `{id, name (default id), htmlPath:"pages/<id>.html", width (default 1080), height (default 1350), role (default "content")}` (`server.py:247-289`). Each save bumps `manifest.revision` (int), drops `seriesReview` if page ids changed, clears per-page `reviews` for changed HTML (`project_core.py:171-178`).
- `canvasRev` (`canvas_bridge.py:18-20`): SHA-256 hex of `json.dumps(payload, sort_keys, ensure_ascii=False)` where payload = manifest deep copy with each page's `html` injected. Therefore ANY change by an agent to any page file, a font entry or manifest metadata changes it. It is returned by `GET /api/project`, `POST /api/project`, `POST /api/font-install` and must be echoed back on write.
- Save transaction (`server.py:497-513`, under a global `RLock`): reload manifest from disk, compare `canvasRev` unless `force`, `canvas.initial()` (create `.popost-editor/initial.json` if missing), `canvas.backup()` (write `.popost-editor/history/<revision>.json` payload; keep newest 5 by mtime), validate and sanitise ALL pages before writing, write every page (with rollback of pages and manifest on exception), inject `<link rel="stylesheet" href="../<cssPath>">` for manifest fonts whose family has no `@font-face` embedded in the page (removing previous `../css/*` links first), `revision += 1`, return new `canvasRev`.
- `.popost-editor/`: `initial.json` `{manifest:<payload>, createdAt}` (immutable, first open), `history/<sha>.json` (max 5), `notes.json` (array of notes, same shape as 2.6), `service.json` (`{url, pid, version}`), `server-<ns>.log`. `editor-handoff.json` is written in the project root by `present`.

### 4.6 `local-api.mjs`: compile a multi-page project into one editor document

Operations (`local-api.mjs:126-145`):

| Editor route | Behaviour |
|---|---|
| `/api/config` | `{explicit:true, default_path:"pages/<projectId>.html", trusted:false, root:"Popost local project", preview_origin: origin}` |
| `/api/list_html` | one file `pages/<projectId>.html` |
| `/api/load` (`?path` must equal `pages/<projectId>.html`) | `GET /api/project` (store `current`), `GET /api/canvas-initial` (ensures initial snapshot), `compileProject(manifest)`, return `{content, path, filename: <name>.html, size, rev: canvasRev, mtime_ns: canvasRev}` |
| `/api/save` | `splitProject(content)` -> `POST /api/project {pages, canvasRev: rev, force}`, then reload `current`; return `{file, bytes_written, mtime_ns:canvasRev, rev:canvasRev, backup:".popost-editor/history"}` |
| `/api/preview` | section 4.3 |
| `/api/initial` | compile `canvas-initial` manifest; `{content, available:true, reliable:true, source:"local-open", createdAt}` |
| `/api/notes` | `GET`/`POST /api/canvas-notes` |
| `/api/backups` | `{backups:[]}` |
| `/api/export` | `{html: <content unchanged>, embedded:0, missing:[], remote:[]}` |

Compile (`compileProject`, `pageNode`, `local-api.mjs:52-92`): every page's HTML is parsed; the page root is the first match of `.slide[data-popost-page]`, `.post`, or `.page` (error "页面 <id> 缺少 .post/.page 画布根节点" otherwise). Output document = `<!doctype html><html><head><meta charset=utf-8><style>` base reset (zero margin/padding on `html,body`, `box-sizing:border-box` on `.slide`) `</style></head><body>` + each page root's `outerHTML` joined by newlines + `</body></html>`.

Per page:
1. Unconverted page (root has no `data-popost-page`): collect all `<style>` and `<link rel=stylesheet>` from the whole page document (external-origin links are an error: "请先将字体和样式保存到工程内"), fetch linked CSS from the server (cached per URL), rewrite every `url(...)` to a root-relative-from-`/pages/` form (`../<path>`; `data:`, `blob:`, `#` untouched; a cross-origin URL throws "本地工程不能依赖站外资源，请先导入图片和字体。"); remove styles/links inside the root; prepend ONE `<style data-popost-style>` inside the root whose text is the CSS transformed by `scopedCSS`.
2. Already-converted page (root has `data-popost-page`): CSS comes from the page document's `<head>` styles/links, previous `style[data-popost-head-style]` inside the root is removed and one new `<style data-popost-head-style>` (scoped) is appended to the root when there is CSS. The root's own `style[data-popost-style]` is left as saved.
3. For the root and all descendants: attributes `src`, `href`, `poster` are rewritten with the same `relative()` rule; inline `style` attribute `url()`s likewise.
4. Root gets class `slide` (original classes such as `post`/`page` kept), `data-popost-page=<manifest page id>`, `data-popost-width`, `data-popost-height` (numbers from manifest), `data-popost-name` (`name` or id), inline `width:<w>px; height:<h>px`, and defaults `position:relative`, `overflow:hidden` if unset.

`scopedCSS` (`:27-51`): parse via constructable `CSSStyleSheet`; `@font-face` rules are hoisted OUT of the scope and emitted first (document-wide); everything else is wrapped in a single native `@scope { ... }` block (no prelude, scope root = the page root). Selector rewriting: a selector that is exactly `:root`, `html` or `body` becomes `:scope{...}` retaining only inherited-style properties (`--*` custom properties, `background*`, `color`, `font*`, `line-height`, `letter-spacing`, `word-spacing`, `text-align|transform|indent|rendering`, `direction`, `writing-mode`, `white-space`, `visibility`); leading `html`/`body`/`:root` descendants prefixes are stripped; if the first compound of a selector matches the root node itself, an extra `:scope`-based selector is added; nested rule blocks (e.g. `@media`, `@supports`) recurse; `@keyframes` are kept as is; comma lists are split respecting quotes and brackets.

Split (`splitProject`, `local-api.mjs:93-111`): top-level `.slide` elements (not nested in another `.slide`) in DOM order are the pages (none -> error "请至少保留一页图文"). For each: page id = `data-popost-page` if it matches `^[\w-]{1,64}$` and is unique, else new `p-` + 12 hex chars from `crypto.randomUUID()` (duplicated pages thus get fresh ids); width/height from `data-popost-width|height`, else previous manifest page, else `__POPOST_LOCAL__.width|height`; inline width/height set; `name` from `data-popost-name` or "Page n"; `role` from previous manifest or `content`. The page HTML = `<!doctype html><html><head><meta charset=utf-8>` + inner HTML of the compiled document's `<head>` (minus `script`, `base`, `meta[http-equiv]`) + `</head><body style="margin:0">` + root `outerHTML` + `</body></html>`, with duplicate `@font-face` blocks (whitespace-normalised text equality) removed inside the page. The result posted to the server is `{id, name, width, height, role, html}` per page. Deleting a slide in the editor deletes the page from the manifest; the file under `pages/` is left on disk but not referenced.

Paths/base: `S.baseURL = origin + "/pages/"` (derived from `path` `pages/<id>.html`, `document.mjs:126-127`); the preview adds `<base href="/pages/">`; therefore stored markup uses `../assets/...`, `../fonts/...`, `../css/...` relative to the page file.

### 4.7 Font install on selection (local mode)

Flow in `prepareFont` (`font-library.mjs:30-56`): determine needed roles (the chosen role plus the Simplified or Traditional CJK sans fallback `cjk-sans` / `cjk-sans-tc` when the document body text contains characters in `U+3400..U+9FFF`), `POST /api/font-install {roles:"a,b", resourceOnly:true, canvasRev: S.source.rev}`; on success store the returned `canvasRev` into `S.source.rev`; `GET /css/<roleId>.css` for each role; abort with "画布已切换，请重新选择字体" if the document changed meanwhile. Server effect (`font_palette.install_project`, `server.py:468-495`): copies `assets/fonts/<role>/` to project `fonts/<role>/`, writes `css/<role>.css` (relative `../<role>/` rewritten to `../fonts/<role>/`), merges `fonts-manifest.json`, builds `css/chosen.css`, records `manifest.fonts[]` entries `{id, family, cssPath, licensePath, fileCount, totalBytes, label, license, package, packageVersion, cssFamily}`. With `resourceOnly` the page files are NOT touched (unsaved canvas edits are preserved); without it, all pages get `<link rel=stylesheet href="../css/<id>.css">` for all installed fonts.

### 4.8 Download, bundle, export endpoints from the editor

- "Download all" (local): `flushPending`, `persistLive` (a forced save with `force:true, rewriteOk:true`; fails with "请先完成保存或处理版本冲突，再下载。" if the editor still reports a save error or dirty state), then `GET /api/export?page=all`, browser download named `popost-images.zip` (`local-api.mjs:151-159`, `canvas-download.mjs:11-15`).
- `GET /api/project-bundle` is not linked from the UI (the export menu has no project-ZIP action, per `editor-contract.md`), but is used by tests and agents; format in section 8.3.

### 4.9 Starting the server, handoff

`editor_handoff.present` (`editor_handoff.py:46-97`) starts `server.serve(Project.load(root), port)` as a detached process with a log, probes `GET /api/editor-info` (identity and version equal), writes `.popost-editor/service.json`, writes `editor-handoff.json` in the project root and returns `popost-editor-handoff.v1` JSON with `url = <base>/editor.html`. The version constant `3.3.1` in `editor_handoff.py:16` and `/api/editor-info` must match for reuse of a running service.

---

## 5. Document/markup contract

### 5.1 What the editor requires

| Requirement | Detail | Source |
|---|---|---|
| Well-formed enough for `DOMParser('text/html')` | the model is a DOMParser copy; scripts never execute in it | `core/model.mjs:5-26` |
| Web app decks | a full HTML document (any `<!doctype>`/comments preserved as prologue/epilogue) containing one or more `.slide` elements; size comes from CSS in the document (the generated decks use `.slide{width:1080px;height:...}`) | `src/lib/popost.ts:29-34`, `mock-services.ts:78-79` |
| Deck vs page mode | slides = `.slide` elements that are original (not script-created), not nested in another `.slide`, grouped by parent; the largest sibling group wins. Deck mode needs at least two slides, all at least 900 px wide (or width unknown); otherwise page mode; a vertical stack of non-16:9 `.slide` blocks is a "section report" -> page mode with slides as jump targets. For Popost the display mode is forced to `deck` via `localStorage gs9_editor_mode:<file>` (web: written by `index.html:9`; local: same key) and a deck with a single slide stays in deck mode only because of that forcing | `editor/document.mjs:326-337,248-255`, `index.html:9` |
| Canvas size | `DECK_W/DECK_H` from `ratio` (web) or `__POPOST_LOCAL__` first page then per-page `data-popost-width/height` (local); rendered through variables `--ed-deck-w`, `--ed-deck-h` and forced fixed sizing on `[data-ed-slide]` | `state.mjs:5-6,25-33`, `document.mjs:242,320-323` |
| Local pages | root `.post` or `.page` (or `.slide[data-popost-page]`) with fixed pixel width/height; `data-canvas-width|height` attributes written by the starter page are informational; layers carry `data-layer-id` and text leaves `data-slot` (editor tests select them, section 9); `.notes` class elements are never editable roots | `local-api.mjs:57`, `project_core.py:28-50`, `live-document.mjs:90` |
| Same-origin resources | local compile throws on any cross-origin CSS/image URL | `local-api.mjs:12-17` |

### 5.2 What the editor writes back

- Save content = the ORIGINAL source text with minimal patches spliced in (only changed element ranges) when it can prove the result re-parses to exactly the edited model; otherwise a full re-serialisation (`prologue` + `documentElement.outerHTML` + `epilogue`) (`core/serializer.mjs:211-264`, `contentForSave` at `:244`). When nothing was touched the stored text is returned byte-for-byte. Web mode asks the user to confirm a non-minimal rewrite (`save.mjs:22`, modal `#modal-reformat`); local mode never asks.
- Maximum saved size 60 MiB (`save.mjs:23`).
- Editor bookkeeping attribute `data-ed-id` (integer string) is put on EVERY element of the in-memory model and removed in saved output (stripped by `serialize`, never emitted by the minimal patcher, `startTag` skips it). Documents that arrive already containing `data-ed-id` (undo snapshots) keep their numbers and `nextId` continues above the maximum (`model.mjs:12-24`).
- Attributes that exist only in the live edit frame (never in the model or saved file): `data-ed-slide`, `data-ed-slide-anc`, `data-ed-edit`, `data-ed-svgtext`, `data-ed-display`, `data-ed-overflow`, `data-ed-cur` / class `ed-cur`, `data-ed-last`, classes `ed-deck`, `ed-page`, `ed-marquee`..., injected `<style id="ed-format">`, FRAME_CSS style and guard/freeze scripts (`live-document.mjs:53-75`). `cleanFragment` (`model.mjs:50-`) strips `contenteditable`, `data-ed-edit`, `data-ed-svgtext`, `spellcheck`, `data-ed-overflow` from any HTML coming back from the live DOM before it enters the model.
- Data attributes added to the SAVED document: local mode adds on the page root `class="slide"` (kept after splitting), `data-popost-page`, `data-popost-width`, `data-popost-height`, `data-popost-name`, inline width/height; `<style data-popost-style>` (scoped CSS in the root) and `<style data-popost-head-style>`; fonts add `<style data-popost-font="<roleId>">` (below). The editor's body attribute `data-doc-state` (`loading|ready|error`), `data-doc-path`, `data-doc-seq`, `data-slide-count` are on the editor shell (not the document) and are a test contract (section 9).
- Upstream feature attribute: `script[data-htmldeck-fx]` / `style[data-htmldeck-fx-style]` (effects runtime, UI hidden in Popost); the edit frame turns such scripts inert; Popost web and local sanitisers forbid scripts, so they cannot survive.

### 5.3 Font embedding in the document

`<style data-popost-font="<roleId>" data-ed-id=...>` appended to the model `<head>` (and a mirrored one in the live frame head). Its text is: a CSS comment block with the font package id and version plus the full licence text (OFL), then the role's `@font-face` rules. Browser mode: all `url(...)` replaced with `data:font/woff2;base64,...` (so the deck is self-contained, ~tens to hundreds of KB per role, one style element per role, existing element reused and overwritten, never duplicated); local mode: the text of `/css/<roleId>.css` (relative `../fonts/<roleId>/...` urls, files on disk). The selected element gets a `font-family` inline style value made of `"<family>"`, the CJK fallback family if added, and the role's generic fallback (`serif`/`sans-serif`/...).

### 5.4 Sanitisation rules (summary)

| Place | Rule |
|---|---|
| Web `validateDeck` (`src/lib/popost.ts:29-34`) | throws if no `.slide`; throws if any `script, iframe, object, embed, base, form, meta[http-equiv="refresh"]` exists, any attribute named `on*`, or `href|src|xlink:href` starting (after whitespace) with `javascript:`; returns the number of `.slide` elements. Error texts (Chinese): "图文内容需要包含 .slide 结构", "仅允许静态图文 HTML，不允许脚本或嵌入内容". It does NOT reject `<style>`, external `http(s)` URLs, `data:` URLs, `<link>`, or `<noscript>`. |
| Editor code panel `validate` (`js/ui/panels/code.mjs:22`) | same rule set as `validateDeck`, plus non-empty, 60 MiB cap, requires `.slide`; messages bilingual |
| Editor code panel "Download HTML" (`code.mjs:15,19`) | static copy: removes `script, noscript, object, embed, iframe, frame, base`, strips `on*` and `javascript:` in `href|src|action|formaction|xlink:href`, inserts a CSP meta (default-src none, img data/blob/https/http, style inline, font data/https/http) if no CSP meta exists; file name = `S.source.name` or `index.html` |
| Editor edit frame (`core/sanitize.mjs:8-17`) | for non-trusted sources: remove `script, object, embed, meta[http-equiv], set, animate`; iframes lose `srcdoc` and get `sandbox=""`; strip `on*` and `javascript:` URLs |
| Browser-mode preview (`api.mjs:13-20`) | section 3 |
| Local server (`server.py`) | sections 4.3 and 4.4 (authoritative, applied on save) |
| `ProjectPreview.tsx:5` | thumbnail sanitiser (first slide only) |
| `exportImages` | renders into `iframe sandbox="allow-same-origin"` |

Note the web app persists decks WITHOUT sanitising them beyond `validateDeck`; the editor's saves in browser mode also do not sanitise (they store whatever the editor produces).

---

## 6. Exports

| Export | Where | Mechanism | File name(s) |
|---|---|---|---|
| PNG, all slides (web) | `src/lib/popost.ts:36-44` `exportImages(html, name, index?)` called from `CanvasPanel` on M4 | validate; hidden iframe (`position:fixed; left:-20000px; 1200x1600; sandbox="allow-same-origin"`) loaded via `srcdoc`; wait `doc.fonts.ready` and `decode()` of all images; for each `.slide` call `html-to-image` `toPng` with `pixelRatio:1`, `cacheBust:false`, `style:{margin:'0'}`, `width/height = element.offsetWidth/offsetHeight`; add to JSZip; `downloadBlob` | ZIP: `<name>-图文.zip` containing `<name>-1.png ... <name>-N.png` (1-based); `name` = project name or `图文项目` / `Post project`. Single (when `index` supplied; not used by current UI): `<name>-<index+1>.png`. |
| `downloadBlob` | `popost.ts:35` | anchor with object URL, revoked after 3 s | |
| PNG, all pages (local) | `/api/export?page=all` (`server.py:231-243,357-366`) | Playwright Chromium, JS disabled, network blocked except `file:` and `data:`, viewport = page size, fonts and images awaited and checked, screenshot of first `.post` else first `.page` element at scale 1; results cached by fingerprint (HTML + size + every file under `assets/`, `fonts/`, `css/`; receipt `.render.json`, signature `popost-png-v2:scale1:offline:fonts-ready`) | server file `exports/all.zip` containing `<pageId>.png` per page in manifest order; client saves as `popost-images.zip` |
| PNG single page (local) | `/api/export?page=<id>` | same renderer | `exports/<id>.png` (attachment name = basename) |
| Single-file HTML | editor export menu `#pop-export` (`js/services/export.mjs:29-45`) | POSTs `/api/export {path, content, remote}` and downloads `res.html`; browser/local emulation returns the (sanitised / unchanged) content, `embedded:0`; toast text from sizes | `S.source.name` = `<projectId>.html` (browser) or `<manifest.brief[:80]>.html` (local) |
| Code-panel HTML download | `code.mjs:19` | static copy of current live document (section 5.4) | `S.source.name` or `index.html` |
| PDF | `export.mjs:49-84` | builds a print copy with `present/print.mjs` (scripts removed), `POST /api/preview {no_scripts:true}`, opens it in a new tab, waits for fonts/images, calls `print()` and closes on `afterprint` | none (browser print dialog, title = file name without `.html`) |
| Project ZIP | `GET /api/project-bundle` (local only), `scripts/project_bundle.py` | section 8.3 | `exports/project.popost.zip` |
| Web backup JSON | `SettingsPage.tsx:10` | JSON of `{projects, sessions, roles, materials, inspirations, decks}` | `popost-项目备份.json` |

Timing for M4/M5: editor waits at most 120 s; the app serialises exports (one at a time; second request answered with error immediately).

---

## 7. Fonts

- Source of truth: skill palette `skills/popost/assets/fonts/palette.json` (version `2.0.0`, 41 roles); the web app gets an offline copy in `public/fonts/popost/` generated by `scripts/sync-font-library.mjs` (copies each role directory, `css/`, `palette.json`, `NOTICE.txt`, `sample.html`, deletes the target first, rejects any role whose `license.spdx` is not `OFL-1.1`). The two trees are identical except `screenshots/` which exists only in the skill copy.
- Role object fields consumed: `id`, `label`, `family`, `group`, `cssPath` (`css/<id>.css`), `licensePath` (`<id>/LICENSE`), `weights`, `package`, `packageVersion`, `fallback` (generic family), plus `variable`, `fileCount`, `totalBytes`, `coverage`, `license{spdx,path,sha256,url}`, `scripts`, `assetSha256`.
- Catalog URL: web `new URL("palette.json", HD/js/services/../../../../fonts/popost/)` i.e. `<site base>/fonts/popost/palette.json` (relative to the module location `vendor/html-deck/js/services/`); local mode `GET /api/font-palette` (`font-library.mjs:4-9`). Response `.roles` is the array used.
- Font menu (`initFontPicker`, `font-library.mjs:10-16`): fills `<select id="tb-font">` (disabled while loading) with one `<optgroup label=role.group or "Fonts">` per distinct group (insertion order = palette order); option label = family without " Variable" suffix when equal (case-insensitively) to `role.label`, else `label · family-without-Variable`; `value = role.family` (e.g. `Inter Variable`); `title = group · weights · OFL-1.1`; `data-font-id = role.id`. On failure the select shows a single option "字体库加载失败" and tooltip with the error. Tests count `option[data-font-id]` and require equality with the palette role ids.
- Selecting a font: `prepareFont(familyName)` (`font-library.mjs:30-56`), returns `{role, family: <css font-family list>}`; throws "该字体不在公共字体库中" for unknown family. Browser mode `inlineFont` (`:17-29`): fetch `css/<id>.css` and licence text from the library base, fetch every `url()` file (up to 8 concurrent), base64 into `data:font/woff2;base64,...`, prepend licence comment (`/* package@version\n LICENSE\n*/`), cache per role in a Map (removed on failure). Then `document.fonts.load('400 24px "<family>"', sample text)` so the live frame has it. Local mode: section 4.7.
- Test-visible results: computed `font-family` contains the selected family and `Noto Sans SC Variable` (the `cjk-sans` family) when the text contains Han characters; saved deck in `IndexedDB.decks` contains `data:font/woff2;base64,` and the string `SIL OPEN FONT LICENSE` and never `fonts.googleapis.com`; after reload with `/fonts/**` blocked existing text still renders (fonts are embedded).
- The font CSS inside the web deck is not fetched at export time; `exportImages` relies on embedded `@font-face`.

---

## 8. Build and packaging touchpoints

### 8.1 `package.json` scripts (`package.json:6-18`)

| Script | Command | Note |
|---|---|---|
| `sync:skill-editor` | `node scripts/sync-skill-editor.mjs` | DO NOT run in the current VM (see PROGRESS.md: virtiofs breaks the delete-and-copy) |
| `sync:fonts` | `node scripts/sync-font-library.mjs` | |
| `predev` | `npm run sync:fonts` | |
| `prebuild` | `npm run sync:skill-editor && npm run sync:fonts` | so `npm run build` always overwrites `skills/popost/assets/editor/` |
| `build`, `dev`, `typecheck`, `lint` | vite / tsc / eslint on `src` | the editor under `public/` is not type-checked or linted; Vite copies `public/` verbatim into `dist/` |

### 8.2 `scripts/sync-skill-editor.mjs` and `shared-source.json`

`sync-skill-editor.mjs` (13 lines): removes `skills/popost/assets/editor/` recursively, copies `public/vendor/html-deck/` there, walks the source tree and writes `skills/popost/assets/editor/shared-source.json` = `{"source":"public/vendor/html-deck","files":{"<relative posix path>":"<sha256 hex>", ...}}` (pretty-printed, 2-space indent, trailing newline; keys in directory walk order, alphabetical in practice; `shared-source.json` itself is not listed). Currently 86 files listed (LICENSE, `assets/logo.svg`, `codemirror/*` 7 files, `css/{editor,popost,v35-surface}.css`, `index.html`, `js/**`). The rewrite may change the file set; the script copies whatever is under `public/vendor/html-deck/` and hashes it, so the folder name and the script contract (copy whole folder; manifest file name and shape) are what packaging depends on. Known risk: non-atomic delete-then-copy (TODO.md:87).

### 8.3 Skill packaging

- `skills/popost/SOURCE-MANIFEST.sha256`: `<sha256>  <relative path>` lines (1693 lines), covers every skill file except README and the manifest itself; 87 lines are for `assets/editor/**` (86 editor files; the 87th is `shared-source.json` itself). Verified with `shasum -a 256 -c SOURCE-MANIFEST.sha256` (README.md:50). A changed editor requires regenerating those entries (PROGRESS.md notes 4 stale hashes were fixed earlier). Editor-contract doc: `skills/popost/references/editor-contract.md`; host handoff doc: `references/host-editor.md`.
- `scripts/project_bundle.py` `export_project` (`:20-110`): ZIP content = manifest (sanitised: `sources=[]`, `concept` reset, provider/series/template/reviews keys removed, `delivery={kind:'editable-project',reviewStatus:'draft-after-import'}`, only assets that are referenced), every page HTML and the files they reference (`src|href|url()` followed recursively through CSS and HTML; external or missing local dependency raises; `reference/` and `production/` forbidden), font licence files next to font binaries, then the runtime: `runtime/scripts/<server.py, project_core.py, render_html.py, font_palette.py, project_bundle.py, series_plan.py, build.py, canvas_bridge.py, editor_handoff.py>`, ALL files of `assets/editor/` copied as `runtime/assets/editor/<relpath>` (so `shared-source.json` ships too), the whole font bank `runtime/assets/fonts/{palette.json,NOTICE.txt,css/<role>.css,<role>/*}`, `runtime/requirements.txt`, `open-editor.py` (starts `editor_handoff.present` for the unzipped folder, flags `--host --port --browser`), `OPEN.txt`. `ROOT/assets/editor` is the exact folder `server.py` uses as `EDITOR_DIR`; the unzipped runtime must therefore keep the layout `runtime/scripts/*.py` + `runtime/assets/editor/index.html` + `runtime/assets/fonts/`, which `server.py` resolves relative to its own location (`EDITOR_DIR = <scripts parent>/assets/editor`).
- `import_project`: validates names, sizes (512 MiB), no absolute/`..`/backslash/symlink members, loads manifest, checks pages and asset sha256, atomic move.
- Docs that mention the editor and must be kept truthful: `README.md:6,54,91,115`, `skills/popost/README.md:7,35,53`, `skills/popost/SKILL.md:22,38,46`, `skills/popost/references/editor-contract.md`, `references/host-editor.md`, `AGENTS.md:30-31,38`, `docs/后端接口对接说明.md` (sections 1.11 and file list at line 162), `docs/interface-contracts.json`, `TODO.md:75-79,87`, `PROGRESS.md`. Licence attributions for html-deck/CodeMirror stay until the rewrite removes derived code (`AGENTS.md:38`, `README.md:115`, `skills/popost/THIRD_PARTY_NOTICES`, `public/vendor/html-deck/LICENSE`, `codemirror/LICENSE`). The editor ships CodeMirror 5 files at `codemirror/{codemirror.js,codemirror.css,css.js,htmlmixed.js,javascript.js,xml.js,LICENSE}`, loaded by `index.html` and used by `ui/panels/code.mjs` through `window.CodeMirror`.

---

## 9. Tests touching the editor

All under `skills/popost/tests/` (Python `unittest`, Playwright with the Chromium found by `render_html.find_executable(None)`). They load the editor from `skills/popost/assets/editor` (not `public/`), so the rewrite must be synced there first. `run_all_tests.py` aggregates; `production_editor_e2e.py REPORT_DIR` runs only `SharedCanvas.test_product_canvas_edit_export_reset_and_portable_reopen` and writes `result.json`.

### 9.1 `test_shared_canvas.py` (class `SharedCanvas`)

Fixture: project 1080x1440, two pages (`p1` dark green background, `p2` cream), page markup `.post[data-canvas-width|height]` with `h1.title[data-layer-id=title]>span[data-slot]`, `img[data-layer-id=photo]`, `p.caption[data-layer-id=caption]>span[data-slot]`, `<link rel=stylesheet href="../css/cjk-sans.css">`, `:root{--ink}` and `.title:is(h1,h2)` selectors; real server started in-process on a free port; helper `request()` sends JSON with `Origin: <base>`.

| Test | What it asserts about the editor/server |
|---|---|
| `test_disk_edit_rejects_stale_canvas_without_losing_either_version` | `POST /api/project` with a stale `canvasRev` returns HTTP 409 and neither the agent version on disk nor the stale payload is lost |
| `test_initial_snapshot_survives_page_delete_and_save` | `GET /api/canvas-initial` content is identical before and after deleting a page via save; initial still has 2 pages; project has 1 page |
| `test_editor_bundle_is_recursive_and_keeps_licenses` | `export_project` zip contains `runtime/assets/editor/{js/app.mjs, js/services/local-api.mjs, codemirror/codemirror.js, LICENSE, codemirror/LICENSE}` byte-identical to `assets/editor`, `runtime/scripts/canvas_bridge.py`, font palette and licences, and no `reference/`, `production/`, `.popost-editor/` entries. NOTE: it hard-codes the file names `js/app.mjs`, `js/services/local-api.mjs`, `codemirror/codemirror.js` |
| `test_font_install_resources_preserves_unsaved_canvas_and_rejects_stale_revision` | `/api/font-install {roles, resourceOnly, canvasRev}` -> `cssInjected:false`, page unchanged, returned `canvasRev` differs from before and equals `GET /api/project` canvasRev; a second call with the old rev -> 409 and no `fonts/cjk-wenkai` directory |
| `test_font_menu_matches_bank_and_new_family_survives_save_export_and_reload` | `GET /editor.html`; `body[data-doc-state="ready"]`; `#tb-font option[data-font-id]` ids equal palette role ids; frame locator `#frame` then `.ed-cur [data-layer-id="title"] [data-slot]` click; `select_option(family)` on `#tb-font` (select is disabled during install and re-enabled); computed `font-family` contains family and `document.fonts.check`; clicking `#btn-save` issues a `POST /api/project` that is OK; `#btn-save` becomes enabled again; page file contains `data-popost-font="cjk-wenkai"`; after reload the family still applies; `#btn-download-images` triggers a download ZIP containing `p1.png` of size 1080x1440; no request leaves the origin |
| `test_http_preview_is_origin_checked_bounded_and_expires` | `POST /api/canvas-preview` with `{content, nonce:null}` -> URL; `GET` returns CSP containing `script-src 'none'`; foreign `Origin` -> 403; entry older than 600 s -> 404 (inspects `server.preview_cache` tuple `(time, bytes, csp)`) |
| `test_older_project_without_project_id_can_open_without_rewriting_pages` | manifest without `projectId`: `/editor.html` returns 200 with `window.__POPOST_LOCAL__` in the HTML text; page file not rewritten |
| `test_product_canvas_edit_export_reset_and_portable_reopen` | the big e2e: `#frame` `src` starts with `/_preview/`; `#panel[data-view="layers"].open` appears on load (layers panel auto-opens when viewport >= 900 px); opening does not rewrite files; frame has exactly 2 `.slide`; first `.slide` computed background `rgb(24, 60, 49)`; `#filmstrip .thumb` count/click switches `.ed-cur` (current slide class) and its background is `rgb(246, 243, 236)` (page CSS is scoped, not leaking); "Download all" ZIP `p1.png` pixel-identical to the server-rendered PNG; dblclick on `.ed-cur [data-layer-id="title"] [data-slot]`, `fill` text, `Tab` to commit; clicking `#btn-download-images` saves first (file now contains the text); reload shows the saved text; three save cycles via `#btn-save` do not show `#modal-reformat` (`.show` class), keep stored page size within 2000 chars (font CSS not accumulating); code panel: click `[data-panel="code"]`, wait `#panel[data-view="code"].open #code-save`, set text through `.CodeMirror` element's `.CodeMirror` instance (`getValue/setValue`), click `#code-save`, wait for `#code-status` text containing `代码已保存` (Chinese literal), file updated; `Control+d` with focus on first `#filmstrip .thumb` duplicates the page (3 thumbs), save -> manifest has 3 unique ids; `#btn-reset-layout` reverts to 2 thumbs; `#btn-undo` returns to 3; `GET /api/project-bundle` ok, import works, restored project has code-panel text and `runtime/assets/editor/js/app.mjs`; the original folder is moved away and the portable runtime serving the restored project (spawned by `python -c ... serve(Project.load(...),0)`) opens with 3 thumbs, 41 font options, applies `Inter Variable`, downloads a 3-file ZIP; at viewport 600x900 after reload `#panel` is not `open`, `.workspace` clientWidth > 450 and `.topbar` scrollWidth <= 600; no `pageerror` events |

### 9.2 `test_product_fonts.py` (class `ProductFonts`)

Serves a plain static HTTP server with symlinks `vendor/html-deck -> assets/editor` and `fonts/popost -> assets/fonts` (so the browser-mode editor runs with NO Python API and fonts discovered at `<root>/fonts/popost/`). Seeds legacy `localStorage` keys `popost-product:state` (`{projects:[{id:'font-test',title:'Font test'}]}` — note no `name`, only `id` needed), `popost-product:decks` (`{"font-test": <one `.slide` 1080x1440 deck with Chinese + Latin h1>}`) via an init script that only runs in the top window. Opens `/vendor/html-deck/index.html?file=font-test.html&embedded=0&popost=1`; waits `body[data-doc-state="ready"]`; menu ids equal palette; click `h1` inside `#frame`, `select_option('Inter Variable')` on `#tb-font`; computed font-family has `Inter Variable` and `Noto Sans SC Variable`; `document.fonts.check` for both; `#btn-save` click then wait until `#btn-save` is not disabled; waits until the IndexedDB value of `decks["font-test"]` (read through `import("./js/services/browser-storage.mjs")` and `refreshStored("decks",{})` — so that module path and export must exist at `js/services/browser-storage.mjs`) contains `data:font/woff2;base64,`, contains `SIL OPEN FONT LICENSE`, does not contain `fonts.googleapis.com`; then blocks `**/fonts/**`, reloads, document is `ready` again, fonts still render; no external requests, no `pageerror`.

### 9.3 `test_editor_delivery.py` (class `EditorDelivery`)

Touches the editor only through server/handoff: `server.preview_html(content, nonce)` keeps only the nonce'd inline script, removes `onload`, other scripts, `src`-bearing nonce script, injects `<base href="/pages/">`, CSP contains `connect-src 'none'`, invalid nonce raises `ValueError`; `editor_handoff.present` starts a real child process, reports `opened:false`, `requiresHostAction:true`, hostAction for `codex` (`target.url`), reuse of the same service (`reusedService:true`, same url, `hostAction.capability=='open_url_in_panel'` for unknown hosts, no `tool` key for `claude-code`, `doubao`, `generic`); PNG cache invalidation tests (not editor UI).

### 9.4 `test_studio_v2.py`

`test_server_endpoints` (`:70-105`): `GET /api/project` returns `manifest.pages[0].html`; `POST /api/project` with `{pages:[{id:'p1', html:'<div class="post" onclick=...><script>...</script><h1>Hi</h1></div>'}]}` and an `Origin` succeeds (`ok:true`) without `canvasRev`, width/height defaults; the on-disk page contains no `script` or `onclick` but keeps `hi`; POST without `Origin` -> 403.

### 9.5 `test_popost_workflow.py`

`test_portable_bundle_reopens_without_original` (`:128-142`): `export_project` zip includes `open-editor.py`, excludes `assets/private.json` and `production/config.json`; `import_project` restores and the restored page renders PNG.

### 9.6 Others

`test_font_palette.py` (palette schema, `install_project`; imports nothing from the editor but defines the font bank the editor menu mirrors); `test_render.py`, `test_post_bundle.py`, `test_template_plugins.py`, `test_mock_e2e.py` etc. do not reference the editor (grep over tests for `editor|html-deck|canvas_bridge|__POPOST` hits only the files above). There are NO frontend (vitest/jest) tests for the web app side of the embedding; `npm run lint` is typecheck + eslint of `src` only, so M1-M5 and the browser-mode `api.mjs` currently have zero automated coverage in this repo (only `test_product_fonts.py` and `production_editor_e2e.py` exercise browser mode and local mode respectively).

---

## 10. Compatibility checklist

### 10.1 Must keep (drop-in)

1. Entry file `public/vendor/html-deck/index.html` (path, name, location under `BASE`), loadable as a static page with no server API, relative asset URLs, and under `<base href="/_editor/">` in local mode; the literal `<head>` token for local injection.
2. Query parameters `popost, file, ratio, lang, revision, name, embedded, theme` with the meanings and value rules in section 1.3, including the ratio to canvas-size table (width 1080; heights 1080/1440/1920/1350; 1280x720 when no ratio), `embedded=0` standalone mode, `theme=dark|light`, `lang` default `zh`.
3. `window.__POPOST_PARAMS__` (string) support and a way to use it for ALL parameters, plus `__POPOST_PARAMS_INIT__`-replacement compatibility (the single-file bundler lives outside the repo).
4. `window.__POPOST_LOCAL__ {projectId,width,height,name}` switches to local mode; local mode uses the exact HTTP contract in section 4.2 (paths, payloads, `canvasRev`, 409, `ok:false`) and the `/_editor/` and `/_preview/` route conventions, `<base>` handling and `/pages/` relative path semantics.
5. postMessage contract M1-M5 exactly (fields, `source` strings, `id`/`requestId` echo, 120 s timeout, parent-origin target), including that `saved` is sent only after the storage flush and carries the project id; web app ignores unknown types.
6. Storage: IndexedDB `popost-workspace-v24` v1 store `records`, out-of-line keys, structured-cloned values; legacy `popost-product:*` localStorage migration; the module path `js/services/browser-storage.mjs` and its exports (`initStorage, readStored, writeStored, flushStorage, refreshStored`), `popost-storage-error` event, write-queue order and flush semantics.
7. Key shapes: `decks`, `initial-decks` (immutable, three `source` values), `revs` (string stamps, absent before first save, `"1"` default on load), `deck-history` (newest-first, max 5, `{name,content}`), `notes` (per project array of notes with op semantics), `state` (read-only for the editor; project must exist to open/save).
8. Browser-mode operations of section 3 with their return shapes (`load`, `save`, `initial`, `notes`, `list_html`, `config`, `export`, `preview`, `backups`), 409 rule (`body.rev && revs[id] && differ && !force`), `ensureInitialDeck` seeding rule, `initial` flags `available`/`reliable`.
9. Document model: a DOMParser copy where scripts never execute; saves splice minimal patches into the original text (byte-exact when untouched; doctype/comments preserved); `data-ed-id` never saved; live-only attributes never saved; 60 MiB cap; deck/page mode rules; `.slide` required; forced deck mode for Popost files via `gs9_editor_mode:<file>`.
10. Local markup rules: page root `.slide[data-popost-page]` / `.post` / `.page`; attribute set `data-popost-page|width|height|name`; `<style data-popost-style>`, `<style data-popost-head-style>` and the `@scope` model with `@font-face` hoisted; asset/css/font URL rewriting to `../...` from `/pages/`; split rules (unique ids `^[\w-]{1,64}$`, new `p-<12 hex>` for copies, role preserved, duplicate `@font-face` dedupe, at least one page).
11. Font contract: `<select id="tb-font">` options `value=family`, `data-font-id`, grouped by `role.group`; palette at `<base>/fonts/popost/palette.json` or `/api/font-palette`; embedded `<style data-popost-font="<id>">` with licence comment + base64 woff2 (browser) or `/css/<id>.css` text (local); CJK fallback (`cjk-sans`/`cjk-sans-tc`) added when Han text is present; font stack `"family", "fallback family", generic`; no network calls to third-party hosts.
12. Exports: "Download all" button `#btn-download-images` (web: M4/M5 flow with html-to-image in the app; local: save-then-`/api/export?page=all` with file `popost-images.zip`); web file names `<name>-图文.zip` / `<name>-<n>.png`; code panel static HTML download; single-file HTML export; PDF via print copy.
13. Code panel: CodeMirror 5 on `#canvas-code-source`, rail item `[data-panel="code"]`, `#panel[data-view="code"]`, `#code-save`, `#code-status` Chinese success text containing `代码已保存`, `#code-download-html`, `Ctrl/Cmd+S`, validation rules identical to `validateDeck`.
14. Shell DOM/test hooks: `body[data-doc-state=loading|ready|error]` (+ `data-doc-path`, `data-doc-seq`, `data-slide-count`), `#frame` (iframe whose `src` starts with `/_preview/` in local mode), `.ed-cur` (current slide inside the frame), `#filmstrip .thumb`, `#btn-save`, `#btn-undo`, `#btn-redo`, `#btn-reset-layout`, `#btn-export`, `#pop-export`, `#modal-reformat`, `#modal-conflict`, `#panel` (+ `.open`, `data-view`), `.workspace`, `.topbar`, `.CodeMirror`, layers auto-open (width >= 900) 120 ms after open, panel closed on narrow viewport (600 px), `Control+d` duplicate on a focused filmstrip thumb, text edit via double-click and commit on Tab/blur, save button disabled while saving, no horizontal overflow at 600 px.
15. Reset to initial layout as ONE undoable step using `/api/initial` semantics for both modes; undo restores the previous state including page count.
16. `data-layer-id`, `data-slot` and `data-canvas-width|height` attributes written by agents must survive editing unchanged; opening a project must never rewrite files (no save on open); repeated saves must not accumulate font CSS.
17. Server-side: sanitiser rules (4.4), preview CSP and 600 s / 16-entry cache, origin check on POST, 16 MiB preview cap, rollback on failed multi-page write, `.popost-editor/{initial.json,history,notes.json}` formats, history length 5, `canvasRev` definition, editor-info schema `popost-editor-info.v1` with version `3.3.1`.
18. Packaging: folder `public/vendor/html-deck/` copied whole to `skills/popost/assets/editor/` with `shared-source.json` (`{source, files{path: sha256}}`), `runtime/assets/editor/` in project ZIPs, `SOURCE-MANIFEST.sha256` regenerated, licence files kept until no derived code remains; file names asserted by tests (`js/app.mjs`, `js/services/local-api.mjs`, `js/services/browser-storage.mjs`, `codemirror/codemirror.js`, `LICENSE`, `codemirror/LICENSE`) either preserved or the tests updated in the same change.
19. Language: UI strings for `zh`, `en` (and ideally `zh-Hant`, `vi` that the shell currently supports), language chosen from the `lang` param, persisted in `gs9_editor_lang`; Chinese literals referenced by tests (`代码已保存`, `字体库加载失败` placeholder, error texts quoted in section 4.2) kept or the tests updated.
20. Dark mode: class `dark` on `<html>`, driven by `theme` param and M1; chrome follows, document content frame is never recolored.

### 10.2 Accidental or unsafe (candidates for a deliberate change, each needs a conscious decision)

1. M1 uses `targetOrigin '*'` and the editor accepts `popost-theme` from any window with no origin/source check (`CanvasPanel.tsx:9`, `index.html:12`). Payload is non-sensitive, but tighten to `location.origin` plus `event.source===window.parent` and keep M1 sent after `load` (today the first send is lost).
2. The `revs` check is bypassed whenever the deck was never saved by the editor, and the web app's `putDeck` does not bump `revs` or write `deck-history`; cross-tab staleness is undetected. Consider bumping `revs` in `putDeck` (changes semantics: needs both sides).
3. Whole-map read-modify-write of `decks`, `revs`, `deck-history`, `initial-decks` in `/api/save` (lost updates with concurrent app writes). A per-project key layout would be safer but is a storage schema change.
4. `window.__POPOST_PARAMS__` is only honoured for three params; the rest read `location.search`, so `srcDoc` mode likely depends on the unseen bundler (section 1.4). Unify.
5. Local server: no CSP on the editor page, `Access-Control-Allow-Origin` echo of 127.0.0.1, GET endpoints unauthenticated (anyone on loopback, including other local processes or a DNS-rebinding page, can read the project and `/api/project-bundle`; only POST checks `Origin` and a missing `Origin` is rejected). Consider a per-run token and `Host` validation for GET.
6. `/api/import-project` replaces the running project with an uploaded ZIP; `/api/font-install` writes into the project; both are POSTs guarded only by the Origin/Host comparison (the `Host` header is attacker-controlled under DNS rebinding, so Origin equal to Host passes). Add a fixed Host allow-list.
7. Server sanitiser silently drops comments and doctype, rewrites `<link>`s, and its policy differs from the web `validateDeck` (web rejects with an error; local silently removes). Align rules and make the failure mode consistent; `validateDeck` also lets `<style>@import`, `http(s)` images, `<link>` and `<noscript>` through while the local server strips external URLs.
8. Browser-mode `/api/export` returns the sanitised content without inlining assets; the local one returns unchanged content ("embedded:0"); the export menu's "download with web files" checkbox is inert in both.
9. `/api/trust`, `/api/restore`, `/api/watch`, `/api/backups` (empty), the whole feedback/notes review UI, effects/FX, present-mode, find, layers of Reveal format, version history modal, file list panel, language popup, speaker notes are hidden or inert by `css/popost.css:4` but still shipped; `deck-history` (5 revisions) has no reader in the UI. Decide per item whether the rewrite drops the feature (and the hidden DOM ids) or keeps it.
10. Pre-load `postMessage('saved'/'notes')` goes to `window.parent` even when the editor is top-level (`parent===window`), harmless but noisy; `notes` message type is never consumed.
11. `exportImages` instantiates a 1200x1600 off-screen iframe regardless of ratio and relies on `html-to-image` DOM cloning (known fidelity limits for `@scope`, fonts, `object-fit`); the local path uses Playwright and thus can differ pixel-wise from the web path.
12. Local mode `data-popost-*` plus inline `width/height` live on the root; `@scope` requires a Chromium version that supports it (>= 118); scoped CSS drops `@property` and relies on `CSSStyleSheet` constructor.
13. `editor_handoff.VERSION` (`3.3.1`) is duplicated in editor-info and handoff probing; a rewrite that bumps behaviour should bump it in one place.
14. `localStorage` keys `gs9_editor_*` and `htmldeck_*` (upstream-named) and the IndexedDB `gs9_editor` drafts DB carry the old product name; renaming loses users' remembered mode/draft (acceptable only if announced).
15. `sync-skill-editor.mjs` is destructive (delete then copy) and part of `prebuild`; make it atomic as part of the rewrite (TODO.md:87).
16. `server.py` branch for `/editor.js` and `/editor.css` points at nonexistent files (dead code).
17. `ProjectPreview.tsx` and `exportImages` ignore the real page size of each deck and assume 1080 width; fine for current ratios but wrong for custom sizes.
