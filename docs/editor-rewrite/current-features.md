# Current editor feature inventory (html-deck vendored in Popost)

> **Path note (2026-11-01).** This is a historical record written before the repository was restructured. Paths in it refer to the old Popost-ai layout: `src/`, `public/`, `index.html` → `apps/web/…`; `editor/` → `packages/canvas-editor/`; `PROGRESS.md` → `docs/history/oss-cleanup-progress.md`; `docs/后端接口对接说明.md` → `docs/backend/integration-contracts.zh-CN.md`. Line numbers may have drifted. Later the same day `apps/web/` and `docs/backend/` were removed from this repository (it now holds only the skill and the canvas editor); the web app is part of the popost.ai website.

Scope: what users actually see and can do today, to define parity for the clean-room rewrite.
Observed on branch `chore/oss-cleanup`, built `dist/` served by `vite preview` (product mode) and the skill CLI `serve` (local skill mode).
Source root for all citations: `public/vendor/html-deck/` (abbreviated `hd/`). Behaviour only, no source pasted.

Screenshots (all under `/tmp/claude-501/-Users-bytedance-Documents-sora-openpost/1107010e-eea4-46a1-b03e-76361b648d0b/scratchpad/e1b/`):
home composer `home.png`; canvas opened `canvas0.png`; text selected `sel-h1.png`; inline edit `edit-h1.png`, `inline.png`; image selected + replace popover `pop-img.png`; crop mode `crop.png`; panels `panel-text.png`, `panel-box-h1.png`, `panel-code.png`, layers in `canvas0.png`; slide context menu `slide-menu.png`; more menu `pill-more.png`, `pill-more-img.png`; multi-select `multi.png`; export menu `export-menu.png`; PDF attempt `pdf.png`; dark theme `dark.png`; standalone route `canvas-route.png`; local skill mode `local0.png`, `local-sel.png`, `local-export.png`, `local-menu.png`.

## 0. How the editor is hosted (context for parity)

- Product mode: the editor is an iframe `hd/index.html?popost=1&file=<id>.html&ratio=3:4&lang=zh&revision=N&name=...&embedded=1&theme=light`. It is opened from the chat session ("open product workbench" card, which shows the canvas in a tab inside the session page) or standalone at `/canvas/:id` (`embedded=0`, adds left padding on the top bar, `hd/css/popost.css`). Storage is browser-only (IndexedDB/localStorage under `popost-product:` prefix), not a server (`hd/js/services/api.mjs:1-43`, `hd/js/services/browser-storage.mjs`). Parent talks to the iframe by postMessage: theme (`popost-theme`), "download all images" request/response, "saved" signal (`src/components/CanvasPanel.tsx`).
- Local skill mode: same UI at `http://127.0.0.1:PORT/editor.html` (top-level page, no parent). `window.__POPOST_LOCAL__` switches the adapter to a Python server (`hd/js/services/local-api.mjs`); each page is its own HTML file on disk, merged into one deck of scoped sections on load and split back on save (`local-api.mjs:57-109`, `skills/popost/references/editor-contract.md`).
- Document model: the whole thing is "HTML deck" mode. Each post page is a `<section class="slide">` (product) or `.post`/`.page` root converted into a `.slide` (local). Pages are sized from the deck (1080x1440 etc.), thumbnails are 132x76 sandboxed iframes (`hd/js/ui/slides.mjs:12-40`).
- Product posts are flow layout: label, h1, img, caption stacked in normal flow; "move" writes a CSS `translate`, size changes write width/height/font-size. Local skill posts are absolutely positioned layers (`data-layer-id`, `data-slot`).
- Language/theme: UI language comes from the `lang` URL param (product: Popost locale) or `gs9_editor_lang` localStorage; the in-editor language switcher is hidden (`popost.css`, `#pop-lang`). Theme: parent posts light/dark; editor toggles `html.dark` (`hd/index.html:10-12`; `hd/css/popost.css` dark block). Page paper stays white in dark mode.

