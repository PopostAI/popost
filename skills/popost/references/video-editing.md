# Editable Video Studio

Start `popost video preview project --edit` in a persistent background process. Use its returned URL, verify `/api/state`,
and load the page before delivery. `--cloud off` keeps every save local.

Studio edits the existing `video.json`; it does not maintain a second timeline document. Preview selection, timeline clips,
and the Elements list address the same source object. Media groups shots and imported source files in one tab. Subtitles
have individual selectable clips. Selecting an element or subtitle in the sidebar reveals its visible frame and links the preview outline, timeline highlight and inspector. The inspector stays collapsed until something is selected; Escape or an empty timeline click clears the selection. Elements exposes editable scene content marked with `data-slot`; rasterized text inside
an existing video is not an editable text element.

The timeline starts with a fitted shot overview. Layers reveals the visual and caption lanes; selecting an element also
reveals these lanes. Shots are shown above their layers. Drag a shot to reorder it, or use Earlier / Later; drag an
item or audio clip to move it and its handles to trim it. Snap can be toggled. Shot duplication includes its owned
visuals and caption cues. Layer ordering controls change the source stacking ranks. Each completed operation is one
undo step; a cancelled pointer drag does not save.

The same source identity selects the preview outline, timeline clip, left sidebar and right inspector. Selecting a
caption opens Subtitles; selecting a visual or exposed scene field opens Elements; selecting a shot opens Media / Shots.
The inspector puts content and typography first, with pixel geometry, seconds and motion in its advanced section.
Double-click native text or an exposed text field to edit it on the canvas; click away or use Cmd/Ctrl+Enter to save,
and Escape to cancel. Native images can be selected, resized and replaced through their material field. Exposed scene
image fields use the scene slot replacement controls. Text editing fits an overflowing native title into its existing
box by saving a smaller font size with the text, so preview, inspector and export agree and Undo restores both.

Shortening a shot keeps its scene-local spans within its new length and fits entrance/exit motion to the available
span. Incoming transitions and ordered caption cues are adjusted when shots change length or order. Explicit
cross-shot spans retain their intent. Splitting a scene preserves its animation clock through `base.offset` (seconds).
Ordinary audio uses `in` in project frames; video-backed audio beds use source frames.

Cloud saving uses the same authorization service as image projects: a configured key syncs at startup and after a three
second quiet period; without a key, Save to cloud opens the project-scoped browser authorization flow. A browser ticket
permits one successful sync. Later anonymous edits stay local until another authorization. Conflicts never overwrite a
newer cloud revision automatically. The controls mirror the image editor: waiting and uploading states, a copyable login link when popups are blocked, retained-credential retries, keyed conflict overwrite and an Open link after saving. Cloud actions first flush focused fields and pending JSON edits; an invalid local draft prevents upload. The editor's `.studio/cloud.json` stores the stable project id, file upload receipts
and sync revision; it never stores credentials.

Video sync preserves the source document, scene HTML/CSS/scripts and referenced media. Files upload directly to signed
storage URLs and are reused by content hash. The web asset retains the complete editable project and can download it as
a ZIP; extract it and reopen its folder with the local Studio. This is source-project preservation; it does not regenerate
a flattened MP4 for every local text edit.

Export is a compact settings dialog for MP4 or an editable desktop draft. Selecting 4K shows the paid-resolution guidance
and pricing link when the account has no entitlement; the server verifies the entitlement before rendering. Completed
exports remain in the project folder.
