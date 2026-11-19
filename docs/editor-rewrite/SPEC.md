# Popost canvas editor — rewrite spec

> **Path note (2026-11-01).** This is a historical record written before the repository was restructured. Paths in it refer to the old Popost-ai layout: `src/`, `public/`, `index.html` → `apps/web/…`; `editor/` → `packages/canvas-editor/`; `PROGRESS.md` → `docs/history/oss-cleanup-progress.md`; `docs/后端接口对接说明.md` → `docs/backend/integration-contracts.zh-CN.md`. Line numbers may have drifted. Later the same day `apps/web/` and `docs/backend/` were removed from this repository (it now holds only the skill and the canvas editor); the web app is part of the popost.ai website.

Status: v1.1 (2026-10-30; §6 changed to direct DOM access, no bridge script). Implemented as editor 4.0.0; parity results and the removal of the old editor: [PARITY.md](PARITY.md) (W3-F). Owner: Claude (spec, review). Implementers: Sonnet sub-agents, one module group each.
Inputs: [current-contracts.md](current-contracts.md) (external contracts, §10 checklist) and
[current-features.md](current-features.md) (what users see today).

## 0. Goals and non-goals

**Goals**

1. Replace the html-deck-derived editor (`public/vendor/html-deck/`, copy in `skills/popost/assets/editor/`) with new code we own,
   so the html-deck licence notice can be removed.
2. **Drop-in compatible**: the web app, the Python skill server, existing browser data and existing local projects keep working;
   replication and generation are unaffected. Everything in current-contracts.md §10.1 holds unless §2 below says otherwise.
3. Focused on social posts: fixed-size multi-page canvas, nothing slide-show specific.
4. Maintainable: TypeScript (strict), one source tree, one build, unit tests, i18n from day one.

**Non-goals (this rewrite)**: presentation mode, Reveal/other deck formats, FX/effects, speaker notes, feedback/notes UI,
file browser, remote-script trust, live file watching (SSE). Storage schema changes. Changes to the skill server's
security model (tracked separately in TODO.md).

## 1. Clean-room rules (mandatory for every implementer)

- Work only from this spec, `editor/src/contracts.ts`, current-contracts.md and current-features.md.
- **Do not open** html-deck's own files: anything under `public/vendor/html-deck/` or `skills/popost/assets/editor/` or the
  `html-deck/` repo, **except** these product-team files, which are ours and may be read and ported:
  `js/services/browser-storage.mjs`, `js/services/local-api.mjs`, `js/services/font-library.mjs`, `js/ui/canvas-download.mjs`,
  `js/ui/panels/code.mjs`, `css/popost.css`, `css/v35-surface.css`.
- Do not copy html-deck identifiers that are not part of an external contract (module names, internal function names, `S`
  state object, `data-ed-*` attributes, `gs9_*` / `htmldeck_*` keys). External contracts (DOM ids used by tests, message
  names, storage keys of our own product) are kept on purpose.
- Third-party libraries are normal npm dependencies with their licences; list bundled ones in `THIRD_PARTY_LICENSES.txt` (§9).

## 2. Compatibility decisions

Kept exactly (see current-contracts.md §10.1 for detail): query parameters (§1.3); `__POPOST_PARAMS__` / `__POPOST_LOCAL__`
globals; messages M1–M5 (§1.5) including field names and the 120 s download timeout; IndexedDB `popost-workspace-v24`
schema, keys and semantics (§2), including `ensureInitialDeck`, the 409 rule, `deck-history` (max 5) and "post `saved` only
after flush"; local-mode HTTP contract (§4.2) incl. `canvasRev` and 409; compile/split rules (§4.6); font embedding format
(§5.3); `validateDeck` rules (§5.4); "Download all" behaviour and file names (§6); test hooks listed in §10.1 item 14
(DOM ids, `body[data-doc-state]`, `#frame`, `.ed-cur` inside the frame, `#filmstrip .thumb`, Ctrl+D on a focused thumb, …);
agent-written attributes (`data-layer-id`, `data-slot`, `data-canvas-*`) survive untouched; opening never writes.