## 1. Main feature table

Legend: Product / Local = reachable by a normal user today. Needed: must / nice / drop.

### 1.1 Top bar and document-level

| Feature | What it does (user-visible) | Product | Local | Source | Needed? |
|---|---|---|---|---|---|
| Undo / Redo buttons | Two icon buttons, disabled when stack empty; undo/redo covers every op (text, style, move, slide ops, delete, reset layout). History cap 300 ops. | yes | yes | `ui/chrome.mjs:44-45`, `core/history.mjs:6`, `editor/commands.mjs` | must - baseline editing expectation |
| Reset to initial layout ("还原初始布局") | Restores all pages to the originally generated content/style/order; undoable; leaves doc dirty. Initial snapshot is stored once at first save/open (`/api/initial`). Shows a toast reading like "opened X.html · 3 slides · 9 editable blocks" (misleading, see quirks). | yes | yes | `app.mjs:46`, `editor/document.mjs` (resetLayoutToInitial), `services/api.mjs:30-43`, `local-api.mjs` | must - the product's safety net for AI output |
| Save state indicator | Cloud icon + text: "All changes saved" / "Unsaved changes" / saving / error; Save button gets an orange dot when dirty. Doc title in tab shows a bullet when dirty. | yes | yes | `ui/chrome.mjs:34-57` | must - users need to trust persistence |
| Save button (Ctrl/Cmd+S) | Writes current deck. Product: to browser storage + keeps last 5 history snapshots, raises "saved" to parent. Local: writes page files to disk, backups under `.popost-editor/history`. Conflict modal if the stored revision changed elsewhere. | yes | yes | `services/save.mjs`, `services/api.mjs` (save action), `editor/document.mjs`, `ui/bindings.mjs:51-56` | must - core |
| Autosave / draft recovery | Dirty docs are periodically written as a draft (IndexedDB) and offered back after crash/reload; `beforeunload` prompt when dirty. Not a true autosave (explicit Save still needed). | yes | yes | `services/drafts.mjs`, `ui/bindings.mjs:59-60`, `ui/chrome.mjs:58` | nice - simple dirty-guard is enough; real autosave would be better |
| Save dropdown: HTML export | "Save as HTML": single file with all images, styles, scripts inlined. Product returns the live content (sanitised preview copy); no remote inlining. | yes | yes | `ui/bindings.mjs:104-112`, `services/export.mjs:21-45`, `services/api.mjs` (/api/export) | nice - social posts ship as images; HTML is for backup/portability |
| Save dropdown: PDF export | Opens a new tab with a print layout (one page per slide) and triggers the browser print dialog. No file download event; popup-blocker dependent. | yes | yes | `services/export.mjs:50-84`, `present/print.mjs` | nice - rarely needed for posts; could be replaced by PNG/ZIP |
| "Download all" (images) | Product: posts the live HTML to the parent, which renders every page to PNG and downloads `<name>-图文.zip`. Local: server renders PNGs (needs Python Playwright, not installed in my venv: failed with "No module named 'playwright'") and downloads `popost-images.zip`. Button shows "Downloading..." while busy; label EN/ZH. | yes | yes (needs Playwright server side) | `ui/canvas-download.mjs`, `services/local-api.mjs:142-153`, `src/components/CanvasPanel.tsx` | must - the actual deliverable of the product |
| Version history modal | Lists kept revisions and restores one. Code exists (`#modal-history`) and the menu item is built, but CSS hides it in both modes (`#export-history{display:none!important}`). | no (hidden) | no (hidden) | `services/history.mjs`, `css/popost.css:3`, `ui/bindings.mjs:104-112` | drop - hidden today; at most nice later |
| Document name / mode badge | Doc name and "deck - N" badge in top bar; hidden by CSS. | no | no | `ui/chrome.mjs:47-56`, `css/popost.css` | drop |
| Fullscreen stage | Bottom-right button toggles browser fullscreen on the stage area (not a slideshow; same edit view). | yes | yes | `ui/bindings.mjs:87` | nice - minor |
| Standalone route `/canvas/:id` | Same editor outside the chat, full width; tab bar absent. | yes | n/a | `src/pages/CanvasPage.tsx`, `hd/js/app.mjs:40` | must - deep link to a post's canvas |
| Theme (light/dark) | Editor chrome follows workspace theme via postMessage; canvas paper unchanged. | yes | no (light only) | `hd/index.html:10-12`, `css/popost.css` dark section | must - Popost ships dark mode |
| UI language | zh/en (also vi, zh-Hant strings exist). Chosen by `lang` param; no in-editor switcher. | yes | yes (zh default; stored lang) | `js/i18n.mjs`, `ui/language.mjs`, `shared/lang.mjs` | must - zh + en; drop vi/zh-Hant unless Popost ships them |

