# Making a video

Re-creating a reference video with new content ("the same effects and motion, about my topic") with `popost video`.
Read this page once, then do steps 0 to 7 in order; "Done when" says what must be true before the next step.

For every new reference replication, also read [strict replication](video-replication.md). Its internal source
contract, complete event inventory, target map, audio/pair checks and artifact-bound review are required throughout
the steps below. The user need not supply a detailed motion prompt. Existing projects without a replication sidecar
keep their previous behavior; an approved repair uses a separate project and does not rewrite unrelated work.

## Rules for every step

- For Jianying Pro or CapCut delivery, use [direct desktop draft export](video-draft-export.md). Local Studio saves into the application's drafts folder and offers Open/Restart after success; a ZIP download is not this interaction.

- For any generated people or audible dialogue, read [people and shared voices](video-performers.md). Follow explicit user character requirements/material first; otherwise match the role and mood with a new face. Keeping a presenter, avatar window or layout does not select the original person's identity. One generated clip may define its new person in the prompt; multiple generated clips reuse one new identity image. Visible mouths and the final audio share one timing source; a mixed video uses one registered voice profile for its speaker and voice-over. A person who speaks on camera in the reference speaks on camera in the re-make, in a generated clip that says the lines; never silent footage with a voice-over on top.

- Money: one budget for the whole video. What costs credits is popost.ai voice-over, transcription, generated clips
  and pictures (each call at least 1 credit). Step 0 agrees the transcription, at its exact quote; step 1 ends with
  one cost overview and one total budget the user agrees to, once the reference has been read. Every paid call is booked under the project's task, and `popost usage --dir project --budget <agreed>` prints
  what popost.ai counts as spent so far (refunds included, also clips paid by a run that stopped) and `budget.left`,
  what is left. Before each paid command (`transcript`, `describe`, `plan --voice`, `template fill --speak`,
  `retarget --speak`, `readback`, `voice speak`, `materials`), run it and pass `--confirm --max-credits <left>`. The
  `chargedCredits` each command prints is a quick check, not the count. A command that ends with exit code 3 and
  `confirm` made and charged nothing: ask the user again only when its credits are more than what is left or the scope
  changed (more or longer shots, another voice); otherwise run it again within what is left. `INSUFFICIENT_CREDITS`:
  the balance is short; `popost account` shows it and where to add credits. Tell the user once that the video's
  charges show as one line, "Task: <the title step 0 gave it>", with its items, on their popost.ai account page.
- Generated video is the expensive item. Never regenerate a clip to fix its quality, make a variant, change a clip's
  request (prompt, length, references, model, resolution) or add a clip without showing the user the clip, the reason
  and the price, and getting a yes. `materials` and `generate` stop such a clip on their own, whatever the budget:
  exit code 3 with `"reason": "unplanned"` and `confirm.clip` (its key, file, what it shows); only after the yes run
  the same command again with `--approve-unplanned <confirm.clip.key>`. Running an agreed clip again is not new: it
  downloads the clip already paid for.
- Run `mkdir -p work && cd work` once; every path below is relative to `work/`. If `popost` is not on PATH,
  write `node <skill>/dist/cli.js` instead of `popost`.
- Every command prints one JSON document. `"ok": true` means it worked. Otherwise read `error`, or `problems`:
  each has `level` (`error` stops you, `warning` does not), `at` (where), `message` and `fix`. Do what `fix`
  says and run the same command again.
- Read only the files this page names. Never open `measure.json`, `text.json`, `transcript.json`,
  `reference.measure.json`, `slots.json`, `*.words.json` or `.cache/`: they are data for the programs.
