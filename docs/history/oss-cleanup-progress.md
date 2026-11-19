# Open-source cleanup — progress log

> **Path note (2026-11-01).** This is a historical record written before the repository was restructured. Paths in it refer to the old Popost-ai layout: `src/`, `public/`, `index.html` → `apps/web/…`; `editor/` → `packages/canvas-editor/`; `PROGRESS.md` → `docs/history/oss-cleanup-progress.md`; `docs/后端接口对接说明.md` → `docs/backend/integration-contracts.zh-CN.md`. Line numbers may have drifted.

Branch: `chore/oss-cleanup` (from `main` @ `4e4c9bd`). Working log for the cleanup that prepares Popost-ai for open source.
Remove this file before the public release.

## Goal

1. Remove internal-platform leaks from the web app (Miaoda/Doubao/OpenDesign scaffolding, internal storage paths, personal data).
2. Remove the proprietary `skills/popost/vendor/editorial-magazine-1.0.4/` and the 6 `templates/editorial-*` derived from it.
   Their scene ideas are recorded (in our own words) in [TODO.md](TODO.md).
3. Remove skill code that the product never calls (only tests did), plus 14 redirect-stub docs.
4. **Do not change replication / generation behaviour.** Every step is checked against the baseline below.

Out of scope for this pass (tracked in [TODO.md](TODO.md)): licence change, editor rewrite (html-deck), rewrite of
third-party-derived Skill text, image assets, dependency pruning, competitor-derived CSS comments.
Third-party attributions (Skill workflow, html-deck) stay in place until the derived code/text is actually rewritten.

## Baseline (before any change, 2026-10-30)

| Check | Result |
|---|---|
| Skill tests `skills/popost/tests/run_all_tests.py` | 193 total, 191 pass, 1 fail, 1 error — both environmental: `test_provider.test_dry_run_no_ledger_no_charge` needs the `clipcat` CLI on PATH; `test_strict_contract.test_real_dom_probe_and_review_bind` needs Playwright's bundled Chromium |
| Frontend `npm run typecheck` | exit 0 |
| Frontend `npx eslint src` | 0 errors, 8 warnings |
| Frontend build | see "Known issue" — use `npm run sync:fonts && npx vite build` |

Test environment used: Python venv with `skills/popost/requirements.txt`, `PLAYWRIGHT_CHROMIUM=/usr/bin/google-chrome`,
`POPOST_PYTHON=<venv>/bin/python`.

## Known issue (environment)

`npm run build` runs `prebuild` → `scripts/sync-skill-editor.mjs`, which **deletes and recopies** `skills/popost/assets/editor/`.
On 2026-10-30 the copy failed half-way on this virtiofs mount, and `skills/popost/assets/editor/codemirror/htmlmixed.js` became
unreadable from the Linux VM ("Permission denied" on stat), so git shows it as modified/deleted. It must be restored from the
macOS side: `git checkout -- skills/popost/assets/editor/codemirror/htmlmixed.js` (check whether security software is holding the file).
Until then, do not run `npm run build` / `npm run sync:skill-editor` in the VM.

## Tasks

| # | Task | Owner | Status |
|---|---|---|---|
| T1 | Web app: standard Vite build, remove Miaoda/Spark/OpenDesign files, rewrite `ui/image.tsx`, scrub personal/internal data, update README/AGENTS/docs | Sonnet sub-agent, reviewed by Claude | done — typecheck 0, eslint 0 errors/8 warnings, `vite build` ok, preview routes 200; reviewer fixed one README line |
| T2 | Skill: delete vendor + 6 editorial templates, orphaned modules/tests/fixtures, 14 stub docs; strip `--strict-gate` from `render_html.py`; fix doc references; update `SOURCE-MANIFEST.sha256` | Sonnet sub-agent, reviewed by Claude | done — reviewer restored the "legacy scripts not relicensed" caveat in `skills/popost/LICENSE` and fixed 4 editor hashes that were already stale on `main` |
| T3 | `TODO.md`: ideas of the 6 removed scene templates + spec for "generate templates from notes and image-text lists" | Claude | done |
| T4 | Verification against baseline (skill tests, editor e2e, frontend checks, browser smoke of preview) | Claude (+ Sonnet for browser smoke) | done — no behavioural difference (see log) |

## Phase 2 — canvas editor rewrite (replace html-deck)