### 1.2 Pages (filmstrip) and canvas navigation

| Feature | What it does | Product | Local | Source | Needed? |
|---|---|---|---|---|---|
| Page filmstrip | Bottom strip of live thumbnails with page number badge; click jumps to page; title tooltip "N. <first heading>"; active page outlined orange; thumbnails re-render ~450 ms after edits; red "!" badge on thumbs with text overflow. | yes | yes | `ui/slides.mjs:12-90`, `features/overflow.mjs` | must - multi-page posts are the core model |
| Page context menu (right click on thumb) | Duplicate page, move left, move right, delete page. | yes | yes (duplicate verified) | `ui/slides.mjs:88-125,150-195`, `editor/slide-actions.mjs` | must - needed page ops |
| Page drag-reorder | Drag a thumb to a new slot (drop-before/after indicator). | yes | yes | `ui/slides.mjs:99-124` | must |
| Page keyboard ops | Focused thumb: Delete = delete page, Ctrl+D = duplicate, Alt+Arrows = move. | yes | yes | `ui/slides.mjs:131-148` | nice |
| Add blank / new page | Does not exist in UI (only duplicate). Local CLI `page add` creates pages outside the editor. | no | no | n/a | nice - a social editor probably wants "add page" |
| Prev / next page + counter | Bottom bar `< 1 / 3 >`; Arrow keys when nothing selected (deck mode); PageUp/PageDown. | yes | yes | `ui/chrome.mjs:60-64`, `ui/keyboard.mjs:80-85` | must |
| Zoom | Slider, percent label (click = fit), fit button, Ctrl/Cmd +/-/0, Ctrl+wheel; range 10-300%; default fit-to-stage. | yes | yes | `ui/layout.mjs`, `ui/keyboard.mjs:41-43`, `ui/bindings.mjs:61,182-185` | must |
| Stage panning / scroll | Stage scrolls when zoomed; clicking empty stage deselects. | yes | yes | `ui/bindings.mjs:62-68` | must |
| Text overflow warning | Bottom-left "N text overflow" (clickable to jump to next) + toast right after edit "edited text exceeds its box" + red thumb badge. | yes | yes | `features/overflow.mjs`, `ui/bindings.mjs:48` | nice - very useful for fixed-size posts |
| Page-mode (non-deck) | Scrolling HTML page with section tracking and width picker (1600 default). Unused for posts: only reached if a doc has no slides; width picker hidden. | no | no | `ui/chrome.mjs:12-25`, `editor/document.mjs:248-252` | drop |

### 1.3 Side rail and panels

