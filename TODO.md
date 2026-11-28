# TODO

Scope (2026-11-01): this repository holds the replicate/create skill and the canvas editor only. Everything else is
part of the popost.ai website, which must offer whatever the skill offers. Features the website's interaction draft
does not have are not built here either.

## 1. Rebuild the six removed scene templates as original work

**Deferred (2026-11-01).** The website's interaction draft (Workspace V38) has no scene template library: there a
Skill is the scene, and creating your own Skill is "not open this round". Keep these notes for when that opens; the
website has to ship the same capability at the same time.

On 2026-10-30 (branch `chore/oss-cleanup`) six scene templates (`editorial-news`, `-biography`, `-outfits`, `-travel`,
`-story-sequence`, `-explainer`) were removed because the package they were derived from may not be redistributed.
The scene ideas below are worth keeping. Rebuild them **from scratch**: work only from these notes, write new HTML/CSS
and docs, and use clearly fictional sample content. Each rebuilt scene should use the template format from section 2,
default to a 3:4 carousel page (1080×1440), and support Chinese and English copy.

**Shared ideas for the whole set**

- One theme per post, expressed as a few colour roles (background, text, accent, text-on-accent) that every page reuses.
  Check contrast automatically when a theme is picked.
- Body text sized for phone reading; text is never truncated or overlapped; reading order is explicit.
- Every image slot declares what it holds: a real photo, a diagram, or decoration. Missing photos are reported as gaps,
  never faked with shapes.
- Cut-out (transparent) subjects are checked for clean edges before use.
- Fixed canvas per page; every page exports to its own PNG.

**Scenes**