- Open pictures one at a time: each one stays in your context. The measured reference clock, the source contract,
  capture plan and final compiled target map own their respective times. Keep reference, target and footage FPS
  explicit; never guess cumulative scene offsets. Never invent numbers, quotes, names or results that the user or a
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
- `tools`: `"popost.ai"` is the connected account (`hosted` says what it does), an environment variable name is a
  tool of the user's own (it goes first), `null` means not set up. What each costs:
  - `readText` null: the reference's captions are not read, so the template has no caption beats. Read the words
    off the pictures (step 1) and put them into the scenes (step 5); footage shots stay without words.
  - `transcribe` `"popost.ai"`: what the reference says is transcribed on popost.ai, paid in credits (in the cost
    overview below). `null`, with `connect`: no account is connected and there is no transcriber of the user's own,
    so what the reference says is not read; only its captions make beats. Tell the user once that connecting an
    account (`popost auth login`, recommended) adds transcription and voice-over; a tool of their own in
    `POPOST_ASR_CMD` is the other way (`video-tools.md`).
  - `speak` `"popost.ai"`: voice-over with `popost:` voices (`popost:default-male`, `popost:default-female`,
    `popost:VOICE_ID`; `video-performers.md`), paid in credits. `null`: no voice-over. Leave out `--voice`, `"voice"`,
    `--speak`, `--keep-length`, `--fit-tempo` and `--pace` below; say in the delivery that the video has no voice.
  - `music` `null` (the default): no music is generated. The video's sound is its voice-over, a sound file the user
    gave, or the sound its clips came with; users usually pick the music themselves when they post. `"popost.ai"`:
    the user switched generated music on; only then read `video-tools.md`, "Generated music", and do what it says in
    steps 0 and 6.
  - `generate` null: no generated clips; use captured pages, the user's files and scenes.
  - `generate` set: generated clips cost money; with the built-in generator (`popost video generate`) popost.ai
    credits (`video-tools.md`, "The built-in generator").

Then, before step 1:

```bash
popost usage --dir project --title "<a few words naming this video for the user: the product and the platform>"
popost account                                         # the balance
popost video transcript reference.mp4 --quote          # transcription of the reference: its exact price, free
```

