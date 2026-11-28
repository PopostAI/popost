# Writing a scene

A scene is one HTML page that fills the canvas for one shot of a video. You write it for this video: its layout, its
drawings and its motion are yours. The engine shows it inside the video, puts it on the video's clock, and checks
it. This page is the whole contract.

## The page

- A whole HTML page in the project, for example `scenes/shot-03.html`, used by a segment as
  `"base": { "scene": "scenes/shot-03.html" }`.
- `html, body` are exactly the canvas (for example 1280x720 CSS pixels), with no margin and `overflow: hidden`.
- Everything is in the file or in the project: inline `<style>`, inline SVG, pictures and fonts by a path relative to
  the scene file (`../assets/logo.png`). Nothing comes from the network.
- Chinese text: use the fonts of the machine by family name (`"Noto Sans CJK SC"`), or a font file of the project
  with `@font-face`.

## Motion: the engine owns the clock

The renderer draws frames in any order (it may jump, and several pages draw at once), so a frame must depend on its
time only. Time is counted in seconds from the start of the scene's segment. Three ways, which can be mixed:

1. **CSS animations** (`@keyframes`) and **element.animate()**. Write them as if they played from the start of the
   shot: `animation: rise 0.5s 1.2s both` starts 1.2 s into the shot. Use `both` (or `forwards`) so that things hold
   their first and last state. The engine pauses every animation and sets it to the frame's time.
2. **A timeline of an animation library**, created paused and handed over:
   `window.__timelines = { main: timeline }` (or `window.__popostScene = { timeline }`). The engine calls
   `pause()` and `seek(seconds)` on it. The library is a script file of the project
   (`<script src="../lib/NAME.min.js"></script>`). Put every tween on that timeline; a tween started on its own runs
   on the real clock and is refused by the check when it can be seen.
3. **Your own drawing**: `window.__popostScene = { render(seconds, fps) { ... } }`, called for every frame. It must
   set everything it controls from `seconds` alone (a counter, a typed text, a chart).

Not allowed, because the result would differ from one render to the next: `setTimeout`, `setInterval`,
`requestAnimationFrame`, `Date.now()`, `performance.now()`, `Math.random()`, CSS `transition`, `<video>`,
`<audio>`, `<iframe>`, and anything that talks to the network or reaches outside the page. `check` names each of
these with a fix.

## A timeline library, for motion in sequence

Several elements entering one after another, a list that staggers in, a number that counts while a bar grows: a
timeline is easier to write, and to retime, than separate CSS delays. The Skill supplies GSAP:

```bash
popost video scene library project        # writes project/lib/gsap.min.js; a scene in scenes/ loads ../lib/gsap.min.js
```

```html
<script src="../lib/gsap.min.js"></script>
<script>
  gsap.config({ force3D: false });
  gsap.set('.badge', { rotation: -6 });                                   // what does not animate: set it, do not tween it
  var tl = gsap.timeline({ paused: true });                               // one timeline, paused; never tl.play()
  tl.from('.card', { x: -900, duration: 0.6, ease: 'power3.out' }, 0)     // the last argument: seconds from the shot's start
    .from('.label', { opacity: 0, y: 16, duration: 0.4 }, 0.5)
    .from('.row', { opacity: 0, y: 24, duration: 0.35, stagger: 0.12 }, 0.8)
    .to('.bar', { scaleX: 1, duration: 1.2, ease: 'power2.inOut' }, 1.0);
  window.__timelines = { main: tl };                                      // hand it over: the engine seeks it to every frame
</script>
```

- Every tween is on that one timeline. `gsap.to(...)` on its own, `tl.play()`, `gsap.delayedCall`, `gsap.ticker`,
  ScrollTrigger and Draggable run on the real clock or need a user: do not use them.
- `from()` and `fromTo()` put their start values on the element from the first frame of the shot, so an element that
  enters at 1.2 s is hidden before it. When an element must be seen before a later `from()`, give that tween
  `immediateRender: false`.
- Transform origins belong in CSS (`transform-origin: left center`), not inside a tween. An element that GSAP moves or
  scales loses a `rotate`, `scale` or `translate` property written in the stylesheet: give it with `gsap.set` instead.
