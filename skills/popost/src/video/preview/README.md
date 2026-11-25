# Video Studio and preview debugger

Edit mode uses the Studio interface described in [video-editing.md](../../../references/video-editing.md).
The read-only debugger retains measurement lanes for development.

A local page that shows what the engine renders at any frame, how the timeline is laid out, and how a render compares
with a reference video and with the measurements. Read-only by default: it never writes to the project. With
`--edit` it becomes an editor of the same page (see [Edit mode](#edit-mode)).

## Start

```bash
popost video preview <project-dir> [--reference <video>] [--measure <render measure.json>] \
  [--reference-measure <reference measure.json>] [--port 4317] [--edit]
```

The command prints one JSON line with the URL and runs until it is stopped (Ctrl+C, or the host aborting it), like
`popost serve`. From code: `openPreview(rt, args)` (port 4317, or any free port when that is taken) or
`startPreview(rt, opts)` (returns `{ url, close }`; `edit: true` for edit mode), both from `index.ts`. It binds
127.0.0.1 through the runtime's local server (`rt.processes`); a host without one cannot run a preview.

## Features

- Stage: the compiled page of the project in an iframe, scaled to fit, driven only by `applyFrame(n)`.
- Reference video beside it at the same time, paused on the frame; a browser video seek is near, not frame-exact.
- Transport: play / pause, step -1 / +1 / -10 / +10, first / last, slider, frame and time, speed 0.25x / 0.5x / 1x.
- Keys: Space, Left / Right, Shift+Left / Shift+Right, Home / End; a box to jump to a frame.
- Lanes to scale in frames, click to seek: seconds, segments with transition bands (kind, length, direction),
  one lane per item (entrance and exit shaded and named), audio.
- Measurement lanes: boundaries and motion events of the render and of the reference, under the project's lanes.
- Overlays: item boxes with ids, measured motion events active at the frame, a safe-area guide.
- Side panel: the selection (clicked, or under the playhead) as resolved JSON, check's problems, the score table,
  which measurements are loaded, the draft notes.
- Live reload when video.json, a material file, a measurement or draft-notes.json changes; the frame is kept. The
  runtime has no file watcher: those files are looked at every half second (`watch.ts`).
- A project with errors shows the list of problems on the stage (location, message, allowed values, fix).
- Interface in English or Chinese (button in the header; the default follows the browser's language).
- Light and dark themes from the system setting; works from 1280x720 up.

## Files it looks for

- Render measurement: `--measure`, else `measure.json`, `render.measure.json` or `replica.measure.json` in the project.
- Reference measurement: `--reference-measure`, else `reference.measure.json`, `reference-measure.json` or
  `truth.json` (the round trip's truth) in the project.
- The score is `scoreMeasures(reference, render)` from `src/score`, shown when both measurements are there.

## Routes

`/` shell, `/page` compiled page (422 with the problems), `/project/<file>` project files (nothing outside the
directory), `/reference` the reference video with Range support, `/api/state` JSON (`protocol.ts`), `/api/events`
server-sent "reload" events. Without `--edit` only GET and HEAD are answered (405 otherwise). Tests:
`tests/video/preview-server.test.ts`, `tests/video/preview-shell.test.ts`.

## Edit mode

`--edit` (`startPreview(rt, { edit: true })`) turns the same page into an editor of video.json: select something, change
it, see it, save it. Code: `edit/` (server) and `shell/edit/` (page). Tests: `tests/video/preview-edit.test.ts`,
`tests/video/preview-edit-shell.test.ts`.

### In the page

- Select: click an item on the stage (the nearest one under the pointer at the frame), its bar or lane name in the
  lanes, a segment in the segment lane, or a chip in the panel. Escape clears the selection. The selection is kept in
  the browser's session storage, so a reload of the page keeps it.
- The side panel is a form built from the selection's SOURCE in video.json (not from the resolved timeline); where
  the timeline plays something else (a default, a resolved value) it is shown beside the field as "→ value". Text
  item: text, box, when (segment, from, to; or phrase, occurrence, lead, hold), style (preset style or own size,
  colour, weight, align), entrance and exit (preset, frames, direction, ease), look (rotate, opacity, z). Image, shape
  and video items: box, when, what they show (material, fit, corners, mask; shape and colour; first frame and speed),
  entrance, exit, look. Caption track: box, style, entrance and exit, and every cue with its text and its span.
  Segment: length, the transition into it (kind, frames, direction, mode, via, side, ease, strength), its base
  (colour, or material, fit, first frame and speed). Audio track: material, gain, start. Allowed values and ranges
  come from the zod schema (`GET /api/schema`) and from `src/presets`; an emptied optional field is removed, so its
  default applies again. A field commits when you press Enter or leave it (Ctrl+Enter in a text box).
- Stage: drag the selected item to move it, its corners and edges to resize it (Shift keeps the proportions), always by
  whole pixels of the canvas; the numbers show while dragging. Arrow keys move it by one pixel of the canvas,
  Shift+arrow by ten (nudges less than 0.4 s apart are one step). One operation per drag, sent on release.
- Lanes: drag an item's bar to move it in time (it changes segment when its start leaves its own), its ends to change
  from / to, and the grip at a segment's end to make that segment longer or shorter (the readout gives the change of
  the video's length). Edges move by whole frames and snap to the playhead, to segment borders and to the measured
  boundaries of the reference within 4 pixels; the readout names what they snapped to. Items placed on spoken words
  (phrase spans) are not dragged: change their lead and hold in the panel.
- Buttons in the header: undo, redo, add a text at the playhead (in the segment under it, two seconds, centred, style
  "subtitle"), duplicate the selection, delete the selection, render. Keys: Ctrl+Z undo, Shift+Ctrl+Z or Ctrl+Y redo,
  Delete deletes the selection, Escape clears it. Keys typed into a field belong to the field.
- The status line at the top of the panel says what was saved ("Saved: title.box") or why not (the first problem and
  its fix); every problem of a refused edit is also shown under the field it names.
- Render: writes `<project-dir>/out.mp4` with `renderVideo`; the progress and the result (frames, seconds, the file)
  show in the panel, and "Play it beside the stage" plays the render in the reference player's place, frame-locked
  like the reference.

### Routes (edit mode only)

| Route | Body | Answer |
|---|---|---|
| `POST /api/edit` | one operation (below) | 200 `{ ok: true, op, step, label, history, state }`; 400 (a bad operation or path), 409 (video.json is not valid JSON), 422 (check found an error): `{ ok: false, problems, history }` and nothing written |
| `POST /api/undo`, `POST /api/redo` | none | the same as an edit; 409 when there is nothing to undo or redo |
| `POST /api/render` | none | 202 `{ ok: true, render }`, 409 while a render runs; then `render` events on `/api/events` |
| `GET /api/schema` | | the JSON schemas of the parts the form edits, made from `src/project/schema.ts` |

`/api/state` gains `source` (video.json as written) and `edit` (`{ undo, redo, backup, render }`) in edit mode.

### Operations

A path addresses the JSON of video.json by keys and indexes: `["tracks", 2, "box"]`, or the same as the text
`"tracks[2].box"` (the form of a problem's location).

| Operation | Does |
|---|---|
| `{ "op": "set", "path": P, "value": V }` | V at P: an object's field (new or existing) or an existing entry of a list |
| `{ "op": "insert", "path": P, "value": V }` | P ends in an index of a list; V goes in before that entry (index = length appends) |
| `{ "op": "remove", "path": P }` | removes a list's entry (the ones after it move up) or an object's field |
| `{ "op": "move", "path": P, "to": N }` | P ends in an index of a list; that entry moves to index N of the same list (the order of tracks) |

Each operation is applied to the JSON in memory, then checked exactly as `popost video check` checks
(`edit/check.ts`: parse, read the video materials and the words files, `checkProject`, resolve). Only with no error is
video.json written: to a temporary file in the same directory, then renamed over it. A path that does not walk the
JSON (an index past the end, a key on a list, a field of a number), a key like `__proto__`, or a field the format does
not know (the schema only warns about those; the editor refuses them) is refused with the location, a message and a
fix. The file keeps its indentation and final newline.

### History and backup

- Undo and redo are kept in memory, up to 100 steps; they end with the server.
- On the first edit of a session, the video.json the session started with is written to `video.json.bak`. Later
  edits of the same session never overwrite it; the first edit of the next session replaces it with that session's
  starting point.
- An edit made outside (the watcher sees video.json change to something the editor did not write) is taken as the new
  state: it becomes a step of its own (undo takes it back too) and redo is cleared.

### What it never does

- It listens on 127.0.0.1 only: `startPreview(rt, { edit: true, host })` with any other address refuses to start.
- Without `--edit` no route writes anything; every POST is answered 405.
- A POST whose Origin is not the page's own (`http://127.0.0.1:<port>`, `http://localhost:<port>`) or whose
  Sec-Fetch-Site is another site is refused (403), as is a Host header that does not name the server (403), and a body
  over 1 MB (413).
- In the project directory it writes video.json and video.json.bak (each through a temporary file renamed over it) and,
  only when you press Render, out.mp4 (through out.mp4.partial.mp4). The frame cache of video materials under
  `.cache/` is written by the build, as in the read-only preview.
