# Canvas editor parity (W3-F)

> **Path note (2026-11-01).** This is a historical record written before the repository was restructured. Paths in it refer to the old Popost-ai layout: `src/`, `public/`, `index.html` → `apps/web/…`; `editor/` → `packages/canvas-editor/`; `PROGRESS.md` → `docs/history/oss-cleanup-progress.md`; `docs/后端接口对接说明.md` → `docs/backend/integration-contracts.zh-CN.md`. Line numbers may have drifted. Later the same day `apps/web/` and `docs/backend/` were removed from this repository (it now holds only the skill and the canvas editor); the web app is part of the popost.ai website.

Result of walking every "must" row of [current-features.md](current-features.md) (44 rows) against the new editor (4.0.0),
in both hosting modes, with the old editor already removed from the repository.

| Mode | must pass | must fail | n/a | nice rows checked (pass / fail) |
|---|---|---|---|---|
| browser (built web app via `vite preview`, editor in the CanvasPanel iframe at `/canvas/p1`) | 44 | 0 | 0 | 3 / 0 |
| local (skill server on a scratch project, editor at `/editor.html`) | 42 | 0 | 2 | 3 / 0 |

The two local "n/a" rows are not applicable by definition: F06 is a web-app route; F07 (theme) is light-only in local mode
in the inventory itself (row "Local = no"). The extra rows N01-N03 are "nice" rows that v1 implements (Code panel,
"Save as HTML", copy/paste style). E00 asserts that no uncaught page error happened during the run.

## How to reproduce

```bash
npm run build        # web app incl. editor (prebuild publishes it) and font library
PLAYWRIGHT_CORE=<dir with node_modules/playwright-core> CHROME_PATH=/usr/bin/google-chrome \
POPOST_PYTHON=<python with skills/popost/requirements.txt> PLAYWRIGHT_CHROMIUM=/usr/bin/google-chrome \
  node docs/editor-rewrite/tools/parity_check.mjs --md /tmp/parity.md
```

`parity_check.mjs` starts `vite preview` itself (or uses `PARITY_WEB_URL`) and `tools/parity_local_server.py` (scratch skill
project: 3 pages, same blocks as the browser fixture). `PARITY_MODES=browser|local` and `PARITY_ONLY=<regexp>` narrow the run.
Exit code 1 if any row fails. A full run takes about 20 minutes (font loads, server-side PNG renders).

## "Must" rows that changed on purpose (all decided in SPEC; none failing)

| Row | Change | SPEC |
|---|---|---|
| Reset to initial layout (F02) | Toast now says it was reset (the old toast reused the "opened ..." text); still one undoable step and leaves the document dirty. | §8 Top bar |
| Page filmstrip (F09) | The overflow badge shows only on the *current* page's thumbnail (other pages are not measured). Accepted gap, tracked in TODO.md section 4. | §8 Pages |
| Rail / Layers panel (F15, F19) | Layers reorder among siblings only: no re-nesting, no collapse/expand of nested rows. | §8 Side rail |
| Floating pill (F21) | No "more" menu and no AI-feedback button; select parent, duplicate, delete, forward/backward are direct buttons. | §8 Selection and layout |
| Shift-click multi-select (F26) | No AI-feedback button (the row says drop). | §8 |
| Locked / protected blocks (F29) | The old per-node edit policy is replaced by the splice design: only the touched bytes of the source change, untouched markup (scripts, agent attributes such as `data-layer-id`, `data-slot`, `data-canvas-*`) is kept byte-for-byte, and the edit frame runs no scripts. Checked: open + save is byte-identical, attributes survive, no editor-only attributes are saved, font CSS does not accumulate. | §3, §5, §6 |
| UI language (F08) | zh and en only (the row says drop vi / zh-Hant); `popost-canvas:lang` replaces `gs9_editor_lang` (the old key is still read once as a fallback). | §2 decision 14 |
| Font family / Font size (F32, F33) | With a text range selected, choosing a font (or typing a size) commits the edit and applies to the whole block; the size buttons and colour apply to the range. Font embedding format unchanged. | §8 Text (W2-D2b decision) |
| Sanitisation / safe preview (F44) | No guard/bridge script in the frame; the preview CSP is a `<meta>` with `script-src 'none'` in browser mode, and the skill server sends its own CSP header (script-src only a random nonce that no preview script carries). The code panel rejects documents with scripts. | §6 |
| Download all (F05) | Unchanged (browser: zip via the web app; local: `popost-images.zip` via the server renderer). PDF export is gone. | §2 decision 8, §8 |
| Keyboard | Ctrl+K and the unbound Find/Replace/Note keys are gone; Ctrl+B/I/U work on the selected text range while editing (native), not on a selected block. | §8 keyboard map |

