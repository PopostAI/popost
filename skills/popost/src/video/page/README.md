# Page runtime

The browser half of the engine. `compile/page.ts` puts `main.ts`, bundled ahead of time into `compile/page-bundle.ts`
by `bundles/build-video.mjs` (`npm run build:video -w popost`), into one self-contained HTML page together with the
resolved timeline (`Resolved` from `types.ts`). The renderer, the preview and the tests all drive the same page.

## Contract

The page exposes `window.__popostVideo` (`contract.ts`):

| Member | Meaning |
|---|---|
| `frames`, `fps` | Length in frames and frame rate |
| `width`, `height` | Canvas size in CSS pixels; the viewport is `width*scale` x `height*scale` (`scale` is also exposed) |
| `prepare()` | Resolves once every image is decoded, every declared font (font materials) and every text font is loaded and the pictures of the current frame are ready; rejects naming the image or font that failed, or a video material whose frames were not extracted. When scenes did not load (their page or a picture in them), the error has `failures` (`SceneFailure` in `contract.ts`): every one, with its segment, the path as written and the address it was resolved to, which the renderer turns into a problem at each segment |
| `applyFrame(n)` | Puts the whole picture in the state of frame `n` (clamped to `0..frames-1`) |
| `settle()` | Resolves when every picture the last `applyFrame` referenced (video frames) is loaded and decoded, ready to paint; rejects naming a picture that could not be loaded. When `applyFrame` is called again before it resolves, it waits for the newer pictures instead |
| `layout()` | After `prepare()`: one `{ id, fits, lines, ink, block }` per text item (`LayoutFact` in `contract.ts`), measured in the item's own box before rotation and motion; boxes are fractions of the canvas. Leaves the picture as it was |
| `scenes(segment?)` | Every scene base as it is drawn now, or only the one of the segment given (`SceneFact`, `fit.ts`): the room its content needs; the marked places (`data-slot`) whose glyphs leave their element's box or are cut off by an element around it that hides its overflow, with the side and the pixels; and its texts (`texts.ts`): every element with text of its own, by its place in the document, and whether a viewer can see it (opacity up the tree at least 0.5, not hidden, a box partly inside the canvas and inside every box around it that hides its overflow, scaled at least a third). Glyphs, not font boxes: the characters' boxes are narrowed to the ink measured with the canvas API, so a tight `line-height` is not overflow by itself |
| `changed()` | Whether the picture differs from the one at the previous call of `changed()`: it compares the stage's markup (every inline style, text and picture address), which is all a frame sets. The first call answers true |

The renderer runs `applyFrame(n)`, awaits `settle()` and asks `changed()` in one call before every screenshot; when
the picture did not change it sends the previous screenshot again instead of taking a new one (`render --no-reuse`
turns that off, and `openRenderer` never does it). `renderVideo` may open several pages and give frame `n` to page
`n` modulo the page count: because a frame is a pure function of its number, the video is the same for any count.
The preview awaits `settle()` before it marks a frame as shown (`data-applied`). For pages without video, `settle()`
resolves at once.

Image URLs are relative to the project directory; whoever loads the page serves that directory next to it (the
renderer does it by request interception on a made-up origin, with no network, and refuses any path that leaves the
directory, through ".." or a symbolic link).

## Video layers

Video footage is shown as pictures, one per source frame. The build step (`compile/footage.ts`, run by `buildPage`)
reads each video material with `probe()`, resolves the project with those facts, and extracts exactly the source
frames the timeline shows into `<project>/.cache/video/<key>/<frame>.png` (key: a hash of the file's path, size and
modification time and the extraction size; a second build reuses them). The size is what the largest use needs on the
canvas times the render scale (and the camera's largest zoom), never more than the source. The frames go through RGB
with the source's own matrix and range, so colours stay true (an untagged HD source is read as BT.709, as players do).

`Resolved.footage` names each material's frame directory, and each video base or item carries a `play`
(`material`, `start`, `in`, `speed`). `applyFrame(n)` sets a shown video layer's `<img>` to the picture of
`sourceFrame(play, footage, fps, n)` (`timeline/footage.ts`, the mapping in the header of `types.ts`) and removes the
picture of a hidden one; nothing else about the layer differs from a picture base, camera and transitions included.

Loading the next frames ahead was measured and is not done: the renderer serves files by request interception, which
turns off the browser's cache, so a picture loaded ahead was fetched a second time when shown (two requests a frame,
no faster).

