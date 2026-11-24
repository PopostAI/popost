# Making a video

Re-creating a reference video with new content ("the same effects and motion, about my topic") with `popost video`.
Read this page once, then do steps 0 to 7 in order; "Done when" says what must be true before the next step.

## Rules for every step

- Run `mkdir -p work && cd work` once; every path below is relative to `work/`. If `popost` is not on PATH,
  write `node <skill>/dist/cli.js` instead of `popost`.
- Every command prints one JSON document. `"ok": true` means it worked. Otherwise read `error`, or `problems`:
  each has `level` (`error` stops you, `warning` does not), `at` (where), `message` and `fix`. Do what `fix`
  says and run the same command again.
- Read only the files this page names. Never open `measure.json`, `text.json`, `transcript.json`,
  `reference.measure.json`, `slots.json`, `*.words.json` or `.cache/`: they are data for the programs.
- Open pictures one at a time: each one stays in your context. Write no times and no frame numbers anywhere but in a
  capture plan (step 3): the program takes every time from the reference. Never invent numbers, quotes, names or results that the user or a
  source you fetched did not give.
- There is no time limit. Never shorten or skip a step, a scene or a review round to save time: a video takes
  half an hour to an hour of work, and that is expected.
- Do not run `preview` as a blocking foreground command. At delivery (step 7), run `preview --edit` as a background
  process to provide the editable Studio. Do not run `template test`, `template see`, `scene write`, `eval`, or `plan`
  without `--dry`: they are for people and configured models. Unclear fix: `<skill>/references/video-tools.md`, "Common failures".

## 0. What the machine has

```bash
popost video doctor
```

- `"ok": false`: ffmpeg or the browser is missing, and no video can be made. Tell the user what `missing` says; stop.
- `tools`: `null` means not set up (setting one up: `video-tools.md`; only if the user asks). What each costs:
  - `readText` null: the reference's captions are not read, so the template has no caption beats. Read the words
    off the pictures (step 1) and put them into the scenes (step 5); footage shots stay without words.
  - `transcribe` null: what the reference says is not read; only its captions make beats.
  - `speak` null: no voice-over. Leave out `--voice`, `"voice"`, `--speak`, `--keep-length`, `--fit-tempo` and
    `--pace` below; say in the delivery that the video has no voice.
  - `generate` null: no generated clips; use captured pages, the user's files and scenes.
  - `generate` set: generated clips cost money. With the built-in generator (`popost video generate`, popost.ai
    credits) and no budget set, `popost video materials` first prices the list and makes nothing (`toConfirm`): tell
    the user the total and go on only after they agree (`video-tools.md`, "The built-in generator").

Done when: `"ok": true`, and you know which tools are `null`.

## 1. Read the reference

Put the reference at `reference.mp4` (`cp` a local file, or `curl -L -o reference.mp4 <url to the file>`), then:

```bash
popost video describe reference.mp4 --out ref
```

`describe` measures shots, cuts, transitions, camera, motion, how much the picture moves, colours (captions and speech with those tools) and draws
the pictures to open, consecutive frames with the time of each under it: `ref/opening.jpg` (the first 3 s, 6 frames a
second), `ref/shots/NN-frames.jpg` (each shot from just before the change into it to its end, up to 12 frames) and
`ref/transitions/NN.jpg` (each change that is not a plain cut, frame by frame from 0.2 s before to 0.2 s after, named
by the shot it leads into). A time on an orange band is a frame inside a measured transition. With a text reader and a
transcriber `describe` can take a few minutes; every 15 s it writes a line on stderr saying which part is where
(`describe, 45 s: measure: done in 12 s; text: the reader is reading 150 frames (40 s); ...`). Give it up to five
minutes if your shell limits how long a command runs.

Read `ref/REFERENCE.md` (length, size, shots, what could not be read) and `ref/timeline.md` (the beats: the lines
said or shown, numbered from 0; one line per shot). A line `Frame:` in REFERENCE.md means the shots show their content
inside one constant frame (a ground, a border): it gives the box of the content and what to build; `Black bars:` means
a picture of other proportions with bars around it; when it says the captions or a title sit on the black, every shot
keeps the picture in that box, or the captions end up over it.