| Feature | What it does | Product | Local | Source | Needed? |
|---|---|---|---|---|---|
| Rail: Text / Block / Layers / Code | Four left-rail buttons open one side panel at a time; click the active one again to close; X button closes. Layers panel opens by default. | yes | yes | `index.html:90-96`, `ui/panels/side-panel.mjs:13-35` | must (Text, Layers, Block), nice (Code) |
| Text panel: add text | Three presets: Add Heading / Subheading / Paragraph; inserted after the selected block (or block nearest viewport centre). | yes | yes | `index.html:108-113`, `editor/element-actions.mjs:54-100` | must - adding text is basic |
| Text panel: colour swatches | "Document colours" (colours found in the doc + custom picker) and 28 default preset swatches; applies to selection range or whole block. | yes | yes | `ui/panels/colors.mjs`, `features/formatting.mjs:101-132` | must |
| Block panel: size | Shows handles hint and "reset to original size" (images). | yes | yes | `ui/panels/box.mjs`, `index.html:120+` | nice |
| Block panel: padding | Presets (none/narrow/medium/wide), slider 0-?, optional per-side. Reset. | yes | yes | `ui/panels/box.mjs` | nice |
| Block panel: margin | Presets (none/small/medium/large), optional separate top/bottom. | yes | yes | `ui/panels/box.mjs` | nice |
| Block panel: border | Style (none/solid/dashed/dotted), width (thin/medium/thick), colour swatches + custom. | yes | yes | `ui/panels/box.mjs` | nice |
| Block panel: background colour | Swatches + custom for the block. | yes | yes | `ui/panels/box.mjs`, `index.html:140` | must - text on a coloured card is common in posts |
| Block panel: corner radius | Presets (none/subtle/medium/large/full) + slider. | yes | yes | `ui/panels/box.mjs` | nice (images with rounded corners) |
| Block panel: shadow | Four presets (none/soft/medium/strong). | yes | yes | `ui/panels/box.mjs` | nice |
| Layers panel | Tree of the current page's blocks with kind + text/alt snippet; click to select; hover previews outline; nested rows collapse/expand in local mode (slot leaves). Drag a row to reorder (orange line) or nest into another (`layer-dragging`); Esc cancels. | yes | yes (deeper tree) | `ui/panels/layers.mjs`, `ui/panels/layer-drag.mjs`, `editor/layer-tree.mjs`, `editor/reorder.mjs` | must - the only z-order/selection fallback for overlapped blocks |
| Code panel | CodeMirror HTML editor of the current deck source, line numbers; "Save code" re-opens the canvas from edited HTML (validated, 60 MB cap, rolls back on failure); "Download html" gives a script-stripped static copy. Status text "static HTML - directly editable". Embedded images appear as long base64 lines. | yes | yes | `ui/panels/code.mjs`, `codemirror/*` | drop for end users (power-user escape hatch; costly to rebuild); keep a read-only view only if devs need it |
| Files panel (workspace browser) | File search/list, "open from computer". Hidden by CSS and not in rail. | no | no | `ui/panels/side-panel.mjs:37-83`, `css/popost.css` | drop |

### 1.4 Selecting, moving, resizing