Strategy: clean-room, **drop-in replacement** — same embedding URL/params, `postMessage` messages, storage keys/formats and
page markup, so the web app, the skill and existing projects keep working; entirely new code inside.
Clean-room rule: implementers work from `docs/editor-rewrite/` (contracts, features, spec) and must not read or copy
html-deck's own source files. Product-team files inside the vendored folder (`browser-storage.mjs`, `local-api.mjs`,
`font-library.mjs`, `canvas-download.mjs`, `ui/panels/code.mjs`) are ours and may be ported.

| # | Task | Owner | Status |
|---|---|---|---|
| E1a | Inventory of external contracts → `docs/editor-rewrite/current-contracts.md` | Sonnet, reviewed by Claude | done |
| E1b | Feature inventory (product + local skill mode) → `docs/editor-rewrite/current-features.md` | Sonnet, reviewed by Claude | done (74 rows: 44 must / 22 nice / 8 drop) |
| E2 | Spec → `docs/editor-rewrite/SPEC.md` (v1 incl. §8 UI scope; contracts extended with bridge formatting/styles messages, FrameController, EditorController) + shared types `editor/src/contracts.ts` + toolchain (`editor/`, `npm run test:editor` / `typecheck:editor` / `build:editor`; deps parse5, vitest, happy-dom) | Claude | done (draft) |
| W1-A | `editor/src/core/*` (source index, stable ids, edits, style, history, pages, preview, validate) | Sonnet (higher effort), reviewed by Claude | done — 312 core tests (387 total); perf on a 6.6 MB doc: parse 0.62 s, each op ~0.38 s → fast path task W1.5 |
| W1-B | `editor/src/storage/*`, `fonts/*`, `host/*` (ports of product-team modules + differential check vs old code) | Sonnet, reviewed by Claude | done — 74 tests; differential check vs old `local-api.mjs` in Chrome: 51/51 identical (`$SCRATCH/w1b/diff_check.py`); reviewer changed `DocStore.downloadAll` to return `{rev}` (removed `onRev` side channel) |
| W1.5 | Core: fast path for attribute-local ops (`setStyle`/`setAttr` + undo/redo) without full re-parse, equivalence tests; `selectableBlocks` + `data-pp-sel` in previews | Sonnet (higher effort), reviewed by Claude (light) | done — setStyle on 6.6 MB: 363 ms → 0.28 ms; undo/redo < 0.2 ms; 47 equivalence tests; setInnerHTML fast path skipped (text commits still ~0.4 s on huge docs) |
| W2-C | `frame/*`: FrameController with direct same-origin DOM access (SPEC §6 v1.1, no bridge script) | Sonnet, reviewed by Claude (light, low quota) | done — 70 tests; Chrome check 69/72 (see log) |
| W2-D1 | `app/*`: EditorController (state, ops, history, selection, save/conflict, fonts, notices) | Sonnet, reviewed by Claude | done — `74458f0`, 55 tests (see review notes in log) |
| W2-E | `app/boot.ts`, `main.tsx`, `index.html` (wire store + frame + controller + UI) | Claude | done — contract `beginTextEdit(id, caret?: 'end'\|'all'\|{x,y})` (`beginTextEditAt` removed); placeholder `ui/App.tsx`; Chrome boot check ok (see log) |
| W2-D2a | `ui/` shell: App, topbar, filmstrip, stage + overlay interactions (select, drag, resize, snap, marquee, keys), modals, toasts, i18n core, base styles | Sonnet, reviewed by Claude | done — 618 tests; Chrome 76/76 (re-run by reviewer) |
| W2-D2b | `ui/panels/*`, format toolbar, image popover/crop, layers, code panel | Sonnet, reviewed by Claude | done — 643 tests; Chrome 169/169 + D2a 76/76 (re-run by reviewer) |
| W3-E | build/publish (`scripts/publish-editor.mjs`), web app + skill switched to `canvas/`, tests updated | Sonnet, reviewed by Claude | done — skill 114/115 (= baseline), e2e ok, web smoke ok (root + `BASE_PATH`), manifest ok |
| W3-F | parity script (every "must" row, both modes), removal of html-deck, docs/licence notices, final `rg` clean | Sonnet, reviewed by Claude | done — parity browser 44/44, local 42/42 (+2 n/a), see `docs/editor-rewrite/PARITY.md`; old editor removed; real `npm run build` works |

## Log

