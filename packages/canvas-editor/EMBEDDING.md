# Embedding the canvas editor

The editor is a static page. `npm run build` writes it to `skills/popost/assets/canvas/` (`index.html`, `assets/`,
`build-info.json`, `THIRD_PARTY_LICENSES.txt`); the Skill serves that copy locally. Any web app can host the same files
and embed the editor in an iframe. This page is the contract for such a host.

## Files to serve

| Path (relative to the host's base) | Content |
|---|---|
| `canvas/` | the editor build, unchanged (`base: './'`, so any sub-path works) |
| `fonts/popost/` | the font library: `palette.json`, `NOTICE.txt`, and for every role in `palette.json` its directory `<role.id>/` and its `cssPath`, all copied from `skills/popost/assets/fonts/`. Only OFL-1.1 roles may be served. |

The editor resolves the font library as `../fonts/popost/` relative to its own page. In host mode the font CSS it
writes into the document links the font files by root-relative path (for example
`url("/fonts/popost/cjk-sans/….woff2")`) instead of embedding them, so keep serving the library at that path for as
long as stored documents use it. The iframe must be same-origin
with the host: the editor only accepts messages from `window.parent` with `event.origin === location.origin`, and posts
to `location.origin`.

## URL parameters

`canvas/index.html?file=<projectId>.html&name=<title>&lang=zh|en&theme=dark|light&store=host`

- `file`: the project id plus `.html`; it is echoed as `id` in every message.
- `name`: title fallback when the host does not send one.
- `tools=1`: enables the optional host asset and export integrations below. Hosts that do not implement them can omit it.
- `lang`, `theme`: editor UI language and colour scheme. Without `lang` the editor uses the language last passed in the URL on this origin, else the browser's language (Chinese for any `zh` tag, otherwise English).
- `store`: `host` makes the embedding page the storage (below). Without it the editor uses the browser's IndexedDB
  (`popost-workspace-v24`), which only suits a host that shares that database.
- `imageOrigins`: host mode only (`store=host`; ignored otherwise and in local mode). Comma separated extra image
  origins, for a host whose picture URLs redirect to another origin such as object storage. Each entry must be a bare
  `https:` origin: scheme, host and optional port, with no path, query, credentials, wildcard or IP literal
  (`https://img.example.com`, `https://cdn.example.com:8443`). Invalid entries are ignored and at most 4 are used.
  Percent-encode the list in the URL. The origins are added to `img-src` of the preview CSP; nothing else changes.

## Messages

Every message is an object with `source` (`popost-editor` from the editor, `popost-workspace` from the host), `type`
and `id` (the project id).

| # | Direction | `type` | Fields | Notes |
|---|---|---|---|---|
| M1 | host → editor | `popost-theme` | `mode`: `dark` \| `light` | live theme switch |
| M2 | editor → host | `saved` | | browser storage only, after a save |
| M4 | editor → host | `download-images` | `requestId`, `html` | "Download all": the host renders every top-level `.slide` to PNG and downloads them |
| M5 | host → editor | `download-images-result` | `requestId`, `error?` | reply to M4; the editor gives up after 120 s |
| M6 | editor → host | `store` | `requestId`, `op`, plus `content`, `rev`, `force` for `save` | `store=host` only |
| M7 | host → editor | `store-result` | `requestId`, `ok: true, result` or `ok: false, error: { code, message }` | reply to M6; the editor gives up after 60 s |
| M8 | host → editor | `store-changed` | | `store=host` only: the stored document changed outside this editor (another tab, an agent). The editor reloads when nothing is unsaved; otherwise it shows the conflict dialog (reload or overwrite). Do not send it for the editor's own saves. |

M6 operations and the `result` the host returns in M7:

| `op` | Request fields | `result` |
|---|---|---|
| `load` | | `{ content, rev, name? }`: the whole document and an opaque revision string |
| `save` | `content`, `rev` (the revision the edit started from), `force` | `{ rev }`: the new revision. If the stored revision is not `rev` and `force` is false, reply `ok: false` with `error.code = 'conflict'`; the editor then offers to reload or overwrite (overwrite resends with `force: true`). |
| `initial` | | `{ content, available, reliable, source, createdAt }`: the first layout of the project, used by "Restore initial layout". With `available: false` the editor tells the user there is no initial layout. |

`error.message` is shown to the user, so send text in the user's language.

## Optional project tools

Hosts opting in via `tools=1` can handle these additional M6 store operations. The usual same-origin, project ID
and request ID checks apply.

| Operation | `content` | Successful result |
|---|---|---|
| `assets` | `{ tab: 'current' \| 'history', page: number }` | `{ items: { src, name }[], more: boolean }` |
| `upload-asset` | An image `File` | `{ src, name }` for the newly uploaded asset |
| `export-options` | — | `{ premium: boolean }` |
| `export` | `{ html, name, pages, format, scale }` | The host downloads a ZIP and replies after completion. `pages` contains zero-based page indices. |

During export the host may send `export-progress` with `completed`, `total` and `fraction` (from 0 to 1).
A host can send `restore-draft` with `html` and `version` to apply a historical document as an undoable edit.
The editor does not persist the restored content until the user saves.

## Document format

One HTML document per project. Every page is a top-level element with class `slide`; the page count is the number of
top-level `.slide` elements. Each page's size comes from its `data-popost-width` / `data-popost-height` attributes, else
its inline `style` `width` / `height` in px (for example `style="width:1080px;height:1440px"`), else the `ratio` parameter,
else 1280x720; CSS rules and custom properties are not read, so declare the size on the page element. The document must be static: no `script`, `iframe`, `object`, `embed`, `base` or `form`,
no `on*` attributes, no `javascript:` URLs, no `<meta http-equiv="refresh">`. `src/core/validate.ts` (`validateDeck`)
is the check the editor runs before every save; hosts should run the same check on what they store.

In host mode the editor renders previews and thumbnails with `<base href="<host origin>/">`, so root-relative URLs in
the document (for example `/api/assets/<id>/raw`) load from the host. The preview CSP allows images, stylesheets and
fonts from the host's own origin and from `data:`/`blob:`; scripts and other origins stay blocked, except the image
origins the host lists in `imageOrigins`. A host whose picture URLs answer with a redirect to another origin lists that
origin there (the CSP is checked again on the redirect target); the preview, the filmstrip and the export panel
thumbnails all use it. The preview documents are `blob:` URLs created by the editor page, so they also inherit any
`Content-Security-Policy` header the host sends with `canvas/index.html`: its `img-src` has to allow the same origins.

### Reference comparison

Hosts may answer the `references` store operation with an ordered array of
`{ src: string, name: string }` images. The editor displays the reference at the
current page index beside the editable canvas. Extra design pages show an empty
reference rather than reusing another page. References are view state only: they
are not inserted into the document, saved, or exported. Hosts remain responsible
for authorizing image access. Unsupported hosts show a recoverable loading error.

### Cloud save (local server only)

The "Save to Cloud" / "Synced" control in the top bar appears only when the skill's local server injects
`window.__POPOST_LOCAL__.cloud = { mode: 'keyed' | 'anonymous' }`. Embedding hosts (`store=host`) never have it, so they
see no new UI and no new messages: nothing in this contract changes for them.