| Feature | What it does | Product | Local | Source | Needed? |
|---|---|---|---|---|---|
| Click to select | Click a text block or image selects it (orange outline with 4 corner + 2 side handles); hover shows lighter outline; clicking empty canvas deselects. In local mode the click target is the inner `data-slot` span, not the h1 box. | yes | yes | `ui/frame-events.mjs:17-130`, `ui/overlay.mjs` | must |
| Floating pill | Above the selection: move handle, "select parent container", duplicate, delete, "more" (...). AI-note button hidden by CSS. | yes | yes | `index.html:300-319`, `ui/bindings.mjs:164-180` | must (move/dup/delete), nice (select parent) |
| Drag to move | Drag from the block (or the pill handle); writes CSS translate; snaps to other blocks' edges/centres and page edges with guide lines (`SNAP_PX`), hold Alt to disable snapping; size/offset tooltip while dragging; offset boxes drawn. | yes | yes | `ui/drag.mjs:19-60`, `ui/overlay.mjs:SNAP_PX,drawSnapGuides` | must |
| Resize handles | Corners and left/right sides. For text: changing width reflows, corner drag scales font size (observed font-size 76 -> 112.7). For images: width/height with aspect behaviour. | yes | yes | `ui/drag.mjs:130-209` | must |
| Arrow-key nudge | 1 px, Shift = 10 px, for single and multi selection. (Verified for images; text blocks need selection not in edit mode.) | yes | yes | `ui/keyboard.mjs:48-65` | must |
| Marquee selection | Drag on empty stage or empty frame to rubber-band select blocks; Shift adds. | yes | yes | `ui/frame-events.mjs:78,131`, `ui/bindings.mjs:63-70`, `editor/multi-selection.mjs` | must |
| Shift-click multi-select | Toggles blocks in a group; pill shows "Selected N" and a delete button; group drags/nudges together with one snapped bounding box; Esc clears; Delete removes all (single undo batch). The pill also has an "AI feedback for these blocks" button that is not hidden by CSS (appears as an arrow icon). | yes | yes | `ui/frame-events.mjs:39-50`, `editor/multi-selection.mjs:131-156`, `index.html:282-290` | must (multi), drop (AI feedback button) |
| Select parent | Walks selection up to the enclosing container. | yes | yes | `editor/element-actions.mjs:102`, `ui/bindings.mjs:214` | nice |
| Duplicate / Delete block | Pill buttons or Ctrl+D / Delete; toast "Deleted - Ctrl+Z to undo". | yes | yes | `editor/element-actions.mjs:17-52` | must |
| Z-order | Pill menu "Bring forward / Send backward" (Alt+Up/Down) reorders the block among its siblings (DOM order). In flow-layout product posts this changes vertical order, not just stacking. | yes | yes | `editor/reorder.mjs:85-92`, `index.html:315-316` | must |
| Locked / protected blocks | Edit policy blocks commands on non-original or special nodes (generated scaffolding, scripts, effects). | yes | yes | `policy/edit-policy.mjs`, `editor/guards.mjs`, `editor/live-document.mjs` | must - needed to keep AI-generated HTML intact |
| Diagram (SVG) blocks | SVG diagrams picked as one block; text inside edited via a small overlay (`#svg-text`). Not produced in posts. | yes (if present) | yes | `ui/keyboard.mjs:57`, `index.html:299` | drop |

### 1.5 Text editing and formatting