## Observations that are not failures

- The skill server refuses a page that contains an iframe or other external references when it loads the project (old server
  behaviour, unchanged); F44 in local mode therefore exercises `<script>` and `on*` attributes only, browser mode also
  iframes, objects and `javascript:` URLs.
- Moving one of two textually identical pages (for example a fresh duplicate) with "Move left/right" changes nothing in the
  source, so nothing visibly happens; with distinct pages the current page follows its content.
- Known editor gaps carried to TODO.md section 4: undo of a `move` re-ids the block (selection dropped), thumbnails are full
  documents, the code panel is not lazy-loaded.

## Results

| # | Feature | Mode | Result | Note |
|---|---|---|---|---|
| F01 | Undo / Redo buttons | browser | pass | 10 checks |
| F02 | Reset to initial layout | browser | pass | 7 checks |
| F03 | Save state indicator | browser | pass | 5 checks |
| F04 | Save button (Ctrl/Cmd+S) | browser | pass | 7 checks; before.length=1918 |
| F05 | "Download all" (images) | browser | pass | 3 checks; Parity project-图文.zip, 187509 bytes, 3 png names |
| F06 | Standalone route /canvas/:id | browser | pass | 2 checks |
| F07 | Theme (light/dark) | browser | pass | 3 checks |
| F08 | UI language | browser | pass | 3 checks; default (no param) = en |
| F09 | Page filmstrip | browser | pass | 7 checks |
| F10 | Page context menu | browser | pass | 11 checks |
| F11 | Page drag-reorder | browser | pass | 3 checks |
| F12 | Prev / next page + counter | browser | pass | 7 checks |
| F13 | Zoom | browser | pass | 9 checks |
| F14 | Stage panning / scroll | browser | pass | 3 checks |
| F15 | Rail: Text / Block / Layers / Code | browser | pass | 8 checks |
| F16 | Text panel: add text | browser | pass | 6 checks |
| F17 | Text panel: colour swatches | browser | pass | 4 checks |
| F18 | Block panel: background colour | browser | pass | 5 checks |
| F19 | Layers panel | browser | pass | 7 checks |
| F20 | Click to select | browser | pass | 4 checks |
| F21 | Floating pill | browser | pass | 9 checks |
| F22 | Drag to move | browser | pass | 7 checks |
| F23 | Resize handles | browser | pass | 4 checks |
| F24 | Arrow-key nudge | browser | pass | 3 checks |
| F25 | Marquee selection | browser | pass | 4 checks |
| F26 | Shift-click multi-select | browser | pass | 6 checks |
| F27 | Duplicate / Delete block | browser | pass | 4 checks |
| F28 | Z-order | browser | pass | 3 checks |
| F29 | Locked / protected blocks (AI HTML kept intact) | browser | pass | 7 checks |
| F30 | Inline text editing | browser | pass | 7 checks |
| F31 | Partial-range formatting | browser | pass | 7 checks |
| F32 | Font family | browser | pass | 8 checks |
| F33 | Font size | browser | pass | 5 checks |
| F34 | Bold / Italic / Underline / Strikethrough | browser | pass | 6 checks |
| F35 | Text colour | browser | pass | 4 checks |
| F36 | Alignment | browser | pass | 5 checks |
| F37 | Letter spacing + line height | browser | pass | 3 checks |
| F38 | Clear formatting | browser | pass | 3 checks |
| F39 | Block button in toolbar | browser | pass | 1 checks |
| F40 | Replace image popover | browser | pass | 8 checks |
| F41 | Drop file on image | browser | pass | 3 checks |
| F42 | Crop and align | browser | pass | 9 checks |
| F43 | Toasts | browser | pass | 4 checks |
| F44 | Sanitisation / safe preview | browser | pass | 4 checks; code-panel save with <script>: Only static HTML is supported. Scripts, event handlers and e; saved source keeps hostile markup byte-for-byte (spliced edits only) |
| N01 | Code panel (nice) | browser | pass | 6 checks |
| N02 | Export menu: Save as HTML (nice) | browser | pass | 2 checks |
| N03 | Copy / paste style (nice) | browser | pass | 1 checks |
| E00 | No uncaught page errors during the run | browser | pass | 0 errors |
| F01 | Undo / Redo buttons | local | pass | 10 checks |
| F02 | Reset to initial layout | local | pass | 7 checks |
| F03 | Save state indicator | local | pass | 5 checks |
| F04 | Save button (Ctrl/Cmd+S) | local | pass | 6 checks; before.length=1077 |
| F05 | "Download all" (images) | local | pass | 3 checks; popost-images.zip, 27283 bytes, 3 png names |
| F06 | Standalone route /canvas/:id | local | n/a | web-app route only (local mode is /editor.html, covered by every other row) |
| F07 | Theme (light/dark) | local | n/a | local mode is light only by design (current-features row: Local = no) |
| F08 | UI language | local | pass | 3 checks; default (no param) = zh |
| F09 | Page filmstrip | local | pass | 7 checks |
| F10 | Page context menu | local | pass | 11 checks |
| F11 | Page drag-reorder | local | pass | 3 checks |
| F12 | Prev / next page + counter | local | pass | 7 checks |
| F13 | Zoom | local | pass | 9 checks |
| F14 | Stage panning / scroll | local | pass | 3 checks |
| F15 | Rail: Text / Block / Layers / Code | local | pass | 8 checks |
| F16 | Text panel: add text | local | pass | 6 checks |
| F17 | Text panel: colour swatches | local | pass | 4 checks |
| F18 | Block panel: background colour | local | pass | 5 checks |
| F19 | Layers panel | local | pass | 7 checks |
| F20 | Click to select | local | pass | 4 checks |
| F21 | Floating pill | local | pass | 9 checks |
| F22 | Drag to move | local | pass | 7 checks |
| F23 | Resize handles | local | pass | 4 checks |
| F24 | Arrow-key nudge | local | pass | 3 checks |
| F25 | Marquee selection | local | pass | 4 checks |
| F26 | Shift-click multi-select | local | pass | 6 checks |
| F27 | Duplicate / Delete block | local | pass | 4 checks |
| F28 | Z-order | local | pass | 3 checks |
| F29 | Locked / protected blocks (AI HTML kept intact) | local | pass | 7 checks |
| F30 | Inline text editing | local | pass | 7 checks |
| F31 | Partial-range formatting | local | pass | 7 checks |
| F32 | Font family | local | pass | 8 checks |
| F33 | Font size | local | pass | 5 checks |
| F34 | Bold / Italic / Underline / Strikethrough | local | pass | 6 checks |
| F35 | Text colour | local | pass | 4 checks |
| F36 | Alignment | local | pass | 5 checks |
| F37 | Letter spacing + line height | local | pass | 3 checks |
| F38 | Clear formatting | local | pass | 3 checks |
| F39 | Block button in toolbar | local | pass | 1 checks |
| F40 | Replace image popover | local | pass | 8 checks |
| F41 | Drop file on image | local | pass | 3 checks |
| F42 | Crop and align | local | pass | 9 checks |
| F43 | Toasts | local | pass | 4 checks |
| F44 | Sanitisation / safe preview | local | pass | 4 checks; code-panel save with <script>: Only static HTML is supported. Scripts, event handlers and e; local: only script + on* attribute exercised (the skill server refuses pages with iframes / external references at load, unchanged server behaviour) |
| N01 | Code panel (nice) | local | pass | 6 checks |
| N02 | Export menu: Save as HTML (nice) | local | pass | 2 checks |
| N03 | Copy / paste style (nice) | local | pass | 1 checks |
| E00 | No uncaught page errors during the run | local | pass | 0 errors |