Deliberate changes (decisions on current-contracts.md §10.2):

| # | Decision |
|---|---|
| 1 | M1 is sent with `targetOrigin = location.origin`, re-sent after the iframe `load`; the editor accepts it only from `window.parent` with matching origin. |
| 2, 3 | Storage semantics unchanged (compatibility); per-project keys and app-side `revs` bump are future work. |
| 4 | One `readParams()` helper reads every parameter from `__POPOST_PARAMS__` first, then `location.search`. |
| 5, 6 | Out of scope (Python server); add to TODO.md. |
| 7 | One shared validator module (`editor/src/core/validate.ts`) used by the editor and imported by the web app's `validateDeck`. Rules unchanged. |
| 8 | Drop the inert "include web files" option; keep single-file HTML export only if current-features.md marks it "must". |
| 9 | Hidden features are not rebuilt (see §0 non-goals); their DOM ids disappear. |
| 10 | Never post to `window.parent` when `parent === window`. |
| 13 | Editor version lives in one place (`editor/src/version.ts`, mirrored by the Python constant); bump to `4.0.0`. |
| 14 | localStorage keys renamed to `popost-canvas:*`; read old `gs9_editor_lang` once as a fallback. Crash drafts: see §8. |
| 15 | `scripts/sync-skill-editor.mjs` is replaced by an atomic publish step (§9). |
| 16 | Remove the dead `/editor.js` / `/editor.css` branch in `server.py` during integration. |

## 3. Architecture

```
web app (React, CanvasPanel)              skill server (Python, /_editor/)
        │ iframe  canvas/index.html?…              │ same bundle + injected __POPOST_LOCAL__
        ▼                                          ▼
┌────────────────────────── editor shell (React, editor/src/ui) ──────────────────────────┐
│ topbar · filmstrip · canvas (scaled #frame + overlay: selection, handles, guides) ·     │
│ side panel (layers, properties, code) · modals · toasts                                 │
│        │ EditorController (editor/src/app)                                              │
│        ├── core: DocIndex · ops → splices · stable ids · history · pages · validate     │
│        ├── store: DocStore (browser IndexedDB | local HTTP)  ·  fonts                    │
│        ├── host: params · M1–M5 messages                                                │
│        └── frame: FrameController ── direct same-origin DOM access ──► #frame (no JS)  │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

**Source text is the single source of truth.** The controller holds the current HTML string and its `DocIndex`. Every user
action becomes an `EditOp`, compiled by `core/edits` into minimal splices of the source; untouched bytes never change, so a
document that is only opened and saved is byte-identical. The edit frame shows a *preview copy* of the source (ids injected
as `data-pp-id`, all scripts removed) and is kept in sync with `LiveUpdate`s through direct DOM access; it is never
serialised back. There is no DOM-to-source serialisation step and no "reformat" prompt.

## 4. Module layout

```
editor/
  index.html                 shell entry (has the literal <head> token the skill server injects into)
  src/contracts.ts           shared types (authoritative)
  src/version.ts
  src/core/                  pure TS, no DOM APIs except where noted; 100% unit-tested
    source.ts                parse5 → DocIndex (sourceCodeLocationInfo), attribute/style helpers
    ids.ts                   stable NodeIds across edits (offset mapping through splices)
    edits.ts                 EditOp → splices + inverse + LiveUpdate[]; locality check
    style.ts                 inline style parse/merge with minimal text change
    history.ts               undo/redo stacks, coalescing (key + 600 ms window), selective labels
    pages.ts                 page detection (`.slide` top level), size table, page ops helpers, page keys
    preview.ts               source → preview HTML (ids, selectable marks, sanitising, CSP meta, frame CSS, base href)
    validate.ts              validateDeck rules (shared with web app) + code-panel limits (60 MiB)
  src/storage/
    browser-storage.ts       port of the product's browser-storage.mjs (same exports and schema)
    browser-store.ts         DocStore for browser mode (current-contracts §3 semantics)
    local-store.ts           DocStore for local mode (§4.2), uses compile.ts
    compile.ts               compileProject / splitProject / scopedCSS (port of local-api.mjs)
  src/fonts/                 palette loading, menu model, CJK fallback, CSS embedding (port of font-library.mjs)
  src/host/                  readParams, local boot, M1–M5 messaging with origin checks, download relay
  src/frame/                 FrameController: preview URL lifecycle, DOM event translation, live updates, text editing
  src/app/                   EditorController: state machine (loading/ready/error), selection, pages, save, conflicts
  src/ui/                    React components, i18n (`zh`, `en`), theme, test hooks
  src/styles/                plain CSS with `--pc-*` variables (light + dark)