- 2026-10-30 — branch created; baseline recorded; `htmlmixed.js` issue found (see above).
- 2026-10-30 — T1 done and reviewed. Same virtiofs bug hit `npm run sync:fonts` (Node `fs.cpSync` leaves 0-byte write-only files);
  `public/fonts/popost/` (gitignored, generated) was rebuilt with an equivalent Python copy. On macOS the npm scripts work as before.
- 2026-10-30 — T4a started: browser smoke of `main` vs branch builds (Sonnet sub-agent).
- 2026-10-30 — `htmlmixed.js` restored by the user from macOS (`git checkout -- …`); file identical to `public/vendor/html-deck` again.
- 2026-10-30 — T2 done and reviewed. Verification on the real working tree:
  - Skill tests: 115 total, 114 pass, 1 fail = the same environmental `test_provider.test_dry_run_no_ledger_no_charge` (no `clipcat`
    CLI) as in the baseline. The 78 removed tests belonged only to deleted modules. Create (concept → design → assets) and
    strict-replication paths, render, export, package/reopen and providers are all covered and pass.
  - `tests/production_editor_e2e.py`: ok (1/1).
  - `sha256sum -c SOURCE-MANIFEST.sha256`: all entries match (4 editor hashes were already stale on `main`; fixed).
- 2026-10-30 — milestone commit on `chore/oss-cleanup` (T1–T3 + skill verification) = `5581fe5`.
- 2026-10-30 — T4a done (`$SCRATCH/smoke.py`, Playwright, fresh context): `main` vs branch identical on home, Skill community
  (5 cards, favourite), generation in create and replicate mode (3 cards each), canvas open + reload, projects/inspirations/
  billing/pricing/settings. Only differences: display name `sued` → `Creator` (intended) and two favicon 404s on `main`
  caused by the old serve script (relative `./favicon.svg`; latent on both, see TODO). 0 page errors on both.
- 2026-10-30 — Phase 2 (editor rewrite) started: E1a/E1b inventories running.
- 2026-10-30 — E1a/E1b done; SPEC v1 final (positioning: `translate` for flow blocks, `left/top` for absolute layers; UI scope §8);
  checkpoint commit `c7ceacc`; W1-A and W1-B running. Note: E1b left a `vite preview` on :4421 and a skill server running (scratch project).
- 2026-10-30 — Design change (SPEC v1.1): the edit frame is same-origin and script-free (CSP `script-src 'none'`); the editor
  reads its DOM directly, no bridge script/postMessage protocol. `buildPreview` no longer takes a nonce or bridge script
  (done by Claude; tests updated). Contracts: `FrameController.measure/styles` synchronous, `Notice`/`onNotice` for toasts.
  Text editing: Esc commits and leaves edit mode (current behaviour). W1.5, W2-C, W2-D1 launched in parallel; the UI (D2a/D2b)
  starts after review so it can be built and checked in Chrome against the real controller.
- 2026-10-30 — W2-D1 done and reviewed (`74458f0`). Review notes / follow-ups for whoever continues:
  - `EditorHandle.beginTextEditAt(id,x,y)` exists outside the contract (caret at pointer). Prefer widening the contract to
    `beginTextEdit(id, caret?: 'end'|'all'|{x,y})` and updating the controller, before the UI is written.
  - A whole-block `format` while editing (no range selected) commits the text and leaves edit mode; consider re-entering edit.
  - `body[data-doc-seq]` = `sourceVersion`; the skill tests only wait for `data-doc-state`, so this is fine.
  - `DownloadError` → notice `downloadFailed` with the message as detail (reason code not kept).
  - Documents without `.slide` → `docState:'error'`, `error:'no-pages'` (UI must translate).
- 2026-10-30 — W2-C done (light review because of the quota). Dev harness `editor/dev/frame-harness.html` (`npx vite --config
  editor/vite.config.ts --port 5191`), Chrome check `docs/editor-rewrite/tools/frame_check.py` (Playwright, Chrome at
  `/usr/bin/google-chrome`; `frame_check.py big` = frame larger than page). Follow-ups: (1) "hover id" check failed — probably
  test timing (hover is rAF-throttled in the frame window), verify first; (2) key-forward expectation in the script omits the
  bare `Control` keydown (script bug); (3) one 404 in console (likely harness favicon); (4) `big` run not done; (5) blur commits
  text edits, so UI controls used during editing must `preventDefault` on mousedown; (6) `clear` only unwraps spans fully in
  range; (7) if the current page root is removed live, the shell must send `currentPage`.