- The rules of "The length of the shot" hold: no exit; on a text or explainer card the entrances come early and then hold, while a motion-graphics shot keeps moving to its last frame.
- GSAP is a product of Webflow under its own licence (free to use, not open source: https://gsap.com/standard-license).
  The file in the project is its unchanged file; leave it so.

Items in a template fill may specify `span: [0.15, 1]` to appear from fifteen percent of the shot until its end. The interval follows the shot when speech changes its length. `enter` and `exit` use native motions, for example `{ "preset": "fade", "frames": 9 }`; the clip starts at `in` when its visible interval starts. `audio: 0` preserves its source sound; omitted audio is silent.

## Example scenes with parameters

Four effects that are easy to get wrong by hand are in the Skill as scenes with declared parameters. Each is a scene
like any other (one HTML file, drawn from the time given to `render(seconds)`, no clock of its own, drawn shapes only),
with a block `<script type="application/json" id="popost-params">`: `params` declares every parameter (name, type,
default, range or options, what it does), `values` holds what this copy sets.

| Example | What it draws | Its main parameters |
|---|---|---|
| `object-reveal` | an object crosses the frame and the next picture opens behind it, then fills the frame | `startX` `startY` `endX` `endY` (the path), `object` (plane, arrow, dot, none), `objectSize`, `objectLength`, `edge` (wedge, straight, circle), `spread`, `travel`, `duration` |
| `card-flip` | a card turns half a turn in depth, front to back | `axis`, `toward`, `depth`, `lift`, `shade`, `width` `height` `x` `y` `radius` |
| `folding-doors` | the old picture splits and its panels fold away to both sides | `panels` (2, 4, 6, 8), `axis`, `swing`, `depth`, `shade` |
| `streak-wipe` | the next picture arrives along one direction in bands, softened while they move | `angle`, `streaks`, `reach`, `order`, `blur` |

All take `duration`, `delay` (seconds from the start of the shot) and `ease` (linear, in, out, in-out).

```bash
popost video scene example                                   # every example with its parameters, ranges and defaults
popost video scene example object-reveal --set startY=0.5 --set endY=0.5 --set objectSize=0.32 --set spread=45 \
  --set travel=1.2 --set duration=1.8 --sheet look/reveal.jpg   # a sheet of its frames, each with its time; no project needed
popost video scene example object-reveal --set ... --size 1280x720 --out project/scenes/shot-02.html
```

How to use one:

1. Start from the example nearest to what the reference's frames show; write your own scene only when none is near.
2. Set its parameters from the measured path of the reference (`ref/shots/NN.md`, "Paths"), not from an impression:
   the object's start and end are the path's `from` and `to` (carried on past the frame's border by half the object's
   length when it enters or leaves the frame: `from` and `to` are measured while it is cut by the border), `objectSize`
   is its size across the path as a share of the height, `objectLength` its size along the path as a share of the
   width, `travel` the seconds the object takes, `duration` the seconds of the whole change, `delay` when it starts in
   the shot, `edge` and `spread` the shape of the edge and the opening of a wedge, `ease` the path's ease. An angle
   is the same everywhere: 0 is to the right, 90 down, -90 up.
3. Render a sheet (`--sheet`, with `--seconds` and `--frames` as the reference's picture of the effect has them) and
   hold it against `ref/transitions/NN.jpg`; change the values until they agree. `--size` is the project's canvas.
4. Write it into the project (`--out`). Its two pictures are slots on `<img>` elements (`old` and `next`; the card's
   are `front`, `back` and `ground`): a fill gives them as `"slots": {"old": "../assets/a.png", "next": "../assets/b.png"}`.
   Or replace what is inside the picture elements with your own HTML (the drawn stand-ins are only there to be seen).
   A parameter can still be changed by hand in `values`.
5. After the render, `popost video compare` holds the path of your effect to the reference's (`paths`): fix what its
   `differs` names and compare again.

A value outside its range is refused with the range; a scene changed beyond its parameters is your own scene and is
checked like one (`popost video scene check`).

## Content that can be replaced

Mark every piece of content that belongs to the subject, not to the design, with `data-slot="name"`: a title, a
label, a number, a picture. A project can then give other content for the same scene:
`"base": { "scene": "scenes/shot-03.html", "slots": { "title": "新的标题", "logo": "../assets/new.png" } }`, or a
template fill: `{ "scene": "scenes/shot-03.html", "slots": { ... } }`. A slot on an `<img>` takes a picture path,
relative to the scene file like every path in it; on any other element it takes text, which replaces everything
inside the element, so mark the element that holds only that text. A script that needs a slot's value (a counter
that counts up to it) reads the element's text inside `render(seconds)`: the slots are filled after the page's own
scripts have run. Leave room: a slot's text may be a little longer or shorter than yours. `scene check` warns when the
glyphs of a marked text leave its element's box, and when they fit it but an element around it that hides its
overflow (a card with a height and `overflow: hidden`) cuts them off; each warning names the side and the pixels, and
the element that cuts. It measures the glyphs themselves, not the font's line box: Chinese text needs a `line-height`
of about 1.1 or more, Latin letters that reach below the line (g, p, y) about 1.4, or room below.

## A screen inside a scene

A page can also be shown in a designed shot instead of a recording: a still of it in a framed window, inside a scene.

### The screen helper

It draws a camera that moves in to what the line names, a box round it, a pointer that moves there and clicks, text
typed into a field, and the page after the click; the scene gives it a window and a list of steps.

```bash
popost video capture <url> --size 1280x720 --scale 2 --still project/assets/page-01.png   # prints y and stillScale
popost video capture <url> --size 1280x720 --outline                                      # each element's box
popost video scene library project --name screen                                         # writes project/lib/popost-screen.js
```

```html
<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: 1280px; height: 720px; overflow: hidden; background: #2b3a67; }
  #window { position: absolute; left: 160px; top: 90px; width: 960px; height: 540px; border-radius: 14px; background: #fff; }
</style></head>
<body>
  <div id="window"></div>
  <script src="../lib/popost-screen.js"></script>
  <script>
    popostScreen('#window', { still: '../assets/page-01.png', scale: 2, top: 0, steps: [  // stillScale and y of --still
      { at: 0.3, zoom: [445, 104, 389, 206], fill: 0.6 },       // the Pro card fills 60% of the window
      { at: 1.3, highlight: [469, 172, 341, 58] },              // a box round its price; style: 'underline' or 'dim'
      { at: 1.6, pointer: [469, 172, 341, 58] },                // the pointer moves there on a curve
      { at: 2.3, click: true },
      { at: 2.6, clear: true },
      { at: 2.6, view: 'width' },                               // back to the whole width ('all': the whole still)
      { at: 3.4, type: 'ana@example.com', into: [56, 382, 1030, 46], for: 1.0 },
      { at: 4.7, pointer: [1102, 382, 122, 46] },
      { at: 5.4, click: true },
      { at: 5.6, still: '../assets/page-02.png' }               // the page after the click, from that moment
    ] });
  </script>
</body></html>
```

- Boxes are `[x, y, width, height]` exactly as `--outline` prints them, in page pixels; `scale` and `top` are the
  `stillScale` and `y` that `--still` printed (a swapped still takes its own `scale` and `top` when they differ).
  Times are seconds from the start of the shot, in order; `for` is how long a step takes (zoom and view 0.8 s,
  highlight 0.4, pointer 0.6, typing 1.2), `ease` how (`in-out`, `in`, `out`, `linear`).
- `scroll: 400` (400 page pixels down from the camera position at this step, or `'top'`, `'bottom'`) moves a tall still (`--full-page`). After the last step
  everything holds, so the shot may run longer. A highlight goes with `clear` or when the still is swapped.
- Take the still at `--scale 2` when the shot moves in: `scene check` warns when a zoom enlarges the still more than
  about 2.5 times, and names a box outside the still, steps out of order, a click with no pointer and a still that
  does not load.
- Your own drawing can sit beside it: set your `window.__popostScene` first; the helper adds itself to its `render`.

### Footage inside a scene

A clip or a picture of other proportions than the canvas (a portrait screen recording in
a landscape video), or the constant frame `describe` found round every shot (REFERENCE.md, `Frame:`), belongs in a
designed shot, never alone on a bare ground. The scene draws the ground, the frame and its own text; the clip is an
item of the shot, drawn over the scene in the frame's opening. A frame on a moving ground (REFERENCE.md,
`Frame on a moving ground:`, an animated backdrop that does not cut where the content cuts) is one scene in every
shot whose ground moves on across the cuts: start its animation at minus the shot's start
(`animation-delay: -12.4s` in the shot that starts at 12.4 s), so that the ground is where the shot before left it. In fill.json it goes in the shot's `items`: `"video"`
(a picture: `"image"`) and its `box`, the opening in canvas pixels divided by the canvas size, at the clip's
proportions (a 9:16 clip 576 px tall is 324 px wide; for the frame of `describe`, the box it gives); `"fit": "cover"`
fills it, `radius` rounds its corners (a fraction of the box's smaller side), `"in"` is the clip's first frame.
  A video item's own sound follows the rule of footage (`video-templates.md`): with no `"audio"` it is kept in a video
  that has no voice and no `"sound"`, and silent in one that has; `"audio": 0` keeps it, a lower dB gain keeps it
  under narration, `false` mutes it. The sound follows the same trim, speed and segment as its picture. Studio shows
  the gain too; an empty field is the automatic rule.
  `template fill` (and `retarget`) writes each item into `video.json` as a material and a track during the shot's
segment, so the clip stays through every later fill and moves with the shot when time is re-flowed to speech;
`template check` says when its file is missing or the box would crop it. Never add it to `video.json` by hand in a
filled project: the next fill writes `video.json` again and drops it. In a project written without a fill, add the
material and the track yourself. A phone on the right of a 1280x720 shot, its screen at `[768, 72, 324, 576]` px, so
`box` `[0.6, 0.1, 0.2531, 0.8]`; the title rises in, the clip plays from its first frame. The scene, then the shot in
fill.json:

```html
<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: 1280px; height: 720px; overflow: hidden;
               background: linear-gradient(135deg, #1d2b53, #3b1f5c); font-family: "Noto Sans CJK SC", "Noto Sans", sans-serif; }
  /* The phone's body, 14 px round its screen [768, 72, 324, 576], where the video item is drawn. */
  .phone { position: absolute; left: 754px; top: 58px; width: 352px; height: 604px; border-radius: 40px;
           background: #0b0d17; box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45); }
  .title { position: absolute; left: 96px; top: 250px; width: 560px; font-size: 52px; font-weight: 800; line-height: 1.25;
           color: #ffffff; animation: rise 0.6s ease-out 0.2s both; }
  @keyframes rise { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: none; } }
</style></head>
<body>
  <div class="phone"></div>
  <div class="title" data-slot="title">Order in three taps</div>
</body></html>
```

```json
{ "scene": "scenes/phone.html",
  "items": [ { "video": "assets/app.mp4", "box": [0.6, 0.1, 0.2531, 0.8], "fit": "cover", "radius": 0.07, "in": 0 } ] }
```

What `template fill` writes into `video.json` for it as the second shot (the ids follow the shot and the order):

```json
{ "version": 1, "canvas": { "width": 1280, "height": 720, "fps": 30 },
  "materials": [ { "id": "video-1", "kind": "video", "file": "assets/app.mp4" } ],
  "segments": [ { "id": "shot-02", "frames": 120, "base": { "scene": "scenes/phone.html" } } ],
  "tracks": [ { "id": "shot-02-video-1", "type": "video", "material": "video-1", "box": [0.6, 0.1, 0.2531, 0.8], "fit": "cover",
                "radius": 0.07, "in": 0, "during": { "segment": "shot-02" } } ] }
```

## The length of the shot, and what moves in it

The video's timing comes from its reference and, with a voice, from the spoken lines, so a shot can end up longer or
shorter than the reference shot it re-creates. Leave the end of the shot to the transition: an exit animated at the
end of your shot would play at the wrong time.

What moves, and for how long, depends on the kind of shot. `ref/shots/NN.md` says it in its `Movement:` line, measured
from the reference's frames, and `timeline.md` marks every shot that `MOVES THROUGHOUT`:

- **A text or explainer card** (`enters then holds`): every entrance finishes in the first half of the shot and then
  holds its end state (`both` keeps it). A reader needs the text still.
- **A motion-graphics shot** (`moves throughout`): it keeps moving from its first frame to its last. Before writing
  its scene, open `ref/shots/NN-frames.jpg` and read `video-motion.md`; a scene whose elements all arrive in the first
  third of a second and then stand is a still picture, not a re-make of it. Build it in three layers:
  - the **main move** (a ball that bounces, a shape that morphs, a camera that travels), lasting as long as the
    reference's does, on the measured curve (`ref/shots/NN.md`, "Motion events"; `popost video measure curve`);
  - what **follows** it (a trail, a shadow that follows the contact, a settle, a part that arrives a little later);
  - a **ground that keeps going** (a slow drift or turn, moving light, particles), which can last as long as the shot.
- **Titles land and then stay still**, in both kinds: the motion goes on in the world behind them. No title wobbles,
  floats or pulses for the length of the shot; that reads as generated at once.
- **Never every element the same way**: a shot whose parts all fade and slide up, or all pop on the same overshoot,
  reads as a template. Give each role its own entrance and its own ease (`video-motion.md`, "Ease by role").
- When speech makes the shot longer than the reference's, the main move keeps its length and the ground keeps going;
  do not stretch a bounce or a pop to fill the time.

After the render, `popost video compare` names every shot that stands still for more than 40% of its length while the
reference shot moves throughout (`stillShots`, and `worst[].problem` with the fix). That is a problem to fix before
delivery, not a difference to note in the delivery text.

## What the rest of the video adds

Captions, the voice, transitions between shots and overlays are items of the project, drawn over the scene by the
engine. A scene does not draw captions of speech and does not fade itself in from black unless the design asks for
it: the transition into the shot belongs to the segment (`"in": { "transition": "dissolve", "frames": 12 }`).

An effect that is none of the engine's transitions (describe says "(does not fit well: look at transitions/NN.jpg ...)",
or calls a very short shot "most likely part of the change into #NN") is drawn by a scene, the one of the shot the
effect ends: the shape that moves and the next shot's picture coming in behind it, frame by frame as
`ref/transitions/NN.jpg` shows them (each frame has its time), ending on the next shot's picture (an `<img>` of the
same file that shot shows). The measured transition stays at that boundary in the template; let the drawn effect be
complete by its first frame (the first orange time in the picture), so that the transition then passes from the next
shot's picture to the same picture.