```

Dependencies: `react`, `react-dom` (already in the app), `parse5` (MIT), `codemirror@5` (MIT, already a dependency) for the
code panel. Dev: `vitest`, `happy-dom`. No other runtime dependency without updating this spec.

## 5. Document model and editing

- **Index**: `parseIndex(source): DocIndex` with parse5 `sourceCodeLocationInfo`. Elements without source locations
  (implied `<html>/<head>/<body>`) get ranges at their insertion points so ops still work.
- **Stable ids** (`ids.ts`): after an edit, an element keeps its id if its start offset maps (through the splices) onto the start
  of an element with the same tag in the new index; elements inside replaced ranges get new ids. Ids are `n<counter>`.
- **Ops** (`edits.ts`): see `EditOp`. Rules:
  - `setStyle` edits only the declarations it touches inside `style="…"` (adds the attribute if missing), preserving the rest
    byte-for-byte; property names lower-case; values are not reformatted.
  - `setAttr` replaces only the attribute value range; new attributes are appended before `>` / `/>`.
  - `setInnerHTML` replaces `startTagEnd..endTagStart`. Input HTML from the frame is cleaned (§6) before.
  - `duplicate` of a page root (top-level `.slide`): the copy gets `data-popost-page="p-<12 hex>"` when the original had one.
  - `move` / `remove` / `duplicate` keep the surrounding whitespace sensible (move the element's leading indentation with it).
  - After every op, re-parse and verify **locality**: the structure outside the changed ranges is unchanged (same tags/order).
    If not, reject the op with an error (the UI shows a toast); never write a broken document.
- **Positioning on drag/resize**: absolutely/fixed-positioned elements (local skill layers) → `left`/`top` (px); elements in
  normal flow (web-app posts) → the standalone CSS `translate` property (`translate: <x>px <y>px`), which matches what the
  current editor produces and leaves any existing `transform` untouched. Never move or transform a page root (the skill's
  render check flags root transforms). Resize: side handles → `width` (text reflows) / `width`+`height` for images; corner
  handles on text scale `font-size` proportionally; on images keep the aspect ratio. Values rounded to 1 px (0.5 for font
  sizes). Snapping (shell side): page edges and centre, other blocks' edges and centres, threshold 6 screen px, hold Alt to
  disable; guide lines and a size/offset tooltip while dragging.
- **Selectable blocks** (`core/pages.ts` helper `selectableBlocks`, marked as `data-pp-sel` in the preview; used by frame hit-testing, layers tree and marquee): descendants of a page
  root that carry `data-layer-id`, plus content elements — headings, `p`, `li`, `blockquote`, `figcaption`, inline text
  containers with direct text, `img`, `svg`, `picture`, `video`, and elements with a background image — excluding page roots,
  `.notes`, `style`, `script`, `template`. Click selects the nearest selectable ancestor-or-self; Alt/Cmd-click the deepest
  element; "select parent" walks up to the next selectable ancestor (stopping below the page root).
- **History**: each op produces one entry; drags/colour pickers coalesce by `coalesceKey` within 600 ms; text commits are one
  entry each; `replaceDocument` (code panel, reset layout) is one entry, so reset is undoable incl. page count. Undo/redo
  apply the stored splices and emit `{kind:'reload'}` or finer live updates.
- **Save**: content = current source. Browser: `DocStore.save` with the loaded `rev`; local: split + POST. Conflict (409)
  → `#modal-conflict` with "Reload" and "Overwrite" (force). Dirty flag = source differs from last saved source.