- 2026-10-30 — W1.5 done. Full editor suite: 27 files, 574 tests, typecheck clean. Wave 2a (core fast path, frame, controller)
  complete and pushed. NEXT (for whoever continues): W2-E boot wiring (see task table; `app/boot.ts`, `src/main.tsx`,
  `editor/index.html`; resolve `beginTextEditAt` → widen `beginTextEdit` contract first), then UI agents D2a/D2b against the
  real controller (brief them with SPEC §8, contracts, the W2-D1/W2-C follow-ups above; UI must preventDefault on mousedown for
  controls used during text editing), then W3.
- 2026-10-30 — W2-E done. `bootEditor()` (`editor/src/app/boot.ts`): params (incl. `lang` fallback `popost-canvas:lang` →
  legacy `gs9_editor_lang`), local vs browser store, frame controller (`baseHref '/pages/'` in local mode), controller, theme
  (param + M1), `body[data-doc-*]` hooks, document title with `• ` when unsaved, `beforeunload` prompt; `version.ts` = 4.0.0;
  `ui/use-snapshot.ts` (useSyncExternalStore). `ui/App.tsx` is a placeholder (only `.workspace` + `#frame`) for D2a to replace.
  Editor suite 28 files / 578 tests, typecheck clean, `build:editor` ok (literal `<head>`, relative `./assets/…`).
  Chrome check (browser mode, seeded legacy localStorage, `$SCRATCH/pw/boot_check.mjs`, Node playwright-core + system Chrome
  — the VM has no python3-venv): ready, 2 pages, `.ed-cur` on page 1, no scripts in frame, CSP `script-src 'none'`, dark
  theme and `en` applied. One 404 = dev-server favicon. Note: root `eslint` config does not cover `editor/` (as before).
  NEXT: D2a (shell + interactions + i18n core + styles), then D2b (panels/toolbar) on top of D2a's i18n/styles.
- 2026-10-30 — W2-D2a done and reviewed. Contract: `applyBatch(ops, label, opts?: {coalesceKey})` (group nudges = one
  undo step). i18n: `en.ts` defines keys, `zh.ts` is typed against it (D2b adds keys there). `ui/dismiss.ts` = Esc stack for
  popovers (`useDismissable`). Chrome check `$SCRATCH/pw/d2a_check.mjs`, screenshots `$SCRATCH/d2a/`. Decisions: side handles
  w/e; images keep aspect; block with direct text = text (corner scales font-size); bring forward = later in DOM (Alt+↓);
  thumbnails = `iframe sandbox="allow-same-origin" srcdoc` from `buildPreview`. Known gaps for later: Ctrl+Alt+C/V unwired
  (D2b); no block context menu; undo of `move` re-ids the block so selection drops (core ids); overflow badge only on the
  current page's thumb; one full-document srcdoc per thumb is heavy for docs with MBs of embedded fonts (W3: share or strip
  font styles in thumbs); fit zoom not capped at 100 %; fixtures need inline size or `data-popost-width` on `.slide`.
- 2026-10-30 — W2-D2b done and reviewed. Contract: `EditorController.highlight(ids)` (layers hover). Chrome checks need the
  font library: `$SCRATCH/vite.d2b.config.mjs` (dev server :5193, serves `skills/popost/assets/fonts` at `/fonts/popost/`;
  production config unchanged); scripts `$SCRATCH/pw/d2b_check.mjs`, `d2a_check_5193.mjs`; screenshots `$SCRATCH/d2b/`.
  Decisions to confirm in W3 parity: `#code-save` = `replaceSource` + `save()` (undoable); long base64 payloads shown as
  `[[popost-data-N:size]]` in the code panel and restored on save; format toolbar row always visible (scrolls horizontally on
  narrow screens); typed font size / `#tb-font` while editing a range take focus → commit and apply to the whole block (± keep
  the range); double-click on an image enters crop mode; 12 MB image cap. Bundle 742 kB (CodeMirror) — consider lazy-loading
  the code panel. Gaps: overlay hover outline not driven by layers hover; undo of a layer move re-ids (core).
  NEXT: W3 (SPEC §9–§11): publish script, web-app + skill integration, existing skill/browser tests against the new editor,
  parity script, removal of html-deck.