## Fonts

A material of kind `font` (`.woff2`, `.woff`, `.ttf`, `.otf`) is declared by the page with `@font-face` under the
material's id (`Resolved.fonts`; one face per file, used for every weight, so a static font is not made bolder). A
text style names it in `font`; resolve quotes the id inside the family list, so any id works. `prepare()` loads every
declared face and rejects naming the font when one fails, so a frame is never drawn with a fallback font.

## Layout facts

`layout()` (`layout.ts`) shows each text item for a moment in its static state, measures it and puts it back, all in
one synchronous call: `fits` (the lines fit the box in width and height, within half a pixel), `lines` (characters
grouped by line), `block` (the widest line by the height of all lines) and `ink` (where the glyphs are: the
characters' boxes narrowed to the glyphs' ascent and descent measured with the canvas API, half the stroke added).
`checkLayout(projectDir)` in `src/render/layout.ts` turns text that does not fit into a Problem with a fix (about how
many characters fit, or the box the text needs). It is the first check that measures the picture; template slots will
use it for their capacity.

## Purity

`applyFrame(n)` is a pure function of `n`: no timers, no `requestAnimationFrame`, no CSS transitions or animations,
no randomness, nothing read back from the DOM. Every element's whole inline style is rewritten on every call (static
part plus per-frame part), so no state of an earlier call survives. Why: frame `n` must look the same whether it was
reached by playing or by jumping, so export can render frames in any order or in parallel, preview can seek, and a
test can compute the expected picture. `tests/make-render.test.ts` checks it byte for byte.

The renderer launches Chrome with `--disable-partial-raster`: without it, a moving rounded shape left a stale
antialiased edge pixel when frame `n` followed `n-1` but not when it followed a jump.

## Layering

`viewport` > `stage` (exactly the canvas in CSS pixels, black, overflow hidden, scaled by a transform) > three layers:

1. Segment layers, one per segment, full stage. A layer is `display: none` outside its segment and its transitions.
   During a two-sided transition into segment k, layers k-1 and k are both shown in the states `transitionState()`
   gives; during a one-sided one only the shot on its side is shown, under the effect (header of `types.ts`). A colour
   base is a flat colour or a CSS gradient. A picture or video base moves with its camera on every visible frame,
   transitions included (`timeline/frame.ts`): the rate form runs over the whole visible range, keyframed moves
   (`presets/camera.ts`) count from the segment's start and hold their first and last state around them. A video base
   also plays on every visible frame, showing frame "in" before its segment starts.
2. The overlay of fade and flash transitions.
3. The item layer: every text, picture, video and shape, above all segment layers, so an item is never wiped with a
   segment. A caption track arrives here as one text item per cue. A picture or video clips to its box, with rounded
   corners (radius) or an ellipse (mask). An item's border is static CSS inside its box; its drop shadow is a static
   `drop-shadow()` put before the blur of a motion in the per-frame `filter`, so it follows glyphs, shapes and a
   picture's transparency. Its rotation, its own opacity and its loop (`presets/loop.ts`) are composed with the entrance
   and exit by `itemStateAt`: opacities and scales multiply, offsets and rotations add.
4. Text: a block (font, size, line height, letter spacing, text shadow, opacity) holding a run (stroke, background)
   holding one element per part of the text (`textParts`: the text cut at its spans, by code point). When the item
   types, every character is its own element, and a span's background sits on its characters, so it appears with them.
   A caption cue that follows the words is built by `words.ts` instead (below).

What is on screen at frame n is computed as data by `timeline/frame.ts` (`segmentsAt`, `itemStateAt`); `apply.ts`
only turns it into CSS and `dom.ts` builds the elements once.