| Feature | What it does | Product | Local | Source | Needed? |
|---|---|---|---|---|---|
| Inline text editing | Double-click (or Enter on a selected block) enters contenteditable on that block; Esc leaves edit mode (second Esc deselects); IME composition aware; paste is forced to plain text; edits are committed to the model (undoable) after a short debounce. | yes | yes | `ui/frame-events.mjs:150-176`, `editor/edits.mjs`, `editor/selection.mjs`, `editor/caret.mjs` | must |
| Partial-range formatting | While editing, bold/italic/underline/strike/colour/size apply to the selected range (observed `<i>` wrapping first 2 chars); with no range, to the whole block. | yes | yes | `features/formatting.mjs:31-132` | must |
| Font family | Select with 41 faces in groups (EN Serif, EN Sans, Chinese sans/serif/handwriting/display/kai, EN Display, Mono, Handwriting) from the self-hosted "Skill palette". Choosing one embeds the licensed font CSS (base64) into the doc as `<style data-popost-font>` (observed 453 KB Latin and 6.1 MB CJK per role). Fonts the doc already uses but are not in the library appear as a disabled "(not in public library)" entry. | yes | yes (loads from server endpoint) | `services/font-library.mjs`, `ui/toolbar.mjs:25-33`, `public/fonts/popost/palette.json` | must - fonts are a headline feature; rebuild with font-subsetting rather than embedding 6 MB |
| Font size | Number input + minus/plus buttons (1 px steps), Enter applies. | yes | yes | `ui/bindings.mjs:127-131`, `features/formatting.mjs:94` | must |
| Bold / Italic / Underline / Strikethrough | Toggle buttons with active state; Ctrl+B/I/U native. | yes | yes | `ui/bindings.mjs:133-136`, `features/formatting.mjs:80` | must |
| Text colour | Button shows current colour bar; opens the Text panel swatches. | yes | yes | `ui/bindings.mjs:132`, `ui/panels/colors.mjs` | must |
| Uppercase toggle | "aA" button toggles text-transform. | yes | yes | `features/formatting.mjs:141` | nice |
| Alignment | One button cycles left -> center -> right -> justify (icon changes). | yes | yes | `features/formatting.mjs:133` | must (as separate L/C/R buttons is fine) |
| Letter spacing + line height | "Spacing" popover with two sliders (letter-spacing in thousandths of an em, line-height). | yes | yes | `index.html:237-242`, `ui/bindings.mjs:160-161` | must (line height), nice (tracking) |
| Opacity | Popover slider 0-100 for text and images. | yes | yes | `index.html:269-272`, `ui/bindings.mjs:162` | nice |
| Link (Ctrl+K) | Popover: URL, "open in new tab", remove/cancel/apply; applies to selected text or block. | yes | yes | `features/links.mjs`, `index.html:257-262` | drop - links are meaningless in exported PNG posts |
| Clear formatting | Eraser button / menu item strips inline styles (observed style attr removed entirely). | yes | yes | `editor/element-actions.mjs:125` | must |
| Copy / paste style | Menu items and Ctrl+Alt+C / Ctrl+Alt+V. | yes | yes | `editor/element-actions.mjs:107-124`, `ui/keyboard.mjs:37-38` | nice |
| Block button in toolbar | "Block" opens the Block panel for the selection. | yes | yes | `ui/bindings.mjs:201` | must (entry to box styling) |

### 1.6 Images

| Feature | What it does | Product | Local | Source | Needed? |
|---|---|---|---|---|---|
| Replace image popover | "Upload from local", "use an image already in the doc" (thumbnail grid), "paste image URL" + Apply; upload and URL are loaded, size-checked (`fmtSize`) and embedded as data. | yes | yes | `features/images.mjs:18-175`, `index.html:243-250` | must - swapping AI images is central |
| Drop file on image | Drag an image file onto a picture to replace it (also window-level drop veil). | yes | yes | `ui/frame-events.mjs:168-176`, `ui/bindings.mjs:275-290` | must |
| Crop and align | Enter crop mode (button or double-click): dark overlay, drag inside to reposition image within its frame, "Fill container" (cover) / "Show whole" (contain) / Done; Esc exits. | yes | yes | `features/images.mjs:179-240`, `ui/bindings.mjs:196-200` | must |
| Image alt text | More menu -> small popover with input. | yes | yes | `features/images.mjs:123-140` | drop (not exported) |
| Flip horizontal | More menu on images. | yes | yes | `features/images.mjs:241` | nice |
| Reset original image | More menu; restores original src/crop. | yes | yes | `features/images.mjs:250` | nice |
| Image opacity | Toolbar opacity popover. | yes | yes | `ui/toolbar.mjs:15-19` | nice |

### 1.7 Misc UI plumbing

| Feature | What it does | Product | Local | Source | Needed? |
|---|---|---|---|---|---|
| Toasts | Bottom-centre dark toasts (deleted, errors, overflow, exports). | yes | yes | `shared/toast.mjs` | must |
| Conflict / disk-changed modals | Modals when stored revision changed under the editor; "reformat" and "fx" confirm modals. Conflict plausible in both; disk/live-sync disabled in local and product. | partial | partial | `index.html:386-428`, `services/save.mjs`, `services/live-sync.mjs:29` | nice - keep a "stale revision" guard for multi-tab |
| Loading overlay / empty state | Spinner while opening; empty-state card with "Select Document" (not reachable in product). | yes | yes | `index.html:328,346` | nice |
| Sanitisation / safe preview | Scripts, iframes, `on*` handlers and `javascript:` URLs stripped; CSP meta injected; edit frame is a blob preview with a guard script. | yes | yes | `services/api.mjs:13-22`, `core/sanitize.mjs`, `runtime/freeze.mjs`, `runtime/provenance.mjs` | must - AI HTML must not execute |