Then, before you write any plan, open every picture: `ref/opening.jpg`, then for each shot NN `ref/shots/NN-frames.jpg`
with `ref/shots/NN.md` (colours, texts and where they sit, motion events), and every `ref/transitions/NN.jpg`. The labels
in the text files ("dissolve 13f", "slide cover right 50f", "Most likely: ...", "footage with 16 lines of its own text")
are measurements, and measurements can be wrong: when the frames show something else, what the frames show wins.

- A transition that reads "(does not fit well: look at transitions/NN.jpg; it may be an effect of its own)" is one
  the measured kind does not explain. Go through its frames in order and say what moves: an object that flies across
  and pulls the next picture in behind it, pages that fan out in depth, a reveal along a curve, elements that come in
  one after another.
- A shot "most likely part of the change into #NN" (very short, on a flat ground, something moving) belongs to that
  transition: one effect across the boundary, not a designed picture of its own.
- An effect that is not one of the standard transitions (cut, fade, flash, dissolve, wipe, slide, zoom, spin, blur,
  glitch, shake, whip) is re-made as a scene that draws it, frame by frame as the pictures show it, and not as the
  nearest standard transition.

"Most likely: ..." names the kind of shot the measured facts point to, with the facts (a recording of a page or an app,
a designed picture, filmed or photographic material): a hint that the frames confirm or correct, absent when the facts
do not say. The line "The camera ends on [x, y, width, height]" gives the part of the frame a clear zoom or pan goes to
(fractions of the canvas; a pull-out "starts on" one): aim your capture plan's zoom or your scene's camera at the same
part of your picture. To see a moment closer, `popost video look reference.mp4 --at 3.6,3.9,4.2 --out ref/look-in`
(seconds of the video; the pictures give them) writes those frames full size: open `ref/look-in/at-01.jpg` and the next ones.

The line `Motion amount:` of a shot says how much its picture changes between frames 1/15 s apart (0 is a still
picture; REFERENCE.md has the video's). It is a measurement, and it does not say why the picture moves (the camera,
the people, footage played fast). The shots of the re-make are held to it: `compare` gives both amounts for every shot.

Write `ref/elements.json` from what you saw, one entry per shot: its layout in generic words (a full-frame screen
recording, a window on a designed ground, a title card, a person to camera), its layers (each with its box, a look
precise enough to redraw it, what it shows and its role: `design` keeps its look, `content` gets the new subject,
`platform` and `creator` are never re-made), the change into it (`custom`, described frame by frame, when it is no
standard transition), the captions' style and the words drawn differently, and every mark with what it marks and why.
The schema, the roles and an example: `<skill>/references/video-elements.md`; `popost video elements questions ref`
prints them with this video's shots and the pictures in order. Then:

If `timeline.md` calls page headings captions, or misses the visible subtitle lines, include `captions.lines` in
the affected shots (the actual lines seen in the pictures, `[]` for none). The caption layer's box identifies the
band; the program matches the confirmed words to OCR times when saving the template. Answer unmatched-line warnings
before proceeding; no timing is guessed for a line OCR did not read.

```bash
popost video elements check ref
```

It holds the file to the measurement: a shot without an entry, a box outside the frame, a custom change without a
description, a watermark no `platform` layer covers, a mark without its reason, an end card of the platform that is not
dropped. Correct every error and answer every warning (each says what it found and what to write) until it prints
`"ok": true`.

Done when: you have opened every picture of `ref/`, and `popost video elements check ref` prints `"ok": true`: every
shot has an entry that says its layout, how it begins and ends as its frames show it, and which layers are the
platform's or the author's.

## 2. Keep its structure

```bash
popost video template save ref --out template --name ref
popost video template show template
```

