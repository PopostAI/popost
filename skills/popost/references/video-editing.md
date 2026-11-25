# Editable Video Studio

Start `popost video preview project --edit` in a persistent background process. Use its returned URL, verify `/api/state`,
and load the page before delivery. `--cloud off` keeps every save local.

Studio edits the existing `video.json`; it does not maintain a second timeline document. Preview selection, timeline clips,
and the Elements list address the same source object. Media groups shots and imported source files in one tab. Subtitles
have individual selectable clips. Elements exposes editable scene content marked with `data-slot`; rasterized text inside
an existing video is not an editable text element.

The inspector edits content, pixel position, timing in seconds, and type-specific settings. Advanced motion settings are
collapsed. Valid edits save locally and participate in undo/redo. Split and delete sit above the timeline; horizontal
scrolling, Shift+wheel, zoom, and Fit timeline control the visible interval. Splitting a scene preserves its animation
clock through `base.offset` (seconds). Ordinary audio uses `in` in project frames; video-backed audio beds use source frames.

Cloud saving uses the same authorization service as image projects: a configured key syncs at startup and after a three
second quiet period; without a key, Save to cloud opens the project-scoped browser authorization flow. A browser ticket
permits one successful sync. Later anonymous edits stay local until another authorization. Conflicts never overwrite a
newer cloud revision automatically. The editor's `.studio/cloud.json` stores the stable project id, file upload receipts
and sync revision; it never stores credentials.

Video sync preserves the source document, scene HTML/CSS/scripts and referenced media. Files upload directly to signed
storage URLs and are reused by content hash. The web asset retains the complete editable project and can download it as
a ZIP; extract it and reopen its folder with the local Studio. This is source-project preservation; it does not regenerate
a flattened MP4 for every local text edit.

Export is a compact settings dialog for MP4 or an editable desktop draft. Selecting 4K shows the paid-resolution guidance
and pricing link when the account has no entitlement; the server verifies the entitlement before rendering. Completed
exports remain in the project folder.