- 2026-10-30 — VM test env for the skill: `sudo apt install python3.14-venv python3-pip`, venv `$SCRATCH/venv` with
  `skills/popost/requirements.txt`; run with `PLAYWRIGHT_CHROMIUM=/usr/bin/google-chrome POPOST_PYTHON=$SCRATCH/venv/bin/python`.
  Pre-W3 baseline on `a9c56b0` (old editor still wired): 115 total, 114 pass, 1 fail = the known environmental
  `test_provider.test_dry_run_no_ledger_no_charge` (no `clipcat` CLI).
- 2026-10-30 — W3-E done and reviewed (reviewer re-ran skill suite 115/114/1 = baseline, `production_editor_e2e.py` ok,
  `npm run lint` 0 errors / 8 warnings, 644 editor tests, rebuild+publish reproduces the committed `assets/canvas/`
  byte-for-byte per SOURCE-MANIFEST). `editor_handoff.VERSION` = 4.0.0. Test edits (paths/hooks only): bundle test now checks
  every `assets/canvas` file (stricter); reopen check path; `#modal-reformat.show` count 0 (prompt removed by SPEC);
  `test_product_fonts.py` reads IndexedDB directly. Editor fixes: `#panel` always rendered (`.open`, `data-view`); `#tb-font`
  disabled until the chosen family's faces load in the frame. Web smoke `$SCRATCH/pw/web_smoke.mjs`.
  Open for W3-F: `sync:skill-editor` still in `prebuild`; docs (skill README, editor-contract.md, THIRD_PARTY_NOTICES, brand
  README) still describe html-deck; `CanvasPanel` srcdoc path replaces `__POPOST_PARAMS_INIT__` in an externally produced
  `__POPOST_EDITOR_HTML__` (producer outside the repo, see current-contracts §1.4) — the new `index.html` has no such token;
  `public/fonts/popost` 1511 vs skill fonts 1512 files after `sync:fonts` (not investigated).
- 2026-10-30 — W3-F done. `docs/editor-rewrite/tools/parity_check.mjs` (+ `parity_local_server.py`) walks the 44 "must" rows (plus 3 nice rows)
  in browser mode (built app via `vite preview`, CanvasPanel iframe) and local mode (skill server, scratch project): browser 44/44,
  local 42/42 + 2 n/a (web route, dark theme), results in `docs/editor-rewrite/PARITY.md`. No editor bug found; script fixes only
  (app language is zh unless the seeded `state.preferences.locale` says otherwise; local page roots carry a leading `<style>`;
  the skill server's preview CSP is `default-src 'none'` + a nonce-only `script-src`). Removed `public/vendor/html-deck/`,
  `skills/popost/assets/editor/`, `scripts/sync-skill-editor.mjs`, the `sync:skill-editor` script and the html-deck notice;
  `THIRD_PARTY_NOTICES` and docs now point to `assets/canvas/THIRD_PARTY_LICENSES.txt`; SOURCE-MANIFEST regenerated (1611 entries,
  `sha256sum -c` clean). CanvasPanel now posts M1 with `targetOrigin = location.origin` and re-sends it on iframe load (SPEC §2
  decision 1; was `'*'`). The virtiofs copy bug above no longer applies (no delete-and-copy step left): `npm run build` ran fine in
  the VM. Checks: typecheck 0, lint 0 errors / 8 warnings, typecheck:editor 0, test:editor 644, skill suite 115 / 114 / 1 (baseline),
  `production_editor_e2e.py` ok, web smoke ok on `npm run preview`.
- 2026-10-30 — W3-F reviewed. Reviewer re-ran: parity browser 44/44 must + 3 nice; local first run 41/42 — F05 "Download all"
  timed out because `parity_check.mjs` did not pass the Chrome path to the skill server it starts (export renders via
  `PLAYWRIGHT_CHROMIUM`); fixed (server env gets `PLAYWRIGHT_CHROMIUM=<chromePath>` unless set) → F05 passes. Skill suite
  115/114/1 (baseline), e2e ok, real `npm run build` ok (committed `assets/canvas` unchanged), web smoke on `vite preview` ok,
  lint 0 errors / 8 warnings, 644 editor tests, manifest clean, `rg` only history docs + the deliberate `gs9_editor_lang`
  fallback. README licence line corrected (`entities` is BSD-2-Clause). Editor rewrite (Phase 2) complete.