From `template show` read `canvas` and `card`. `shots[k]` is one entry per shot, in order: each keeps its length,
its cut or transition and its place; you choose what fills it. `captions[i]` is the new line of beat i (the card shows the reference's line and its length).
Each is a slot, a place for new content with a limit ("A caption line holds at most N full-width or M Latin
characters"). `slots.captions.box` is the caption band, `[x, y, width, height]` as fractions of the canvas.

If `beats` is 0 but the reference shows words (no text reader), there is no caption band: the words of each shot
go into its scene (step 5). More: `<skill>/references/video-templates.md`.

`template save` reads `ref/elements.json`: TEMPLATE.md names each shot's layout, the layers to keep, the places for the
new subject and the layers dropped (`template show` prints all of it as `shotElements`, with every box and look). A
change in that is an effect of its own stays `custom`, never a preset: the engine cuts there and a scene of yours
draws it (step 5). A last shot the reading dropped (the platform's end card) is left out, and the template's last
shot is your own closing. After correcting `elements.json`, save the template again.

Done when: you know the canvas size, the number of shots and beats, and the caption limit.

## 3. Collect the new content

The user's topic decides what the video shows. Read the sources the request gives (`curl -sL <url>`) and use only
what they say. When a source exists in several languages (a page with a language switch, a README in two languages),
collect the one in the language of the video, so that what is shown and what is said match. Copy the user's pictures and clips into `project/assets/` (`mkdir -p project/assets project/scenes`).

Every shot keeps its layout kind (TEMPLATE.md, `layout`): a full-frame recording stays a full-frame recording, a window
on a designed ground stays one, a person to camera stays one. When the new subject has no material of the same kind
for a shot, find its closest real material for that layout (another page, another recording, another photo), never
another layout: `template check` and `video check` warn when a shot read as full-frame footage is built as a designed
scene with small pictures, and the other way round; they also warn when the main picture of a shot (the reading's box) is rebuilt with no picture at all, or much smaller, larger or elsewhere (a full-frame recording drawn as a slide, a large window as a small one).

A web page becomes one of two things. (a) A directed recording (footage), when the page must be seen working:
scrolling, a click, typing. As in the reference, it shows one part of the page large enough to read, a box drawn
round what the voice names, a pointer that moves to it and clicks; a whole page scrolling by is too small to read.
(b) A still in a scene, when the shot is a designed picture with the page inside it (a framed window on a ground, a
zoom onto one number with a box drawn round it, screens side by side): do 1 to 3 below, then
`popost video capture <url> --size 1280x720 --hide '...' --still project/assets/page-01.png` (`--at <selector>` places
the window, `--full-page` takes all of the page) and write the scene with the screen helper, its steps addressed by
the `box` of each element from `--outline` (`<skill>/references/video-scenes.md`, "A screen inside a scene"). For
(a), make one recording per footage shot (one for shots that show the same place):

1. From the reference shot (its frames, its entry in `ref/elements.json`) decide what the shot shows: which part of the page, how
   large, what is pointed at or clicked. Draft the line the voice says there (step 4 uses it). Note both under the shot.
2. Outline the page at the canvas size (step 2): `popost video capture https://example.com/pricing --size 1280x720 --outline`.
   It prints `text.medianPx` (how tall the text is in the video), `sections` (headings, `y` px from the top),
   `targets` (buttons, fields, cards, code, pictures, large numbers, links) and `overlays` (what is fixed over the
   window), each with a `selector`. If `medianPx` is under 2% of the height (14 at 720), add `--zoom 1.5` to
   every `capture` of this page and outline again.
3. Hide every overlay except the one of kind `header` (cookie banners, language pop-ups, chat buttons) with
   `--hide 'div.cookie-banner,div.lang-switch'`, their selectors as `--outline` printed them.
4. Write the plan, `capture-01.json`: scroll to the section, zoom to the element the line is about, highlight what
   the line names, point and click when the reference does, hold. A shot whose reading says its page scrolls, zooms, changes page or has a pointer that moves needs this directed recording (or the screen helper's steps in a scene), never a still with a slow drift: the checks warn. Copy each selector from `--outline` exactly. 30
   frames are a second; make the plan 1.5 times as long as the shot, so that a longer voice does not run out of
   footage. All steps: `<skill>/references/video-tools.md`, "Capture plans". This one lasts 9.5 s:

   ```json
   [{ "hold": 15 }, { "scroll": { "to": "#pricing", "frames": 40 } },
    { "zoom": { "to": "div.plan-pro", "frames": 25, "fill": 0.7 } }, { "highlight": { "to": "div.plan-pro .price", "frames": 12 } },
    { "hold": 45 }, { "point": { "to": "button.buy-pro", "frames": 18 } }, { "click": "button.buy-pro" }, { "hold": 120 }]
   ```

5. Record: `popost video capture https://example.com/pricing --size 1280x720 --hide 'div.cookie-banner' --caption-band <y of slots.captions.box> --plan capture-01.json --out project/assets/page-01.mp4`.
   `--caption-band` is the top of the caption band, which covers the lowest part of the picture: the second number of
   `slots.captions.box` from `template show` (step 2), such as 0.82. A zoom then ends with its element above the band,
   and a note says when it cannot or when a highlight lies under the band. Leave it out only for a video without
   captions (`template show` has no `slots.captions`). Each of its `notes` says what was wrong and what to do (hide
   an element that still covers the window, zoom to a smaller element, scroll first). Correct the plan or the options
   and record again. Frame the page so that what the line names sits above the band, and large text of the page does
   not lie under the captions.
6. Look at two frames of it, when the zoom has ended and near the end (seconds; this plan has zoomed by 2.7 s):
   `popost video look project/assets/page-01.mp4 --at 3,8 --out look/page-01`, then open `look/page-01/at-01.jpg`
   and `at-02.jpg`. Use the recording only when the text the line is about is readable, the element is large near
   the middle and nothing covers it. Otherwise zoom closer or hide what covers it, and record again.

A shot of filmed material that no file of the user's shows can be generated when `generate` is set (step 0): write
the requests and run `popost video materials requests.json --out project` (`video-tools.md`, "Generated clips": the
request, the price, what it prints). Two rules about motion:

- The words about speed in a prompt follow the shot's measured `Motion amount` and its frames, not habit. Write the
  action and its pace as the shot has them ("walks briskly", "quick hand movements"), and write "slowly" or "gently"
  only for a shot that measures low. As a rough guide: clips generated from prompts that said "slowly" measured 2 to
  4, handheld footage of people 5 to 10, fast or sped-up footage above 12. `materials` prints each clip's
  `motionAmount`: hold it against the shot's before you use the clip.
- A clip is never slowed down to fill a shot (the checks warn about a `"speed"` under 0.9): ask for a clip as long as
  the shot needs (`footage.seconds` in `template show`), make a second clip, or start earlier. A clip that moves less
  than its shot may be sped up with a `"speed"` above 1 when it is long enough.
- The clips of one video keep the same person, product and place through one anchor picture, which `materials`
  takes care of by itself. When the request names a character of the user's popost.ai library, pass it with
  `--character <id>`; when it gives a photo of the person or the product, with `--anchor-image <file>`. A clip that
  shares nothing with the others says `"anchor": false` (`video-tools.md`).

Then write `project/materials.json`, one entry per file, saying what it shows:
`{ "assets/page-01.mp4": "the pricing page: zooms to the Pro plan, boxes its price, the pointer clicks Buy" }`.

Done when: every footage or picture shot you plan has its file in `project/assets/`, listed in `materials.json`, and
you have looked at two frames of every recording.

## 4. Write the lines and the fill

Write the request in your own words into `brief.txt`: the topic, the audience, the language, what must be said.

```bash
popost video plan template --brief brief.txt --assets project --dry --voice <voice> --fit-tempo 1.12
```

`<voice>`: a name the speaker understands (`video-tools.md`); `plan` speaks a sentence to time it. It prints `answer`
(how many shots and captions, and the voice to name), `budgets` (`pace`: the voice's characters a second; per line,
the most characters that can be said in its beat, the voice sped up at most 1.12 times), `rules`, `forms` and
`materials`; `messages` repeats them. Write `fill.json`:

```json
{ "shots": [{ "scene": "scenes/shot-01.html", "slots": { "title": "Why fast pages win" } },
            { "footage": "assets/page-01.mp4", "in": 0 },
            { "scene": "scenes/shot-03.html" }],
  "captions": ["Three habits of fast websites", "Habit one: measure before you fix", "Follow for habit two"],
  "voice": "<voice>" }
```

- `shots`: exactly one entry per shot, in the template's order. A designed picture is a `scene` (written in step 5;
  every shot takes one). `footage` and `picture` name files of `materials`; `"in"` is the clip's first frame to
  show (0 when unsure). Also possible: `{"color": "#101014"}`, `{"card": {"title": "...", "lines": ["..."]}}`.
  A file whose proportions differ from the canvas is cropped to fill the shot (`"fit": "cover"`, the default);
  `"fit": "contain"` shows it whole on a `"ground"` colour; `template fill` warns when cover would cut more than a tenth.
- Every shot shows what its line says. When no file you have shows it, make the shot a `scene` (a still of the
  product with a label or a box on the thing named, the steps as a row of words with arrows, a number set large);
  never fill a shot with material about something else, and never leave a clip of other proportions alone on an
  empty ground: show it inside a designed shot, a scene with the clip in a box over it, written as the shot's
  `"items"` in fill.json (`video-scenes.md`, "A screen inside a scene", the part "Footage inside a scene"); fill keeps
  them through every later fill and re-flow.
- Words the reference laid over a shot (TEMPLATE.md: `words "..."` on the shot) are `"words": ["..."]` on that shot,
  a line per place in order, drawn where the reference's were; re-make them with the new video's words. A bar of
  words through the video (the sections, the current one marked) is design text, not a watermark: give it the new
  video's sections with `"bar": [...]`, or draw it in each scene.
- `captions`: exactly one line per beat, in order, in the language of the brief, together one short script about
  the topic. Keep each line within its budget, or near the length of the reference's line: a longer line makes the
  video longer. `""` leaves a beat empty; with 0 beats, leave `captions` out. Every line says something whole: when a
  budget is short, move words to the neighbouring beat or split one sentence over two beats; never cut a line to a
  fragment (`template check` warns when a line is far shorter than the reference's text of its beat). When the reading says some caption words are drawn differently, mark the words your line stresses, `*like this*`, as the reference does; `template check` and `video check` warn when no line marks one. Take the
  reference's way of speaking, never its promises: a call to action the new video's owner cannot keep ("comment X
  and I send you …", a giveaway, a link or account that does not exist) becomes one they can (follow, visit the real
  address from the sources), and a figure the reference gave about itself is never said about the new subject.
- Each beat keeps its job (a hook, a proof, a demo, a call to action), and its content is the new subject's strongest
  material for that job, from the request first and the sources second. A kind of fact that is weak or absent for the
  new subject (a count, a ranking, a price) is not copied in a weaker form: say what the request stresses instead.
  The shot's mark (a box, a circle, a zoom, a pointer: `emphasis` in `ref/elements.json`) keeps its kind and look and
  goes on what the new line says, that strongest point, never on the new subject's version of the reference's fact.
- `voice`: the same `<voice>`, as `answer` and `rules` say: `template fill --speak` reads it from the fill. No times, no
  frame numbers except `in`, no other keys.
- A reference without speech (REFERENCE.md: `Speech: none recognised`) is re-made without a voice-over, unless the
  request asks for one: leave out `--voice`, `"voice"`, `--speak`, `--keep-length`, `--fit-tempo` and `--pace` here
  and in step 6; its caption lines are still drawn.
- Sound: a video without a voice keeps the sound its clips came with (a generated clip has sound), each at its own
  level; with a voice or a `"sound"` file the clips are silent unless a shot says `"audio"` (`video-templates.md`).
  Never make up music or a tone to fill silence, and never mute a clip to be safe: `"sound"` is for a file the user
  gave. A quiet video is not a fault to repair; the user can add sound in an editor.

```bash
popost video template check template --fill fill.json --pace <budgets.pace> --fit-tempo 1.12
```

Done when: `"ok": true` (its note that the files were not looked at is expected: `template fill` does it in step 5).

## 5. Write the scenes

This step decides most of the result: the reference's look and motion live in its designed shots. Write one HTML file
in `project/scenes/` for every `scene` of fill.json, drawing the whole shot with the reference shot's layout, colours,
type and motion (its entry in `ref/elements.json`, its frames) and the new content. Shots of one design (three numbered steps) can share
a file with different `slots`. The rules (the whole contract: `<skill>/references/video-scenes.md`):

1. A whole HTML page; `html, body` exactly the canvas size (step 2), `margin: 0`, `overflow: hidden`. Inline `<style>`
   and SVG; pictures by a path relative to the scene file (`../assets/logo.png`); nothing from the network.
2. Motion: CSS `@keyframes` with `animation: <name> <duration> <delay> both`, written as if the shot started at
   0 s; the engine sets every animation to the frame's time. A counter or a typed text:
   `window.__popostScene = { render(seconds) { ... } }`, which sets everything it changes from `seconds` alone.
   Motion in sequence (a list that staggers in, several elements one after another): a GSAP timeline, after
   `popost video scene library project`; read "A timeline library" in `video-scenes.md` first.
3. Never: `setTimeout`, `setInterval`, `requestAnimationFrame`, `Date.now()`, `performance.now()`,
   `Math.random()`, CSS `transition`, `<video>`, `<audio>`, `<iframe>`, `fetch`.
4. The shot's length changes (with a voice, a beat takes the length of its spoken line). Finish every entrance in the
   first half of the reference shot and hold the end state (`both` does it); never animate an exit, the cut does
   that. A move through the whole shot (a slow drift, a growing bar) may last the reference shot, then holds.
5. Put `data-slot="name"` on each element that holds only a text (or an `<img>`) of the topic: the check warns when
   the glyphs of a marked text leave its box, or when a box around it with `overflow: hidden` cuts them off. A fill's `"slots": {"name": "new words"}` replaces its text (an `<img>`'s
   `src`, as a path relative to the scene file: `"../assets/new.png"`).
6. Keep the caption band (`slots.captions.box`) free of the scene's own text; never draw the captions yourself.
7. Fonts of the machine (`fc-list : family` lists them): `font-family: "Noto Sans CJK SC", "Noto Sans", sans-serif`.
   The check measures the glyphs: a `line-height` of 1.2 holds Chinese text, Latin letters that reach below the line
   (g, p, y) need 1.4 or room below.

Start from this example (1280x720: a card slides in, a label fades up, a number counts up); change its sizes,
layout, colours, words and motion to the reference shot's:

```html
<!doctype html>
<html><head><meta charset="utf-8">
<style>
  html, body { margin: 0; width: 1280px; height: 720px; overflow: hidden; background: #1d2b53;
               font-family: "Noto Sans CJK SC", "Noto Sans", sans-serif; }
  .card { position: absolute; left: 380px; top: 140px; width: 520px; padding: 32px 36px; box-sizing: border-box;
          background: #ffffff; border-radius: 12px; animation: slide-in 0.6s cubic-bezier(.2,.8,.2,1) 0s both; }
  .label { font-size: 22px; font-weight: 700; line-height: 1.4; color: #e76f51; animation: fade-up 0.4s ease-out 0.5s both; }
  .title { font-size: 44px; font-weight: 800; line-height: 1.4; color: #1d2b53; }
  .count { position: absolute; left: 380px; top: 380px; font-size: 64px; font-weight: 800; line-height: 1.4;
           color: #ffffff; animation: fade-up 0.4s ease-out 0.8s both; }
  @keyframes slide-in { from { transform: translateX(-900px); } to { transform: none; } }
  @keyframes fade-up { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: none; } }
</style></head>
<body>
  <div class="card">
    <div class="label" data-slot="label">WEB PERFORMANCE</div>
    <div class="title" data-slot="title">Why fast pages win</div>
  </div>
  <div class="count" id="count"></div>
  <span data-slot="value" hidden>53%</span>
  <script>
    // Counts from 0 to the number in the slot "value" between 0.8 s and 2.0 s, then holds.
    window.__popostScene = { render: function (seconds) {
      var value = document.querySelector('[data-slot="value"]').textContent;
      var p = Math.min(1, Math.max(0, (seconds - 0.8) / 1.2));
      document.getElementById('count').textContent = value.replace(/\d+/, function (n) { return String(Math.round(n * p)); });
    } };
  </script>
</body></html>
```

Save the text of every source you take a figure or a claim from into `project/source/` (a `.txt` or `.md` file
each, the request too), so that `scene check` can find every number a scene or a caption shows.

A shot whose change in is `custom` (TEMPLATE.md: `custom in, drawn by ...`) is drawn by one scene that holds both
pictures and the moving object, frame by frame as `ref/transitions/NN.jpg` shows it. "Drawn by the scene of the shot
before": that scene ends with the effect, and `template fill` moves the cut to the effect's end, so the scene runs on
over the first frames of the next shot and must show that shot's beginning as the effect reveals it. "Drawn by this
shot's scene": the cut moves to the effect's start, and the scene begins with the effect over the end of the shot
before. Never replace the effect by a preset, and never patch `video.json` with a script after `template fill`: the
template holds it. Layers the reading gave the role `platform` or `creator` (a watermark, an account, the platform's
end card, the author's face or name) are never drawn.

When every scene file exists, build the project and check the scenes:

```bash
popost video template fill template --fill fill.json --out project
popost video scene check project --shots project/scene-shots
```

`template fill` writes `project/video.json` and leaves your files alone. `scene check` opens every scene and keeps
three frames of each, `project/scene-shots/segment-NN-fFRAME.png` (NN: the shot). Correct every error and warning
about a scene; run `scene check` again (`template fill` again only when fill.json changed). Then open the middle frame
of each scene beside `ref/shots/NN-frames.jpg`: the same kind of picture, elements in the same places, as dense, the
same colours, every text legible and inside its box (the check does not see text that runs out of a box around it
that does not hide its overflow). Correct the scene where they differ.

Done when: `scene check` prints `"ok": true` with no warning about a scene, and each scene looks like its shot.

## 6. Build with the voice, and check

```bash
popost video template fill template --fill fill.json --out project --speak --keep-length --fit-tempo 1.12 --pace <budgets.pace>
popost video check project --layout
popost video scene check project
popost video template check template --fill fill.json --assets project --pace <budgets.pace> --fit-tempo 1.12
```

`--speak` speaks every caption line into `project/assets/voice.m4a` (every time it runs; it takes minutes) and
re-flows each beat to its spoken line; `--keep-length` keeps each beat at least as long as in the reference, so the
cuts keep its rhythm; `--fit-tempo 1.12` speeds a line that would run over its beat up as far as it needs, at most
12% (hardly heard; the pitch stays), and only the rest makes the beat longer. Its `notes` say which lines were sped
up and give the new length. When the reading says the words appear one by one, add `"captionReveal": "words"` to the fill (`template check` warns when it is missing). From now on run `template fill` only with these options, or the voice is dropped.
Without a speaker, or for a video without a voice (step 4), leave out `--speak --keep-length --fit-tempo 1.12 --pace <budgets.pace>`. The last command
looks at the files of the fill and at `project/video.json`: run it again after every hand edit of `video.json`; it
warns when the captions are much smaller or larger than the reference's, with both sizes in pixels (`video check` does
too). `scene check` also warns when a scene is far emptier than its reference shot (draw what the shot holds, as
densely) and when a scene or a caption shows the reference's own words or figures (say what your sources say instead).

Done when: all four print `"ok": true`, with no warning about the size of the captions.

## 7. Render, compare, deliver

```bash
popost video render project --out final.mp4
popost video compare reference.mp4 final.mp4
```

`compare` scores the whole video per dimension from 0 to 1 (1 is the same), then prints `shots` (each shot of the
reference against the matching part of yours), `motionAmount` (how much the picture moves in both videos; `less` and
`more` list the shots that move less than half or more than twice as much as the reference's, and its `note` says what
to do: fix them like a shot of `worst`) and `worst`: the shots that differ most, each with `by` (the dimension
that makes it so: `picture`, `colour`, `motion`, `text` or `transition`), its seconds in both videos and a `look` command. With a
text reader, run `popost video text final.mp4 --out final.text.json` first and add
`--reference-text ref/text.json --other-text final.text.json`: the shots are then compared on their text too. A round:

1. Run `compare`. For each entry of `worst`, run its `look` command and open the picture it writes
   (`review/shot-NN/at-01.jpg`, full size): A is yours, B the reference. Name what differs: layout, a size, a colour,
   how dense, when something moves.
   An entry with `by: "transition"` is the change into that shot (every change that is not a cut in the reference is
   scored on the curve of how much of the picture changes across it, its kind and how plain it is); its `look` shows 6 moments across the change. Fix it in the scene that draws it
   (`custom`, video-elements.md) or with the preset whose line in video-elements.md matches the reference's frames; open
   its look picture first.
2. Fix it: a scene (edit its HTML, run `popost video scene check project`), or the fill (edit fill.json, run step 6 again).
3. Render again; its `next` names the compare to run.

A round is finished when every shot of `worst` is fixed or written into the delivery notes with the reason it stays (a
source that does not have it, a missing tool or material). `compare` counts the rounds: `round` is how many states of
the project have been compared, this one included (rendering again without a change is the same state), and `next`
says what the round asks. At least two rounds means: deliver only a render whose compare printed `"round": 2` or
more; after a fix, render and compare again; at most four. `stillWorst` names the shots that stayed among the worst
with a similar score since an earlier round: fix them or write down why they stay. When `render` prints a `warning`,
the render before it was never compared: compare before changing more. To see the effects as the reference shows
them, `popost video look final.mp4 --shots-like ref --out review/frames` draws the pictures of `ref/` again from your
render, at the same share of its length and under the same names: open `review/frames/transitions/NN.jpg` beside
`ref/transitions/NN.jpg` for every effect, and `review/frames/shots/NN-frames.jpg` beside `ref/shots/NN-frames.jpg`.
An overview (`popost video look final.mp4 --against reference.mp4 --out review`, one sheet per shot) is fine too; neither
replaces opening the single shots of `worst`. With a text reader, `popost video readback project final.mp4` says whether every
caption is legible (and heard, with a transcriber), and warns for each shot whose text stays on screen smaller than
1.8% of the height (`textSizes`: the smallest and median per shot): zoom in, take the still at `--scale 2`, or show
fewer words. It also warns for each shot whose captions do not stand out from what is behind them
(`captionContrast`: white letters on a light page, dark ones over the page's own text): put them on a plate,
outline them, change their colour, or move the band to a calm part of the frame. It reads every caption and every
shot twice, at most two frames a second, and its first line says how long that takes (a second line when the frames
hold much more text than captions). It keeps the transcript beside the project, so a readback after a fix that left
the sound alone does not listen again.

Open the editable Studio with the existing preview editor:

```bash
popost video preview project --edit --reference reference.mp4
```

Start this with the host's background-process tool and keep the service alive after delivery. Wait for its real JSON
output and use its `url`; do not guess a port. Fetch `api/state` under that URL and confirm it has `source` and
`edit`, then open the URL with the host's browser or side-panel tool. Check that the timeline and project load, a
text edit saves, undo restores it, a reload keeps the saved state, and the editor can render. Use the same project
that produced the delivered video. The URL is a local editor on this computer while that service runs.

When a template deliberately drops trailing platform shots, `compare` reports the retained reference interval and `omittedShots` after checking its sampled visual fingerprint. An unrelated reference or an older project without that provenance is compared in full; do not read the omitted endcard as a failure of the new closing.

Deliver `final.mp4`, its editable Studio URL, the `project/` directory and the delivery notes: what is as in the
reference, what differs and why (no voice, a missing tool, a source that did not have something), and each shot of
the last `worst` that was not fixed, with its reason. Say the Studio is open only after it has actually loaded.