## Checking a scene

### Full-project resource preflight

The current renderer creates one iframe for every scene segment, including repeated uses of the same scene file. Hidden scenes initialize their documents, fonts and images too; a scene that eagerly loads a full native frame sequence repeats that work in every instance. A bounded, active-only iframe lifecycle is not implemented. Increasing the navigation timeout or changing its load milestone does not remove this initialization work.

Before a long render, run `popost video scene check <project-dir> --shots <dir>` on the complete assembled project and keep its actual result and pictures. A small project containing one scene does not prove that the full project loads. If full initialization times out, preserve the existing native clips and receipts; an initialization failure is not a reason to purchase unchanged clips again.

- Count repeated scene instances, images and large decoded pictures. Parallel render pages multiply this load; start resource-heavy projects with one render page.
- A continuous, editable master scene can replace repeated instances when it preserves every measured event, cut, overlay, transition, source-in and audio clock. This is a composition change, not automatic renderer deduplication. It must not become a still frame used to fill time.
- Keep large geometry and tracking data in separate editable source files and, where needed, a generated local data script instead of repeating the same large JSON in every HTML document. Follow the existing sandbox and local-loading rules.
- Prefer core video items or the footage helper's required-frame extraction. If a custom scene needs frame pictures, bound them to the span it uses; do not preload every native clip's entire sequence in each document.
- Repeat the full-project load preflight after changing resource ownership or assets. A higher timeout, a successful isolated scene, or a generation receipt does not prove a correct full render.