## 6. Edit frame (direct DOM, no bridge script)

Decision (v1.1): the edit frame is always **same-origin** with the editor (browser mode: a `blob:` URL created by the editor;
local mode: `/_preview/<uuid>.html` on the same skill server), so `frame/` accesses its document directly. The frame runs
**no scripts at all** (`script-src 'none'`); there is no injected bridge and no postMessage protocol between editor and frame.

- `preview.ts` builds the frame document: copy of the source with `data-pp-id` on every indexed element and `data-pp-sel` on
  selectable blocks (§5); removes `script`, `iframe`, `object`, `embed`, `base`, `meta[http-equiv]`, `on*` attributes,
  `javascript:` URLs; adds the CSP meta of current-contracts §3 with `script-src 'none'`; injects frame CSS (only the current
  page visible and marked `.ed-cur`, page at the frame's top-left, no outlines — the editor overlay draws them); in local mode
  adds `<base href="/pages/">`. Local mode still sends a random 32-hex nonce to `/api/canvas-preview` (server contract).
- `frame/controller.ts` implements `FrameController`: loads the URL from `DocStore.preview` into `#frame`, waits for `load`,
  then listens on the frame window/document and translates DOM events into `FrameToShell` events:
  pointer `down/move/up/dblclick/contextmenu` (id = nearest `[data-pp-sel]` ancestor-or-self, `deepId` = deepest element with
  `data-pp-id` under the page root; pointer capture on `down` so drags keep reporting), `hover` (rAF-throttled), `key`
  (not while typing in a contenteditable, except Ctrl/Cmd+S), `wheel` (Ctrl+wheel prevented), `drop` of image files (as
  data URLs), `fontsReady`. It applies `LiveUpdate`s by `data-pp-id` (subtree/insert parsing in the parent's context incl.
  SVG), switches the current page, and implements `measure` (getBoundingClientRect relative to the current page root;
  overflow = text block whose scroll size exceeds its client size or that sticks out of the page) and `styles`
  (getComputedStyle) synchronously.
- Inline text editing: `beginTextEdit` sets `contenteditable="true"` and focuses (caret end / select all / at point); paste is
  inserted as plain text; Enter inserts a line break; IME composition is respected (no key handling while composing);
  Tab, blur and Esc commit and leave edit mode (as today; undo restores), `endTextEdit{commit:false}` restores the original
  content. `format` is sent to the frame only when `textState.range` is true and applies to that range via `execCommand`
  (`styleWithCSS` on; font size/family/uppercase wrap the range in a `<span style>`); with no range the controller applies a
  `setStyle` batch to the whole block instead. `textState` is emitted on `selectionchange`. Committed HTML is cleaned: no
  `contenteditable`, `spellcheck`, `data-pp-*` attributes anywhere in it; an unchanged text commit produces no op.
- `LiveUpdate {kind:'reload'}` is never sent to the frame: the controller remounts the frame with the new index instead.
  A newer `mount` supersedes a pending one. The frame never runs page scripts, so frame-only adjustments (classes, inline
  styles on `<html>`/`<body>`, highlight attributes) are allowed — the frame DOM is never serialised.
- Layout changes the frame cannot be told about (image/font loads, resize observers) are reported as a `rects` event with
  `measure('page')` results, rAF-debounced.

## 7. Storage and fonts

- `browser-storage.ts`: same exported functions, DB name, store, keys, queue/flush and migration behaviour as the product's
  `browser-storage.mjs`; the web app switches its import to this module during integration.
- `browser-store.ts`: implements current-contracts §3 operations as `DocStore` methods (`load`, `save`, `initial`, preview via
  blob URL). After a successful save and flush, post M2 `saved`.
- `local-store.ts` + `compile.ts`: port of `local-api.mjs` with identical compile/split/scopedCSS results (§4.6), `canvasRev`
  handling, font install (`resourceOnly:true`), and download (save then `GET /api/export?page=all` → `popost-images.zip`).
- `fonts/`: menu from `palette.json` (`<base>/fonts/popost/palette.json` in browser mode, `/api/font-palette` in local mode),
  grouped by `role.group`, `<select id="tb-font">` options as today; embedding format and CJK fallback as current-contracts §5.3.

## 8. UI scope (from current-features.md)

v1 = every "must" row plus the cheap "nice" rows listed here. Section numbers refer to current-features.md.

- **Top bar** (§1.1): undo/redo (`#btn-undo`, `#btn-redo`, disabled when empty), reset to initial layout (`#btn-reset-layout`,
  one undoable step, own toast text), save state indicator (saved / unsaved / saving / error, dot on the save button, bullet in
  the document title), save (`#btn-save`, Ctrl/Cmd+S, disabled while saving), conflict modal (`#modal-conflict`: reload /
  overwrite), export menu (`#btn-export` → `#pop-export`: "Save as HTML" single file; PDF is dropped in v1),
  "Download all" (`#btn-download-images`, busy label), dark theme, zh/en, `beforeunload` prompt when dirty.
  Not in v1: crash-draft recovery, fullscreen, version history, document-name badge.
- **Pages** (§1.2): filmstrip `#filmstrip` of live `.thumb` previews (page number, click to open, active outline, re-render
  ~450 ms after edits, overflow badge), context menu (duplicate, move left/right, delete), drag reorder, focused-thumb keys
  (Delete, Ctrl+D, Alt+←/→), "add page" (new: duplicates the current page's structure with its text emptied — nice, last),
  prev/next + counter, ←/→/PageUp/PageDown when nothing is selected, zoom (fit default, slider 10–300 %, percent label =
  fit, Ctrl/Cmd +/−/0, Ctrl+wheel), stage scroll, click on empty stage deselects, text-overflow indicator (count + jump + toast).
- **Side rail + panel `#panel`** (§1.3): rail `[data-panel="text"|"block"|"layers"|"code"]`, one panel open, click again or ✕
  to close, Layers open by default (≥ 900 px wide, 120 ms after open), closed on narrow viewports.
  Text panel: add heading/subheading/paragraph (inserted after the selected block, else at the end of the current page);
  document colours + 28 presets + custom picker. Block panel: background colour, corner radius, padding, margin, border,
  shadow presets, opacity, "reset size" for images. Layers: tree of the current page's selectable blocks with kind and text/alt
  snippet, click selects, hover highlights, drag to reorder among siblings (no re-nesting in v1).
  Code panel: CodeMirror 5 on `#canvas-code-source`, `#code-save` (validate → `replaceDocument`, undoable), `#code-status`
  (success text contains `代码已保存` in zh), `#code-download-html` (static copy rules of current-contracts §5.4).
- **Selection and layout** (§1.4): click select with hover outline, floating pill (move handle, select parent, duplicate,
  delete, bring forward / send backward), drag move with snapping, resize handles (4 corners + 2 sides), arrow nudge (1 px,
  Shift 10 px), marquee and Shift-click multi-select (group move/nudge/delete as one undo step, "Selected N"), Esc semantics
  (popover → text edit → selection), Ctrl+D / Delete with "Deleted · Ctrl+Z to undo" toast, Alt+↑/↓ reorder. No AI-feedback
  button, no SVG text overlay.
- **Text** (§1.5): double-click or Enter to edit inline, IME-safe, paste as plain text, Esc leaves edit mode; formatting applies
  to the selected range while editing, else to the whole block: bold, italic, underline, strike, colour, size (input + ±);
  font family `<select id="tb-font">` from the palette (unknown document fonts shown as a disabled entry), alignment
  (L/C/R/J), line height and letter spacing, uppercase toggle, opacity, clear formatting, copy/paste style (Ctrl+Alt+C/V).
  No link tool. Font embedding format unchanged in v1 (subsetting is future work).
- **Images** (§1.6): replace popover (upload, pick an image already in the document, paste URL when it can be fetched),
  drop a file on an image, crop & align mode (drag to set `object-position`, cover / contain, Esc/Done), opacity. Images are
  embedded as data URIs (browser) or imported via the server only if it already supports it (otherwise data URIs). No alt
  text, no flip, no "reset original" in v1.
- **Plumbing** (§1.7): toasts, loading overlay, error state, sanitised preview.
- **Test hooks kept**: `body[data-doc-state|data-doc-path|data-doc-seq|data-slide-count]`, `#frame`, `.ed-cur` on the current
  page inside the frame, `#filmstrip .thumb`, the ids above, `.workspace`, `.topbar`, `.CodeMirror`, no horizontal overflow at
  600 px.

Keyboard map = current-features.md §2 minus Ctrl+K and the unbound Find/Replace/Note keys.

## 9. Build, packaging, integration

- `npm run build:editor` → `editor/dist/`; `scripts/publish-editor.mjs` copies it to `public/canvas/` (gitignored) and
  `skills/popost/assets/canvas/` (committed) via a temp folder + rename (never delete-then-copy in place), writes
  `build-info.json` (version, file hashes) and `THIRD_PARTY_LICENSES.txt` (licences of bundled packages).
- Web app: `CanvasPanel` iframe → `canvas/index.html?…` (same params); `src/lib/popost.ts` imports storage from
  `editor/src/storage/browser-storage.ts`; `validateDeck` delegates to `editor/src/core/validate.ts`. `prebuild`/`predev` run
  the editor build + publish before the font sync.
- Skill: `/_editor/` serves `assets/canvas/`; same global injection; `project_bundle.py` packs `assets/canvas/` as
  `runtime/assets/canvas/`; editor version in one Python constant; tests updated for new paths in the same change.
- Removal (last step, only after parity passes): `public/vendor/html-deck/`, `skills/popost/assets/editor/`,
  `scripts/sync-skill-editor.mjs`, html-deck licence/notice entries, `SOURCE-MANIFEST.sha256` regenerated.

## 10. Testing and parity

- Unit (vitest): core (source, ids, edits incl. locality and byte-exact no-op save, style, history, pages, preview, validate),
  storage (fake IndexedDB), compile/split (fixtures from real skill projects), fonts, host params/messages.
- Browser (Playwright, Python, `$SCRATCH`): the existing skill tests (`test_shared_canvas.py`, `production_editor_e2e.py`,
  `test_product_fonts.py`, `test_editor_delivery.py`, `test_studio_v2.py`) and the web smoke (`smoke.py`) must pass against
  the new editor, plus a parity script that walks every "must" feature from current-features.md in both modes.
- Done = all of the above green, no html-deck files left, `rg -i 'html-?deck|htmldeck|gs9_'` clean outside docs/history.

## 11. Work breakdown

| Wave | Package | Owner | Depends on |
|---|---|---|---|
| W1 | A. `core/*` | Sonnet (higher effort) | contracts.ts |
| W1 | B. `storage/*`, `fonts/*`, `host/*` | Sonnet | contracts.ts |
| W2 | C. `frame/*` | Sonnet | A |
| W2 | D. `app/*`, `ui/*`, `styles/*` | Sonnet | A, B, C interfaces |
| W3 | E. build/publish, web + skill integration, test updates | Sonnet + Claude | A–D |
| W3 | F. parity tests, fixes, removal of html-deck | Claude (+ Sonnet for scripts) | E |

Claude reviews every package (diff + tests) before the next wave starts, and commits after each wave.