## 2. Keyboard shortcuts (live in Popost)

From `hd/js/ui/keyboard.mjs` (editor-side and forwarded from the preview frame via the frame guard bridge, `keyboard.mjs:68-80`). Ignored while typing in inputs, while a side-panel button is focused, and during presentation.

| Keys | Action | Reachable in Popost? |
|---|---|---|
| Ctrl/Cmd+S | Save | yes (captured in window, `bindings.mjs:51`) |
| Ctrl/Cmd+Z / Ctrl+Shift+Z / Ctrl+Y | Undo / Redo | yes |
| Ctrl+Alt+C / Ctrl+Alt+V | Copy / paste style | yes |
| Ctrl + `=`/`+`, Ctrl + `-`, Ctrl+0, Ctrl+wheel | Zoom in / out / fit | yes |
| Ctrl+D | Duplicate selected block (or focused page thumb) | yes |
| Ctrl+K | Link popover | yes (feature to be dropped) |
| Delete / Backspace | Delete selected block or multi-selection | yes |
| Enter | Start editing selected text block (caret to end); SVG text opens overlay | yes |
| Esc | Close popovers -> leave text edit -> deselect; clears multi; exits crop | yes |
| Arrow keys (selected) | Nudge 1 px; Shift = 10 px | yes |
| Alt+Up / Alt+Down | Move block up/down among siblings | yes |
| Arrow keys / PageUp / PageDown (nothing selected) | Previous / next page | yes |
| Ctrl+B / I / U | Native contenteditable formatting while editing | yes |
| Alt (during drag) | Disable snapping | yes |
| Shift (click) | Add/remove from multi-selection | yes |
| Shift (marquee) | Add to selection | yes |
| Filmstrip focus: Delete, Ctrl+D, Alt+Arrows | Page delete / duplicate / move | yes |
| Ctrl+F, Ctrl+H, Ctrl+Shift+M | Find, replace, AI feedback note | no - listed in the shortcuts modal text only; `keyboard.mjs` imports `openFind`/`openNotePop` but does not bind them, and the modal and find bar are hidden |
| Ctrl+Enter (note popover), Enter (alt/link/URL inputs), Enter (font size) | Confirm in popovers | yes |

## 3. Hidden / unused html-deck features

Hidden by `hd/css/popost.css:3-5` (`display:none!important`) or never wired in Popost builds:

- Presentation mode (`hd/js/present/*`, `#present-host`): controller/session/render/print exist and `installPresentListeners()` is called, but there is no button or key that starts it in the UI (`togglePresent` is imported in `bindings.mjs:28` and not bound). Only PDF print layout (`present/print.mjs`) is reachable.
- Reveal.js format (`formats/reveal.mjs`, `registry.mjs`, `slide-actions.mjs` vertical stacks): used only if a document is Reveal HTML; never produced by Popost posts.
- FX / animation effects (`features/effects.mjs`, `features/auto-fx.mjs`, `fx/runtime.mjs`, `#tb-fx`, FX panel, timeline, "animate this slide"): hidden toolbar button and panel (`[data-view=effects]`, `#tb-fx`). Largest dead weight (about 1000 lines plus i18n strings).
- Speaker notes (`editor/speaker-notes.mjs`, `#sb-notes`, `#notes`): status bar button hidden.
- Find and replace (`features/find.mjs`, `#findbar`, `#sb-find`): hidden, shortcut unbound.
- AI feedback / review notes (`features/feedback/notes.mjs`, `ui/feedback-view.mjs`, pins, note popover, `[data-view=review]`, `.pill-ai`, `#pins`): hidden, except the multi-select pill's "AI feedback" button which still shows (`#multi-note`, `index.html:288`) and opens a note popover whose list is hidden.
- Workspace file browser and "open from computer" / drag .html into window (`side-panel.mjs`, `[data-view=files]`, `.pick-local`, `file-input`, `drop-veil`): hidden or unreachable; the global drop handler (`bindings.mjs:275-290`) still reacts to dropped files.
- Language switcher (`ui/language.mjs`, `#pop-lang`, `#btn-lang`): menu hidden; language fixed by param.
- Keyboard-shortcuts modal (`#modal-keys`, `#sb-help`): hidden.
- Page width select (`#sb-width`) and page-mode (non-deck) section tracking: hidden / unused.
- Version history (`services/history.mjs`, `#modal-history`): menu entry hidden in both modes.
- Trust workspace / scripts (`#sb-trust`, `#sb-ws-trust`, `/api/trust`): hidden; product API refuses with "scripts are disabled".
- Live sync with disk (`services/live-sync.mjs`): disabled when `popost=1` or local mode.
- Document name and mode badge (`#doc-name`, `#mode-badge`): hidden.
- Export "include online resources" checkbox (`#export-remote`): hidden.
- Explode/atomic view removed (`app.mjs:43` comment).