## Words: captions that follow the spoken word

The project side is in the header of `types.ts`: an audio material may name a words file (the tokens of its script as
`src/align` writes them, in frames from the start of the file), an audio track puts those words on the timeline, and a
span may name a phrase instead of frames. The build step reads the words files (`compile/words.ts`) next to the
footage inspection and gives them to check and resolve, which stay pure.

A caption track with `"words"` arrives here as text items with three more fields. `words`: one
`{ from, to, start, end }` per token of the cue's text, its characters (by code point) and the frames it is spoken on;
resolve matches the cue's text to the tokens spoken inside the cue's span with the forgiving alignment of `src/align`
(`timeline/cue-words.ts`), so a misheard name still gets a time between its neighbours. `style.spoken`: how the
token being spoken looks. `reveal: 'words'`: each token appears when it is spoken (a `type` entrance is then resolved
as `none`; its even pace is replaced by the words).

Per frame, everything is a pure function of `n` (`presets/spoken.ts`): a token is before its frames, on them, or past
them, and looks like the base style, `spoken`, or `spoken.past` (the base style when there is none). A character
between two tokens takes the past look of the token before it. With reveal, every character before the first token
that has not started is shown, so punctuation after a word appears with it; a `type` exit still hides characters as it
goes.

**Nothing moves when a word changes look.** Weight changes the width of Latin glyphs, so every token is an inline-block
that holds two copies of its characters: an invisible one in the flow, set at the heavier of each character's own weight
and `spoken.weight`, which gives the token its room, and the visible one in a layer laid over the room, centred in it,
restyled per frame. `spoken.scale` (at most 1.3) is a transform of that layer, and `spoken.background` is a box
outside the flow around the room, so neither takes room. Stacking inside the item: the spoken token's box (z 0) under
every other token and the text between tokens (z 1), under the spoken token's characters (z 2): the box never covers a
neighbour, and a scaled word stays on top. `layout()` measures the rooms (it skips the layers, marked `data-glyphs`),
so a cue that fits, fits on every frame. `prepare()` also loads the face of the spoken weight, so the first spoken
frame never waits for a font.

What this costs:

- Every token is as wide as its heavier form for the whole cue. With `spoken.weight` 800 over a base of 400, the line
  "ww mm ww" at 19 px was 110 px wide instead of 106 (`tests/make-words-render.test.ts`), and a lighter word sits in a
  room a little too wide for it. CJK characters advance by the same width at every weight, so Chinese text does not
  change.
- Twice the text in the DOM for such a cue (the room and the layer).
- A token never breaks inside (an inline-block that does not wrap): a word longer than the box overflows instead, and
  `checkLayout` reports it. Lines break between tokens, which can differ slightly from the same text without words.
- The scale and the box take no room: a scale near 1.3 or a large padding can overlap the neighbours (the spoken word is
  drawn over them, its box under them), and `checkLayout` does not count them.

## Adding a motion preset, a loop or a transition

1. Add the name to `MOTION_PRESETS` or `TRANSITION_KINDS` in `src/types.ts` (a contract change: both halves).
2. Motion: add its defaults to `MOTION_DEFAULTS` and its shape to `entrance()` in `src/presets/motion.ts`. The state
   must be expressible as `ElementState`. Loop: add it to `LOOP_PRESETS` and give `loopState` in
   `src/presets/loop.ts` its shape, default amount and allowed range; it must be the identity at j = 0. Transition: add
   defaults to `TRANSITION_DEFAULTS` and a function to `KINDS` in `src/presets/transition.ts` (and, if it can be
   one-sided, an entry in `EFFECTS` and `ONE_SIDED_TRANSITIONS`); anything not expressible as `LayerState` needs a new
   field there and its CSS in `apply.ts`.
3. Tests: `tests/make-presets.test.ts` runs every preset and kind through its start, middle and end checks
   automatically; add a case for what is special about the new one. Add a frame of it to the determinism list in
   `tests/make-render.test.ts`.
4. If check needs to know about it (a direction that does not apply, for example), extend `src/project/check.ts`.