| Scene | Good for | Pages | Signature layout idea | Images |
|---|---|---|---|---|
| News digest | News roundup, weekly digest | 1 | Masthead strip, one lead story with a large photo and a short multi-column intro, then a grid of four smaller stories | 1 large + 4 small photos |
| Profile / biography | A person's or brand's story | Cover + 3 detail pages (life timeline/album, works, relationships and influence) | Cover: a large cut-out portrait in the middle with text flowing around its silhouette (the wrap shape is computed from the image's transparency) | Portrait cut-out + many supporting photos |
| Outfits / lookbook | Fashion, styling | Overview + one breakdown page per look | Overview shows 2–4 complete looks side by side. Breakdown: full-body photo in the centre, single items boxed on both sides, a colour swatch row sampled from the photo | Full-body photos + item cut-outs |
| Travel itinerary | Trip guides | Cover + highlights page + one page per day | Cover title filled with a photo or pattern (text used as a mask). Highlights in round crops plus a scenic strip. Day pages show a schematic route: stops joined by legs labelled with the transport used; explicitly not a navigation map | One photo per stop; the route is a diagram |
| Story sequence | Events or processes told in stages | Overview + one page per stage | Each stage has a stable key, so overview thumbnails and stage pages always match; pages are added or removed to fit the real material | One image per stage |
| Explainer / essay | Explaining a concept or arguing a view | Cover + two-column page + three-panel expansion + closing summary | Magazine-collage feel, vertical cover title, serif body text; colours in scientific images keep their meaning | A few photos or figures |

Done when each scene has original HTML/CSS, fictional sample content, rendered sample PNGs, passes the overflow and
contrast checks, and carries the project licence.

## 2. Feature: generate scene templates from notes and example posts

**Deferred (2026-11-01)** for the same reason as §1.

**User story.** I give popost (a) notes describing a scene and its style, and (b) a list of example posts (page images plus
their title, body and tags). popost produces a reusable scene template that later creation and replication runs can select.

**Input**

- Notes, free text in any language: intended use, audience, style words, what must stay, what to avoid.
- Examples: 1–10 posts (3+ recommended). Each post is its ordered page images plus title/body/tags and, optionally, its
  source URL and platform. Later, accept the output of the five-platform link parser (`PostBundle`) directly.

**Pipeline**

1. Read each example with the existing replication analysis (page roles, grid, type scale, palette, how images are used).
2. Compare the examples and split what is fixed (page sequence, layout per page role, type hierarchy, colour roles, image-slot
   kinds) from what varies (copy, photos, accent colour).
3. Write the template package: a scene description that `popost template locate` can load (a `SKILL.md`-style entry
   file), one HTML layout per page role with named text and image slots, design tokens (fonts only from
   `skills/popost/assets/fonts/palette.json`, colour roles), image rules, and a fictional filled-in sample.
4. Check: render the sample, run the overflow/contrast checks, compare side by side with the examples, record differences.
5. Register: save to the user's template library, versioned, selectable as a scene skill.

**Constraints**

- Examples are references only. Their pixels and copy are never shipped; layouts are rebuilt as original code.
  Logos and trademarks seen in examples are not reproduced.
- Existing create / replicate / edit behaviour must not change; using a template is opt-in.

**Reuse:** `skills/popost/src/workflow/template-plugins.ts`, `skills/popost/references/scene-templates.md` and
`assets/template-profile.example.json` (template profile), `references/reproduce.md` (reading references),
`templates/generic/*` (five original content structures — after the cleanup nothing loads them; wire them into this format).

**Open questions:** local skill folder vs cloud library; sharing through the web app's Skill community page; credit cost per
generated template; minimum number of examples.

## 3. Remaining open-source preparation

- [x] Licence and notices (2026-11-01): the root `LICENSE` names CLIPCAT AI LTD as the producer and copyright holder
      (Popost / popost.ai is the product and brand) and clause 1c now covers the web app, canvas editor and the skill's
      command-line tools and Studio. `skills/popost/LICENSE` points to the root licence instead of contradicting it (the
      "legacy scripts not relicensed" wording is gone, also from `THIRD_PARTY_NOTICES`). Added `NOTICE` (third-party
      components), `CONTRIBUTING.md` (contributor terms based on LICENSE section 2, `git commit -s` sign-off) and
      `apps/web/public/fonts/RobotoFlex-OFL.txt`; `package.json` declares the licence and author.
- [ ] Have legal review `LICENSE`, `NOTICE` and the contributor terms in `CONTRIBUTING.md` before the public release
      (decide whether a signed CLA should replace the sign-off).
- [x] Rewrite the canvas editor so no third-party editor code remains — done (`packages/canvas-editor/`, version 4.0.0; the vendored editor was removed). Parity results:
      `docs/editor-rewrite/PARITY.md`. Exported project ZIPs still bundle the editor (`runtime/assets/canvas/`) and nine skill scripts.
- [x] Skill design-workflow attribution (decision 2026-11-18): after the rewrite, `skills/popost/` was compared with the
      upstream commit the workflow was first adapted from and shares no text with it (only a list of standard Chrome
      install paths), so the third-party attribution and the upstream licence copy were removed.
- [x] Images (2026-11-01): deleted the 27 files in `apps/web/public/images/` that no code referenced (the 11 real-person
      `role-*.jpg`, `sneakers*.jpg`, `inspiration-{bag,blue,cafe,cream,fashion,tennis}.jpg`, `inspiration-step-*.png`,
      `inspiration-v8-step-*.webp`, `onboarding-v15-step-3-*.webp`; leftovers from earlier design versions that the
      production bundle never loaded).
- [x] ~~Confirm the generator and its terms for the five `inspiration-ai-*.jpg`~~ — removed with `apps/web` (2026-11-01).
- [x] Model names (2026-11-01, with the §5 provider rewrite): no upstream model is named in this repository. There is no
      default model in code: the platform marks its default in the model list at runtime and users can pin one in their
      own config; the example config uses a placeholder and mock fixtures/tests use `mock-image-model` /
      `mock-image-model-alt`.
- [x] Addresses (2026-11-01): the web app and docs now use popost.ai instead of clipcat.ai (install commands, `popost config
      … --base-url https://popost.ai`, account center, doc link, pricing note); the unused `RAW_CLIPCAT_SOURCE` price
      snapshot in `plan-catalog-v33.ts` was removed. The endpoints themselves are tracked in §5.
- [x] CSS comments (2026-11-01): removed every mention of other products from `apps/web/src/*.css`.
- [x] Web app clean-up items (design tokens, unused dependencies such as GSAP and shadcn files, i18n, strict TypeScript,
      `workspace-vNN.css`, favicon path) — obsolete: `apps/web` was removed on 2026-11-01. Dependencies are now only what
      the editor needs.
- [x] Publish from a fresh repository with a squashed history (2026-11-19: `PopostAI/popost`, public, one initial commit).
- [ ] Skill distribution at launch: `popost@4.6.0` is on npm (2026-11-19). Still to verify on each agent (Claude Code,
      Codex, Cursor): `npx popost@latest install` and `npx skills add PopostAI/popost -g`. Scripts and manual:
      `npm run release:check`, `npm run release:smoke`, [docs/release-skill.md](docs/release-skill.md).

## 4. Canvas editor follow-ups (after the rewrite, editor 4.0.0)

- [x] The destructive delete-then-copy editor sync is gone; `scripts/publish-editor.mjs` publishes atomically (temp folder + rename).
- [ ] Skill server `/api/export?page=all`: when no Chromium is found (no `PLAYWRIGHT_CHROMIUM`, no bundled browser) the
      request does not fail fast; the editor's "Download all" waits until the client gives up. Return an error instead.
- [x] Dry runs need no external CLI, network or key (2026-11-01): `quote --dry-run` / `generate --dry-run` only print the
      planned request; `test_provider.test_dry_run_no_ledger_no_charge` passes offline.
- [x] Stored document changed elsewhere (2026-11-01): host message M8 `store-changed` makes the editor reload when nothing
      is unsaved and show the conflict dialog otherwise (`EMBEDDING.md`).
- [x] `__POPOST_EDITOR_HTML__` srcDoc branch in `CanvasPanel` — obsolete, removed with `apps/web` (2026-11-01).
- [x] Host-backed storage (2026-11-01): `store=host` makes the embedding page own load/save/initial over postMessage
      (M6/M7), so a website can host the editor without sharing IndexedDB. Contract: `packages/canvas-editor/EMBEDDING.md`.
- [ ] Lazy-load the code panel: the editor bundle is about 742 kB because CodeMirror 5 is bundled eagerly; load it on first
      open of the Code panel (dynamic `import()`).
- [ ] Filmstrip thumbnails: each page thumb is an `iframe srcdoc` with the full document, which is heavy when the document embeds
      MB-sized fonts or images. Share or strip font/image payloads in thumbnails (render only the page, reuse one font cache).
- [ ] Undo of a `move` re-ids the moved block, so the selection is dropped after undoing a layer move (core id mapping).
- [ ] The text-overflow badge appears only on the current page's thumbnail (the other pages are not measured); measure all pages.
- [ ] Not rebuilt in v1 on purpose (SPEC section 0/8): PDF export, crash-draft recovery, version-history UI, fullscreen, link tool,
      image alt text/flip/reset-original, AI-feedback and notes UI, presentation mode.

## 5. Repository and backend integration (after the move into `popost`, 2026-11-01)

- [ ] Re-enable CI on GitHub once ready (`gh workflow enable CI -R PopostAI/popost`); the workflow was rewritten for this layout.
- [x] Install from the official npm registry: `.npmrc` removed and the `resolved` URLs in `package-lock.json` point to registry.npmjs.org
      (same versions and integrity hashes; clean `npm ci`, `npm run check` and `npm run build` re-verified on 2026-11-01).
- [x] Narrowed to the skill and the canvas editor (2026-11-01): removed `apps/web`, `docs/backend/` and `scripts/sync-font-library.mjs`;
      root scripts, ESLint (now on the editor), CI and docs follow. The web app lives on in the popost.ai website.
- [x] Platform provider (2026-11-01): `skills/popost/scripts/providers/popost.py` calls the popost.ai OpenAPI directly
      (`/models`, `/images/quote`, `/images/generations`, `/uploads`, `/inspirations`) with the user's `POPOST_API_KEY`;
      requests carry `x-popost-client: skill` and `x-popost-client-version` (the `SKILL.md` version), which the server
      checks against its minimum Skill version. New `inspiration import` saves a PostBundle to the user's inspiration library.
      Tests use a local stub (`skills/popost/tests/popost_stub.py`).
- [ ] Bump the Skill version (`SKILL.md`, now 3.3.1) on the next release so the server's minimum Skill version can tell
      provider-based builds apart.
- [ ] `inspiration import`: use `POST /links/parse` once the server implements it (it answers `NOT_IMPLEMENTED` today).
- [x] Flaky `test_shared_canvas.test_product_canvas_edit_export_reset_and_portable_reopen` (2026-11-01): right after a
      reload the test double-clicked before the frame wired its pointer handlers and then typed into a block that was not
      editable. The test now waits for text editing to start and retries the double-click; the Skill tests run in the
      blocking CI job.
- [x] popost.ai endpoints advertised by the web app's API Keys page, and wiring the web app to popost-server — moved to
      popost-server together with the web app (2026-11-01).
- [ ] Skill platform/X coverage: add X (and other global platforms) to `skills/popost/references/platform-adaptation.md`.