Resource readiness and visual fidelity are separate checks. After consolidation, inspect same-time source/output pairs, transition boundaries and backward seeks; preserving loadability must not change an event's clock or remove a required action.

```bash
popost video check <project-dir>                 # the rules above, with a place and a fix
popost video scene check <project-dir> --shots <dir>   # every scene opened; three frames of each kept in <dir>
popost video frame <project-dir> --frame 45 --out f45.png
popost video render <project-dir> --out out.mp4
popost video preview <project-dir>               # frame by frame in a browser, for a person; runs until stopped
```

`scene check` opens every scene in its segment and looks at it at a quarter, a half and three quarters of the shot
(`<dir>/segment-NN-fFRAME.png`, NN the segment from 01; each warning names the picture to open). Besides a script
that fails, content outside the canvas and a marked text too large for its box, it warns, as a viewer would see the
shot, about:

- a text that becomes visible so late that it stays on screen less than half its shot and less than 1.5 s (until then
  faint, hidden, outside the canvas, behind the edge of a box that hides its overflow, or scaled below a third), with
  when it comes and how long it stays: items of a list may arrive with the voice over a long shot as long as the last
  one stays 1.5 s; and a text a shorter segment never shows while a longer one with the same scene file does;
- a middle picture that is nearly all ground and shows little text. `scenes[].fill` is the share of that picture
  that stands out from its ground (0..1); a gradient with soft blurred shapes on it counts as ground, and the box of a
  clip or picture laid over the scene (a `video` or `image` item) counts whole: `scenes[].items` says how many lie
  over it and the share of the canvas they cover;
- numbers shown in a scene or a caption (59K, $59K, 3.5%, 12,000, 2万, x3) that no text file of the project holds
  outside `scenes/` (`.md`, `.txt`, `.json`, `.csv`, `.html`), however each is written.

Save the text of every source you take a figure or a claim from into `project/source/` (a `.txt` or `.md` file
each, the request too), so that the check can find every number the video shows.