The first line names the video's line on the account page, in the user's language (for example "Coffee grinder
for TikTok"); run it once, before the first paid command (it is free and creates `project/`). The transcription is
the one paid item before the reference is read: tell the user its price and the balance and get a yes to it. Quote
nothing else yet, and propose no voice-over: whether the video has one, and whether its people speak, is decided by
what the reference says and who says it (step 1). The whole cost overview and the one budget come at the end of
step 1.

Done when: `"ok": true`, you know which tools are `null`, and the user agreed to the transcription (or said no to it).

## 1. Read the reference

Put the reference at `reference.mp4` (`cp` a local file, or `curl -L -o reference.mp4 <url to the file>`), then:

```bash
popost video describe reference.mp4 --out ref --project project --confirm --max-credits <left>
```

With `transcribe` `"popost.ai"` this pays for the transcription the user agreed to in step 0 (`<left>` is here the
quote's `credits`; `--project project`: under the video's task, though the project has no files yet); when the user
said no to it, write `--no-speech` instead of `--confirm --max-credits`. A transcription that fails does not stop
the reading (`leftOut` says so): run the same command again, which starts a new one. `describe` measures shots, cuts, transitions, camera, motion, how much the picture moves, colours (captions and speech with those tools) and draws
the pictures to open, consecutive frames with the time of each under it: `ref/opening.jpg` (the first 3 s, 6 frames a
second), `ref/shots/NN-frames.jpg` (each shot from just before the change into it to its end, up to 12 frames) and
`ref/transitions/NN.jpg` (each change that is not a plain cut, frame by frame from 0.2 s before to 0.2 s after, named
by the shot it leads into). A time on an orange band is a frame inside a measured transition. With a text reader and a
transcriber `describe` can take a few minutes; every 15 s it writes a line on stderr saying which part is where
(`describe, 45 s: measure: done in 12 s; text: the reader is reading 150 frames (40 s); ...`). Give it up to five
minutes if your shell limits how long a command runs.

Read `ref/REFERENCE.md` (length, size, shots, and under "Not recovered" what the reading could not tell: each entry
says what, where, why and how to settle it) and `ref/timeline.md` (the beats: the lines
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

A section `Paths` in a shot's file gives what was followed across the screen. For a change that an object leads, or
whose edge is not straight: the object's start and end (its centre, fractions of the canvas), its path angle (0 is to
the right, 90 down, -90 up), its speed, its size, the frames it takes, and the shape of the edge that opens the new
picture (straight with where it travels, a wedge with its opening, a circle with its centre). For an element that
travels while it enters or leaves: the same way and size. These are measured: set a scene from these numbers, not from
an impression of the frames (`ref/tracks.json` has the sampled positions, for a path that bends). A change that moves or
mixes its pictures (a push, a dissolve) has no path, and neither has what moves over a picture that does not hold still.

Write `ref/elements.json` from what you saw, one entry per shot: its layout in generic words (a full-frame screen
recording, a window on a designed ground, a title card, a person to camera), its layers (each with its box, a look
precise enough to redraw it, what it shows and its role: `design` keeps its look, `content` gets the new subject,
`platform` and `creator` are never re-made), the change into it (`custom`, described frame by frame, when it is no
standard transition), the captions' style and the words drawn differently, and every mark with what it marks and why.
What stays open after you looked (an entry of "Not recovered" you could not settle, anything you could not see: too
small, too fast, covered) goes into `"unrecovered"` beside `"shots"`: `{"what", "where": {"shot": N}, "why", "assumed":
what the re-make does instead}`. Label what you write with `status`: `measured` for a value copied from the reading (its lines end in a tag such as
`[measured 0.76]`, `[inferred: ...]`, `[unknown: ...]`), `inferred` for what you saw in the frames, `unknown` for what
you could not tell.
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
dropped, a measured value contradicted without a note. Correct every error and answer every warning (each says what it found and what to write) until it prints
`"ok": true`.

The kind of the speech. REFERENCE.md has a line `Speech kind:` (or says why nothing was transcribed); the kind decides
what the re-make does with a voice:

| Kind | What it is | The re-make |
|---|---|---|
| `narration` | heard while nobody on screen says it | a voice-over (steps 4 and 6) |
| `on-camera` | a visible person says it: a talking head, an interview, a presenter in a window | the person of a generated clip says the lines (step 3); no voice-over reads them |
| `sung` | the lyrics of the music | no voice |
| `fragments` | a few exclamations or single words, no script | no voice |
| `none` | nothing is said | no voice |
| `unknown` | not transcribed (skipped, failed, no transcriber) | treated as no narration: no voice; say so in the delivery notes |

The program decides `none`, `unknown` and `fragments` (words heard for less than 15% of the length, in phrases of 4
syllables or fewer on average). Whether heard words are narration, said on camera or sung it cannot hear:
`Speech kind: unconfirmed` means you decide it from the frames.

```bash
popost video speech-kind show ref
popost video speech-kind confirm ref --narration <phrases> --on-camera <phrases>
```

`show` lists the phrases, each with its time and `picture` (a sheet in `ref/speech/` with the frame at the middle of
each phrase, its time under it). Open the sheets and hold each phrase against its frame and the frames of its shot:
is the person who says these words visible? `confirm` records one kind for every phrase (`--narration`,
`--on-camera`, `--sung`, `--fragments`, each with the numbers of its phrases, singly or as ranges like `2-6`; `--all <kind>` for all of them); a video
can be part narration, part on camera. It writes `timeline.md` again: read its beats once more ("on camera" marks a
beat a person says; sung words and fragments are no beats). `template save` refuses a reference whose kind is
unconfirmed.

The cost overview and the one budget, now that the reference is read (leave out what this video does not use):

- Voice-over, only when the kinds include `narration`: `popost video voice quote --voice default-male --text "<a
  script as long as the reference's narration>"` (an estimate until the lines are written), and a little for pace
  calibration (`plan --voice` speaks one sentence). No narration: no voice-over in the overview, and none is made,
  unless the user asks for one in their own words.
- Generated clips and pictures: their price per second or per picture (`popost video generate --models`) times what
  you plan. Every on-camera stretch is a clip in which a person speaks, as long as the stretch (`video-performers.md`).
- The transcription already paid (`chargedCredits` of `describe`).

Show the user the items, the total and the balance, and agree one budget for the whole video (the money rule above).
The user agrees once; do not ask per command after that. When speaking people cost more than the user wants to spend,
the user decides what to do: never turn a speaking person into silent footage with a narration to save money.

Done when: you have opened every picture of `ref/`, `popost video elements check ref` prints `"ok": true` (every
shot has an entry that says its layout, how it begins and ends as its frames show it, and which layers are the
platform's or the author's), the speech kind is confirmed, and the user agreed a budget (or no paid work is planned).

Before saving a new replication template, run `popost video replication init ref --reference reference.mp4`,
complete `replication.json` from the actual source video/audio, and run
`popost video replication check ref --reference reference.mp4`. Include short in-shot events as well as cuts:
typing, cursor/marks, masked rolling digits, actor visibility, camera/focus moves and prop causality. Uncertain
speech/style or an unreviewed empty inventory stops paid production. A song does not become a narrator because ASR
recognized its lyrics. The complete contract and its local evidence are carried into the template and filled project.

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

The user's topic decides what the video shows. Before designing any scene, collect every source the request names (a
page, a README, a file), each with:

```bash
popost video source https://example.com/ --out project/source
```

It fetches that one page (no link is followed), saves its text into `project/source/` and downloads the pictures it
references into `project/source/pictures/`, the logo first, badges and tracking pixels left out. It prints an
inventory: each picture with its `file`, what the source `says` of it (its alt text), the `heading` it stands under and
its pixel size; `colours` (those of an SVG logo, a page's theme colour; `neutral` marks white, black and grays);
`site` (links to what is most likely the product's own site: candidates for `capture`) and `skipped`. Read the saved
text and open the pictures you plan to use. Then:

- Anything that shows the product or its interface is a real picture of the sources or a capture of its own pages (a
  `picture` shot, an `"image"` item, an `<img>` in a scene: `../source/pictures/...` from the scene file). Never draw
  an imitation of a product's interface in HTML. An abstract diagram (steps, a flow, a number) is fine, and must look
  abstract. The logo is the collected file, never redrawn; brand colours come from `colours`.
- Pictures from third parties are not used, and facts come from first-party sources only: the request, the product's
  own pages and repository. `video check` and `scene check` warn when the sources gave pictures and nothing in the
  project shows one.

Use only what the sources say. When a source exists in several languages (a page with a language switch, a README in two languages),
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
the requests and run `popost video materials requests.json --out project --template template --confirm --max-credits <left>`
(`video-tools.md`, "Generated clips": the request, the price, what it prints). A shot in which a person says an
on-camera beat is a clip with `"speech"`: the lines, who says each, their language and the beat each re-makes; the
program takes the times from the beats and writes the dialogue into the prompt (`video-performers.md`). `materials`
refuses a list that leaves an on-camera beat to no clip. The first such run of the project makes
its clips the agreed clips; any other paid clip later is "unplanned" (the money rules above). Two rules about motion:

- Group the calls by the continuity of the scene, not by shot: consecutive short shots of one look are one request
  that lists them with their lengths and "hard cuts" and asks for one continuous soundtrack, because a call's sound
  is continuous only inside it. `popost video shots` then finds the cuts and writes the fill entries and the `"beds"`
  entry that keeps the sound in one piece (`video-tools.md`, "How many calls": the rules, and what it costs).
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
- A shot longer than the longest clip the model makes: `template save --max-shot <seconds>` cuts it into parts, and
  the clip of each later part says `"continues"` with the file of the part before it, so it starts from that clip's
  last frame. Reference pictures stay the default; frames are for that and for a clip
  that must begin on an exact picture (`video-tools.md`, "Reference pictures or frames").

Then write `project/materials.json`, one entry per file, saying what it shows:
`{ "assets/page-01.mp4": "the pricing page: zooms to the Pro plan, boxes its price, the pointer clicks Buy" }`.

Done when: every footage or picture shot you plan has its file in `project/assets/`, listed in `materials.json`, and
you have looked at two frames of every recording.

## 4. Write the lines and the fill

Write the request in your own words into `brief.txt`: the topic, the audience, the language, what must be said.

```bash
popost video plan template --brief brief.txt --assets project --dry --voice <voice> --fit-tempo 1.12
```

`<voice>`: `popost:default-male`, `popost:default-female` or `popost:VOICE_ID` from the live platform catalog (`video-performers.md`), or a name a speaker of the user's own understands. With a `popost:` voice, `plan` speaks a sentence to time it, paid like all speech: add `--confirm --max-credits <left>` (`--dry` does not make it free; once timed, the pace is kept and not paid again). It prints `answer`
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
- The voice follows the speech kind (step 1; TEMPLATE.md repeats it):
  - `narration`: a voice-over. Its beats' lines are spoken by `--speak`.
  - `on-camera`: the line of such a beat (TEMPLATE.md: "on camera") is the line the person says in the clip of that
    shot; write the same words in `captions[i]` and in the clip's `speech.lines`. The voice-over never reads it, and
    it is drawn as a caption when its beat is a shown one. Fill the shot with that clip from `"in": 0`.
  - `sung`, `fragments`, `none`, `unknown`: no voice. Leave out `--voice`, `"voice"`, `"say"`, `--speak`,
    `--keep-length`, `--fit-tempo` and `--pace` here and in step 6; the caption lines are still drawn. For `unknown`,
    write into the delivery notes that the speech was not transcribed and the video therefore has no voice-over.
  A reference without narration gets a voice-over only when the user asked for one: pass their own words with
  `--voice-asked "<their words>"` to `plan`, `template check` and the first `template fill` (the project then keeps
  them), and name them in the delivery notes. The checks refuse a voice nobody asked for.
- Sound is mixed in layers, by itself. A clip in which a person speaks is heard at full level and nothing speaks over
  it. Every other clip keeps the sound it came with, lowered by 18 dB while a line of the voice-over is spoken and
  back up in the pauses. A `"sound"` lies under everything, lowered the same way while anybody speaks, and fades out
  at the end when it is longer than the video (shorter, it is not repeated). A shot's `"audio"` overrides this for its
  clip: a number fixes its level, `false` mutes it (`video-templates.md`).
- `"sound"` is a file the user gave, taken in with `popost video music own --file <their file> --out
  project/assets/<name> --given "<their words that gave it>"`. Nothing else: never put a narration together with other
  tools (`voice speak` lines mixed with ffmpeg) and name it as `"sound"`, never write an audio track into `video.json`
  by hand, never take the music or the voice out of the reference, never make up a tone to fill silence, and never mute
  a clip to be safe. The checks refuse a sound without a record of where it came from. A quiet video is not a fault to
  repair; the user adds music when they post, or in an editor.

For strict replications, the confirmed speech kinds also populate `replication.json`: distinguish narration, on-camera dialogue, music/vocals, effects and ambience. A skipped ASR result or a song lyric does not request a narrator. Record every actual audio route and file hash in `replication.audio.json`; the strict final review checks these against the resolved timeline. Explicitly authorized reference-music preservation uses the verified source-audio workflow in [video-replication.md](video-replication.md), rather than an invented uploaded-file provenance.

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
4. Use the actual filled shot's clock. Match the reference entrance, dwell, exit and handoff; do not move every
   entrance into the first half or erase an observed exit. After speech retiming or custom-transition ownership
   changes, export `video replication timeline project` and refresh the event map. All related layers use that
   same clock and viewport, including marks, cursor, number cells and their labels.
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
before. Start from the nearest example scene when there is one (an object that leads a reveal, a card that turns in
depth, doors that fold, a wipe in streaks: `popost video scene example` lists them with their parameters), set its
parameters from the shot's measured "Paths" and hold a sheet of its frames against the reference's
(`<skill>/references/video-scenes.md`, "Example scenes with parameters"). Never replace the effect by a preset, and never patch `video.json` with a script after `template fill`: the
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
popost video template fill template --fill fill.json --out project --speak --keep-length --fit-tempo 1.12 --pace <budgets.pace> --confirm --max-credits <left>
popost video check project --layout
popost video scene check project
popost video template check template --fill fill.json --assets project --pace <budgets.pace> --fit-tempo 1.12
```

`--speak` speaks every caption line of a narration beat into `project/assets/voice.m4a` (a line a person says on
camera is left to its clip; every time it runs; it takes minutes; a line already spoken in the same words is not
paid again) and
re-flows each beat to its spoken line; `--keep-length` keeps each beat at least as long as in the reference, so the
cuts keep its rhythm; `--fit-tempo 1.12` speeds a line that would run over its beat up as far as it needs, at most
12% (hardly heard; the pitch stays), and only the rest makes the beat longer. Its `notes` say which lines were sped
up and give the new length. How a caption line comes on screen is measured (`text.json`, `captionLook.reveal`; REFERENCE.md and TEMPLATE.md say it): a source whose lines appear whole at once gets whole lines, and `template check` warns about a `"captionReveal": "words"` it did not have; a source whose lines build word by word gets that by default with a voice. Only where nothing was measured and the reading says the words appear one by one, add `"captionReveal": "words"` to the fill (`template check` warns when it is missing). From now on run `template fill` only with these options, or the voice is dropped.
Without a speaker, or for a video without a voice (step 4: no narration in the reference), leave out `--speak --keep-length --fit-tempo 1.12 --pace <budgets.pace> --confirm --max-credits <left>`; `template fill` refuses them there. The last command
looks at the files of the fill and at `project/video.json`: run it again after every hand edit of `video.json`; it
warns when the captions are much smaller or larger than the reference's, with both sizes in pixels (`video check` does
too). `scene check` also warns when a scene is far emptier than its reference shot (draw what the shot holds, as
densely) and when a scene or a caption shows the reference's own words or figures (say what your sources say instead).

Done when: all four print `"ok": true`, with no warning about the size of the captions.

## 7. Render, compare, deliver

For a new replication, rendering reports `artifactReady: true`, `requirementsMet: null` until the exact output is
reviewed. Numeric similarity and a successful `compare` are measurements, not a fidelity pass. Follow
[strict replication review](video-replication.md): inspect the opening, active motion and resolved state of every
required event, not only 25/50/75% scene samples. Check real pair identity/stage, style/performer archetype, all
audible roles and duration. Keep `replication.plan.json` mapped to the compiled project, write the evidence review,
then run `popost video replication check project --reference reference.mp4 --artifact final.mp4`.
Only `qualityStatus: "accepted"` establishes a completed strict replication. Missing or failed requirements remain
pending/failed even when the file renders. An upstream failure is a checkpoint, not permission to substitute a
simpler visual medium. Ordinary comparison warnings still guide iteration; they are not all made fatal globally.

```bash
popost video render project --out final.mp4
popost video compare reference.mp4 final.mp4
```

`compare` scores the whole video per dimension from 0 to 1 (1 is the same), then prints `shots` (each shot of the
reference against the matching part of yours), `motionAmount` (how much the picture moves in both videos; `less` and
`more` list the shots that move less than half or more than twice as much as the reference's, and its `note` says what
to do: fix them like a shot of `worst`), `paths` (each path measured in the reference against yours at the same moment:
`differs` names what is not alike, the reference's number first: the path angle, the size, the duration, the shape of
the edge; set the scene from the reference's numbers), `notRecovered` (what the reading of the reference did not
recover and what you added: it goes into the delivery notes) and `worst`: the shots that differ most, each with `by` (the dimension
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
replaces opening the single shots of `worst`. With a text reader, `popost video readback project final.mp4 --confirm --max-credits <left>` says whether every
caption is legible (and heard, with a transcriber; popost.ai transcription of the voice is paid, `--no-speech` leaves it out: write it for a video with music and no voice), and warns for each shot whose text stays on screen smaller than
1.8% of the height (`textSizes`: the smallest and median per shot): zoom in, take the still at `--scale 2`, or show
fewer words. It also warns for each shot whose captions do not stand out from what is behind them
(`captionContrast`: white letters on a light page, dark ones over the page's own text): put them on a plate,
outline them, change their colour, or move the band to a calm part of the frame. It reads every caption and every
shot twice, at most two frames a second, and its first line says how long that takes (a second line when the frames
hold much more text than captions). It keeps the transcript beside the project, so a readback after a fix that left
the sound alone does not listen again.

Open the editable Studio with the existing preview editor (selection, timeline operations and cloud saving: [video-editing.md](video-editing.md)):

```bash
popost video preview project --edit --reference reference.mp4
```

Start this with the host's background-process tool and keep the service alive after delivery. Wait for its real JSON
output and use its `url`; do not guess a port. Fetch `api/state` under that URL and confirm it has `source` and
`edit`, then open the URL with the host's browser or side-panel tool. Check that the timeline and project load, a
text edit saves, undo restores it, a reload keeps the saved state, and the editor can render. Use the same project
that produced the delivered video. The URL is a local editor on this computer while that service runs.

When a template deliberately drops trailing platform shots, `compare` reports the retained reference interval and `omittedShots` after checking its sampled visual fingerprint. An unrelated reference or an older project without that provenance is compared in full; do not read the omitted endcard as a failure of the new closing.

Deliver `final.mp4`, its editable Studio URL, the `project/` directory and the delivery notes (`NOTES.md`): what is as in
the reference, what differs and why (no voice, a missing tool, a source that did not have something), each shot of
the last `worst` that was not fixed, with its reason, and under "Not recovered" every entry of `compare`'s
`notRecovered` (the reading's list and what you added to `elements.json`): what was not recovered and what the video
does instead. Never leave an entry out because the result looks fine: the user decides whether the assumption holds. Say what the video's sound is (the voice-over, people who speak in clips, the user's file, the clips' own sound, or none), the reference's speech kind and what followed from it (a voice-over the user asked for is quoted with their words; `unknown`: not transcribed, so no voice-over), and that the user
can add or swap music in the Studio or when they post. Say the Studio is open only after it has actually loaded.
