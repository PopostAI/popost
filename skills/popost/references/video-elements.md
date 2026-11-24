# The elements of every shot

Programs measure when and where things happen in a video (cuts, spans, text boxes, colours); they cannot say what a
thing is or how it looks. So after `describe`, the frames are read by a model that looks at them, and what it sees is
written down shot by shot in `elements.json`, beside `measure.json` in the directory describe wrote: every layer
of the shot with its box, a look precise enough to redraw it, what it shows and its role; the change into the shot
(an effect of its own as `custom`, with what happens frame by frame); the captions' style; every mark and why it is
there. `popost video elements check` holds the file to the measurement, `template save` carries it into the
template (TEMPLATE.md names each shot's layout, what to keep, what to replace and what is dropped), and the checks of
the fill and of the project use it.

```bash
popost video elements questions ref   # the instructions below, the pictures to open in order, the shots to describe
popost video elements check ref       # the file against the measurement: one line per shot, and problems with a fix
```

Write the file yourself after opening every picture, or let another model write it: `questions` prints the part of
this page from "For the reader" on, followed by this video's shots, as `prompt`, and the pictures to send with it in
order as `pictures`. Run `check` until it prints `"ok": true`, and correct or answer every warning: each says
what it found and what to write. Then save the template (`popost video template save ref ...`), which reads the file.

What the program does with it:

- A shot whose change in is `custom` is drawn by a scene of yours; `template fill` makes the engine's change there a
  cut and moves it to the start of the effect, so that the scene covers the whole effect. When the shot before it says
  `sameEffectAsNext`, that shot's scene draws the effect instead: the cut moves to the end of the effect, and the
  scene runs on over the first frames of the next shot. No script edits `video.json` afterwards.
- Layers with the role `platform` or `creator` are never re-made; their words, as the text reader read them, are
  kept apart, and `template check` and `video check` warn when a scene or a caption shows them. A last shot with
  `drop` is left out of the template: the shot before it becomes the re-make's own closing.
- Each shot's layout is kept: `template check` and `video check` warn when a shot read as full-frame footage or a
  recording is built as a designed scene with small pictures, and the other way round.

## For the reader

You are shown consecutive frames of a video, the time of each frame under it; a time on an orange band is a frame
inside a measured transition. `opening.jpg` holds the first 3 seconds, `shots/NN-frames.jpg` each shot from just
before the change into it to its end, and `transitions/NN.jpg` each change that is not a plain cut, frame by frame,
named by the shot it leads into. Open every one, in order. Then write `elements.json`: one entry per shot, numbered
and timed as the list of shots gives them. Say what the frames show: a label the measurement gave (a transition's kind)
can be wrong, and what you see wins. Write nothing you cannot see.

### The file

`{"shots": [...]}`, one object per shot, with these keys:

| Key | Type | What |
|---|---|---|
| `shot` | number | the shot, from 1, as the list numbers it |
| `time` | [start, end] | its seconds, copied from the list |
| `job` | words | what the shot does in the story: a hook, a proof, a demo, a comparison, a call to action |
| `layout` | words | the kind of picture, in generic words: a full-frame screen recording, a window or phone frame on a designed ground, a card beside a picture, a title card, a person to camera with inserts |
| `sameEffectAsNext` | true | an animation of this shot runs across the boundary into the next shot; leave it out otherwise |
| `transitionIn` | object | how the shot begins, not on shot 1: `kind`, `seconds`, `description` |
| `layers` | list | everything the shot shows, the ground first: `id`, `kind`, `box`, `look`, `content`, `role`, and `enters`, `moves`, `leaves` for what moves |
| `captions` | object | `base`: how the captions look; `highlight`: how the words drawn differently look and which words they are, or "none"; `reveal`: how a line appears (at once, word by word, letter by letter, wipes on) |
| `emphasis` | list | every mark: `what` (box, zoom, pointer, circle, underline, arrow, other), `on` (what it marks), `why` (what the line at that moment says that makes it worth marking) |
| `rebuild` | words | two or three sentences on how to draw the shot again |
| `drop` | words | only on a last shot that is the platform's end card or the author's sign-off: the shot is not re-made, and why |
| `status` | object | how the fields beside it are known, by field name: see "How each value is known". A shot labels `time`, `job`, `layout`, `captions`, `emphasis`; a layer and `transitionIn` carry their own |

When OCR mistakes a page heading for a caption, give `captions.lines` the actual caption lines visible in this shot.
Use `[]` when the shot has no captions; omit it to keep the automatic roles. Give the caption layer its real box.
`elements check` warns about a line it cannot match to timed OCR inside that box. `template save` uses matching OCR
times and geometry, corrects small spelling errors to your confirmed words, and excludes page text from the caption
beats. It never invents timing or changes numbers to obtain a match. Review the resulting `template show` before
writing the new lines. The original words stay in reference evidence, outside the reusable template's design.

A layer:

- `id`: a short name, unique in its shot.
- `kind`: ground, frame, screen, footage, picture, person, product, caption, title, sticker, highlight, pointer,
  object, platform or other.
- `box`: [x, y, width, height] as shares of the frame, from its top left corner; [0, 0, 1, 1] is the whole frame.
- `look`: precise enough to redraw it: colours (hex when you can tell), shape, corner radius, the weight and size of
  its type, outline, plate, shadow, angle.
- `content`: what it shows or says.
- `enters`, `moves`, `leaves`: how and when, in seconds of the video ("pops in at 2.6 s", "scrolls down from
  3.0 s to the end of the shot").

The change into a shot: `kind` is cut, fade, flash, dissolve, wipe, slide, zoom, spin, blur, glitch, shake or whip
when the change is exactly that, with `seconds`; otherwise `custom`, with a `description` of what happens frame by
frame: which object moves and along which path, the shape of the edge, what is revealed, where it starts and ends
(when the shot's file has a "Paths" line for the change, take the path angle, the size, the positions, the seconds and
the edge from it, and say what the object is). A
change the list says does not fit well is most often custom; if you call it a standard kind, say why in
`description`. An effect that starts in one shot and finishes in the next is the next shot's `transitionIn`, and
the shot it starts in says `sameEffectAsNext`.

A standard kind is what the engine draws under that name, not what the word means elsewhere; the list of shots gives
the measurement's label, which is a guess to check against these. Each one, as the engine draws it:

- `cut`: no frame in between.
- `fade`: the picture dips to black (or white) and comes back on the new one; the two are never seen at once.
- `flash`: a white flash peaks in the middle; the picture swaps under it.
- `dissolve`: the new picture fades in over the old one; both are seen at once and nothing moves.
- `wipe`: a hard straight edge crosses the frame from one side (or a circle opens from the centre, or closes from the
  edges); neither picture moves, the new one is uncovered behind the edge; no blur, no streaks.
- `slide`: whole pictures move across the frame in one direction, sharp: the new pushes the old out, slides over it,
  or the old slides away from it.
- `zoom`: the old picture grows towards the viewer and fades out; the new one settles from slightly enlarged.
- `spin`: the picture turns about its centre, up to a quarter turn, and the new one turns back into place.
- `blur`: the old picture blurs out, the new one comes in blurred and sharpens; nothing moves.
- `glitch`: a few frames jump sideways at random and flick between the old and the new picture.
- `shake`: the picture jumps in small steps that grow and settle; the new one takes over in the middle.
- `whip`: both pictures move fast in one direction with streaks along it (a motion smear): the old one leaves
  towards one side and the new one follows in from the other.

Any of them may act on one side only: the old shot leaves that way and the new one simply appears, or the old one
simply ends and the new one arrives that way; say which in `description`. Streaks along a movement are a whip, not a
wipe; a moving edge with something drawn along it, a shape that leads it, objects that fly in or apart, a page that
turns or folds are custom.

### How each value is known

The reading's files tag their values: `[measured 0.76]` was read off the frames by a program (0.76 is its confidence),
`[inferred: ...]` is concluded from measured facts and may be wrong, `[unknown: ...]` could not be read. Say the same of
what you write, in a `status` object beside the fields it labels (a shot's, a layer's `box`, `look`, `content`,
`enters`, `moves`, `leaves`, a change's `kind`, `seconds`, `description`):

- `"measured"`: you copied the value from the reading (`shots/NN.md`, `timeline.md`): a time, how long a change
  lasts, a path, a text's box, a colour. What a thing is, what it is for and how to draw it are never measured.
- `"inferred"`: you saw it in the frames. This is most of what you write.
- `"unknown"`: you could not tell (too small, too fast, covered, between two frames). Leave the value out or give your
  best guess; never present a guess as seen.

A label is one of the three words, or `{"status": "inferred", "note": "..."}`. The note is needed when your value
contradicts a measured one: `elements check` warns when a change the reading measured (its kind, how long it lasts,
its path) is given differently without a note or a `description` that says what the frames show instead, and when a
field labelled `measured` does not agree with the reading. Copy measured numbers exactly: a re-make is set from them.
A file without `status` is still valid; its values count as unlabelled.

### Roles

- `design`: the re-make keeps its look: a ground, a frame, the captions, a sticker, the type of a title.
- `content`: the re-make shows its own subject in this place: the page, the product, the picture, the words of a
  title. A layer whose look is design and whose words are content (a title) is `content`, its type in `look`.
- `platform`: belongs to the platform the video was posted on: a watermark, an account name or handle, the
  platform's own pages, buttons and end card. Never re-made.
- `creator`: belongs to the original author: their face, name, avatar or signature. Never re-made.

A text that stays in one corner through the whole video is most often `platform`. A last shot made mostly of
`platform` and `creator` layers is an end card: give it `drop`, and the re-make ends with its own closing.

### Marks

Every box, circle, pointer, underline or zoom onto something is an entry of `emphasis`, and its `why` says what the
line at that moment says that makes the thing worth marking ("the line boasts about how many people use it"). A
re-make keeps the job of the beat and puts the same kind of mark on what its own line talks about: the new subject's
strongest point for that job, taken from the request first and the sources second. A kind of fact that is weak or
absent for the new subject (a count, a ranking, a price) is not marked in a weaker form; the mark goes on what the
request stresses instead.

### Example

Not from any real video: a short tutorial opens on a title card, a paper plane flies across it and pulls the next
picture in behind a curved edge, a recording of an app follows, and the platform's end card closes it.

```json
{"shots": [
  {"shot": 1, "time": [0, 2.2], "job": "hook: names the problem", "layout": "a title card on a flat ground",
   "sameEffectAsNext": true,
   "layers": [
     {"id": "ground", "kind": "ground", "box": [0, 0, 1, 1], "look": "flat deep blue #1d2b53", "role": "design"},
     {"id": "title", "kind": "title", "box": [0.1, 0.32, 0.8, 0.2], "look": "white heavy sans, 9% of the height, two lines, centred", "content": "the question the video answers", "role": "content", "enters": "rises and fades in 0.2-0.6 s"},
     {"id": "plane", "kind": "object", "box": [0.02, 0.62, 0.14, 0.12], "look": "white paper plane with a thin grey outline, tilted 15 degrees up", "content": "a paper plane", "role": "design", "enters": "flies in from the left at 1.6 s", "moves": "along a rising curve to the right edge, 1.6-2.4 s"},
     {"id": "handle", "kind": "platform", "box": [0.72, 0.03, 0.25, 0.05], "look": "small white text at 60%", "content": "the account handle", "role": "platform"}
   ],
   "rebuild": "A deep blue card with the title rising in; at 1.6 s a paper plane enters at the left and flies up and to the right. The plane carries on into shot 2."},
  {"shot": 2, "time": [2.2, 6.0], "job": "demo: the fix in the app", "layout": "a full-frame screen recording",
   "transitionIn": {"kind": "custom", "seconds": 0.5, "description": "The plane from shot 1 keeps flying up and to the right; a curved edge trails it, and behind the edge the recording of shot 2 is revealed from the lower left until it fills the frame at 2.5 s.",
     "status": {"kind": "inferred", "seconds": "measured"}},
   "layers": [
     {"id": "page", "kind": "screen", "box": [0, 0, 1, 1], "look": "a light app screen, full frame, no device frame", "content": "the app's settings page", "role": "content", "moves": "scrolls down slowly 3.0-5.5 s"},
     {"id": "box", "kind": "highlight", "box": [0.55, 0.4, 0.3, 0.1], "look": "orange rounded rectangle, 4 px outline, no fill", "content": "around the sync switch", "role": "design", "enters": "draws itself clockwise 4.2-4.6 s"},
     {"id": "captions", "kind": "caption", "box": [0.1, 0.84, 0.8, 0.08], "look": "white bold sans on a black plate at 70%", "role": "design",
      "status": {"box": "measured", "look": "inferred"}},
     {"id": "handle", "kind": "platform", "box": [0.72, 0.03, 0.25, 0.05], "look": "small white text at 60%", "content": "the account handle", "role": "platform"}
   ],
   "captions": {"base": "white bold sans on a black plate at 70%", "highlight": "the name of the setting in yellow", "reveal": "word by word as spoken"},
   "emphasis": [{"what": "box", "on": "the sync switch", "why": "the line says one switch fixes it"}],
   "rebuild": "Record the new app's page full frame and scroll it as here; draw the orange box around what the new line names, when it names it."},
  {"shot": 3, "time": [6.0, 7.5], "job": "the platform's end card", "layout": "an end card",
   "transitionIn": {"kind": "cut"},
   "layers": [
     {"id": "ground", "kind": "ground", "box": [0, 0, 1, 1], "look": "black", "role": "design"},
     {"id": "avatar", "kind": "person", "box": [0.42, 0.25, 0.16, 0.28], "look": "round photo with a white ring", "content": "the author's avatar", "role": "creator"},
     {"id": "follow", "kind": "platform", "box": [0.35, 0.6, 0.3, 0.08], "look": "red pill-shaped button", "content": "the platform's follow button", "role": "platform"}
   ],
   "drop": "the platform's end card; the re-make ends with its own closing"}
]}
```