## 4. Quirks and bugs observed

1. The "Reset to initial layout" success toast reuses the open-document message ("opened <id>.html - 3 slides - 9 editable text blocks") rather than saying "reset"; it also leaves the doc dirty, so users must Save again.
2. PDF export does not download: it opens a blank popup (`about:blank`) and relies on the print dialog; blocked popups yield nothing, and tests see no file.
3. "Download all" in local mode fails with "No module named 'playwright'" when the host Python lacks Playwright (the product mode does not have this dependency).
4. The selection pill floats above the selected block and covers the block above/near it; in my first automation runs a click meant for a heading hit the pill's duplicate button and silently created a copy (page then had two images). Real users can hit this too when blocks are stacked tightly.
5. Selecting the heading while the image is selected leaves a stale-looking dashed selection frame lower on the page in a few screenshots (`panel-box-h1.png`, `dark.png`), caused by the same pill/duplicate side effect rather than a separate bug.
6. Embedding a font from the library writes huge base64 `<style data-popost-font>` blocks into the post HTML (6.1 MB for the CJK sans role, 453 KB for Lora/Latin), inflating saves, undo snapshots and the Code panel; the same blocks are included in exports.
7. Overflow check fires right after adding a heading preset (new text lands overlapping the next block in flow layout): toast "edited text exceeds its box", red thumb badge and "1 text overflow" counter.
8. Product-mode block types differ from local: clicking a heading in local mode selects the inner `data-slot` span (heading box click can miss), and the Layers panel shows nested rows; in product mode the h1 itself is selected.
9. Alt+Up/Down is labelled "Bring forward / Send backward" but moves the block in DOM order, which in product (flow) pages visually reorders blocks vertically.
10. The Font select pre-prepends a disabled "(document in use, not in public library)" option when the current font is not in the library (Helvetica Neue for default posts), and the first option indexes shift accordingly.
11. The multi-select pill shows an "AI feedback" up-arrow icon with no label even though the review panel is hidden.
12. The shortcuts modal (hidden) advertises Ctrl+F/H/Shift+M that are unbound; the visible UI has no shortcut help at all.
13. Page filmstrip has no "add page" and no "undo for last delete" button besides Ctrl+Z; the right-click menu is the only discoverable way to duplicate/delete/move pages (not discoverable on touch).
14. `/canvas/:id` works standalone and survives reload; saved edits persist across reload (verified) but unsaved edits only persist via draft recovery.
15. Console/page errors: none observed in product mode during the scripted run.

## 5. Counts

Main-table rows by verdict (first verdict used where a row says "must (x), drop (y)"): must 44, nice 22, drop 8 (74 rows). Section 3 lists a further 17 hidden or unreachable html-deck features, all drop.
