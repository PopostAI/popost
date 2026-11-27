# Video tools and common failures

`popost video` needs ffmpeg and a Chrome or Chromium; everything else is an optional tool that you or the user
plug in through an environment variable. `popost video doctor` says what is there:

```json
{ "ok": true, "ffmpeg": "7.0.2", "browser": true,
  "tools": { "readText": null, "transcribe": "popost.ai", "speak": "popost.ai", "generate": null }, "hosted": { ... } }
```

`"popost.ai"`: the connected account does it (the default once `popost auth login` has run); a variable name: a tool
of the user's own, which goes first; `null`: neither. Without an account `doctor` says under `connect` to connect
first.

## Programs

### Check the installation before testing a reference

Use the CLI that came with the installed Skill, especially for a feature-branch test build; do not replace it with
the published npm release. Record its branch and commit as well as `popost --version`: a test branch may retain the
published version number. A source checkout needs `npm ci && npm run build:skill` from the repository root. Node
must satisfy the repository's engine requirements. Then run `popost video doctor`: ffmpeg and Chrome or Chromium
must both be available. If either is missing, install it or set its program path in the table below, then rerun
`doctor`. ffprobe is not required. A successful `doctor` checks program availability, not reference-reading quality.

The text reader, transcriber, speaker and generator are optional and installed separately. A `null` entry means
that capability is unavailable, rather than a broken core installation. Test each configured reader or speaker on
a short local input first: the first run may need model downloads. Installing a tool without its model files is
not enough; verify a real output before using it in a reference test. Keep existing user-selected tools and billing
providers when diagnosing an unrelated failure.

Render-browser operations have a 30-second deadline and name the stage that stopped responding (for example,
preparing a scene or capturing a frame). Inspect that stage and its assets instead of changing providers. Each local
video job owns its temporary Chrome process and closes it on completion or failure; a stopped graceful shutdown is
terminated through that owned process handle. Screenshot capture waits for the browser to paint the requested frame.

| Variable | What it names | Default |
|---|---|---|
| `POPOST_FFMPEG` | the ffmpeg program (ffprobe is not needed) | `ffmpeg` on PATH |
| `POPOST_CHROME` | the Chrome or Chromium that draws frames and records pages | found in the usual places |
| `POPOST_RENDER_PAGES` | how many browser pages draw frames side by side | by the size of the job |
| `POPOST_VIDEO_WORK` | where caches and scratch files go (a voice's measured pace, test renders) | `.popost/video` under the working directory |
| `TMPDIR` | temporary files (frames, audio); point it at a disk when `/tmp` is small | the system's |

## Paying for popost.ai: one budget per video

With a connected account, voice-over and transcription are done on popost.ai by default, and generated clips and
pictures with the built-in generator; tools of the user's own (below) remain an option and go first when set. Each
call costs at least 1 credit; any plan can use them while the balance covers the price (creating a personal voice
needs a paid plan). They are paid as images are, under one money rule:

- Before the work, one cost overview: the exact transcription price (`popost video transcript reference.mp4
  --quote`, free), the voice-over estimate (`popost video voice quote --voice <voice> --text "<script>"`, free), a
  little for pace calibration, the generated clips and pictures (`popost video generate --models` has the credits),
  the total, and the balance (`popost account`). The user agrees one budget for the whole video.
- What is spent is what popost.ai counts. Every Open API call made for a project carries the project's task (its id,
  kept in `production/task.json` of a video project or the `projectId` of an image project; its title; the agent's
  session), and the account page shows the project as one line, "Task: <title>", item by item. The title is the one
  `popost usage --dir <project> --title "<a few words>"` gave (step 0); without it, the first request in the project
  keeps one: the reference's file name (not `reference`), the first words of the brief or fill, else the folder's
  name. `popost usage --dir
  <project> --budget <agreed>` (free) prints that count, `credits` (net, refunds subtracted), the `items`, and
  `budget.left`; with the agreed clips (`production/approved-clips.json`) also their count and price. A 404 means the
  connected popost.ai does not report it yet: then add up `chargedCredits`.
- Every paid command (`transcript`, `describe`, `readback`, `plan --voice`, `template fill --speak`, `retarget
  --speak`, `voice speak`, `materials`, `generate`) then runs with `--confirm --max-credits <left>`, `<left>` from
  `popost usage`. Its JSON has `chargedCredits`, a quick check: a run that stopped after paying (a timeout) prints
  none, while usage counts it. Inside a command the ceiling is counted down call by call, and a call it does not cover
  is refused before anything is sent. `transcript`, `describe` and `voice create` have no project of their own: give
  them `--project <project>` so that they are booked under it too.
- Without `--confirm` a paid command makes and charges nothing: it prices its work (quotes are free) and ends with exit
  code 3 and `{ "confirm": { "credits", "balance"?, "items": [...] }, "next" }`; a price above `--max-credits` ends the
  same way, with `maxCredits`. Ask the user again only when the price is more than what is left or the scope changed.
- A balance known to be short is `INSUFFICIENT_CREDITS` before anything is made: `popost account` shows the balance
  and where to add credits.
- Generated clips: see "The built-in generator" for the clips the user agreed to and "unplanned" clips.

The same work sent again is not charged twice: speech by its operation key, a transcription by its sound (a render's
own sound is a new one: a `readback` that should hear it is paid; `--no-speech` leaves it out), a clip by its request.

## Tools

With a connected account, `popost video voice list` shows the live voice catalog; use `popost:default-male`,
`popost:default-female` or `popost:VOICE_ID` (recommended over a speaker of your own) and follow
[people and shared voices](video-performers.md). Listing and quoting are free. Hosted speech comes with the time of
every word, so a spoken fill needs no transcriber to time its captions. `popost video voice create` makes a personal
voice from the user's own recording (with their consent, on a paid plan; same page). Provider credentials and clone
ids stay on the server.

Transcription is popost.ai's with a connected account, unless `POPOST_ASR_CMD` names a transcriber of the user's own:

```bash
popost video transcript reference.mp4 --quote                                  # free: the seconds of sound and the credits
popost video describe reference.mp4 --out ref --project project --confirm --max-credits <left>   # within what is left
```

`--quote` prints `seconds`, `credits` and `next`. A command that needs no speech can say so with `--no-speech`
(`describe`, `readback`): nothing is transcribed or paid. popost.ai transcribes at most 30 min of sound. A long one
writes a line on stderr every 30 s while the command waits (at most 30 min); when the command stops before it is done,
run it again: it waits for the same job instead of starting a new one. After a transcription that failed, running the
command again starts one new job. A transcriber in `POPOST_ASR_CMD` is used instead whenever it is set.

Each variable holds a command line: the program and its first arguments, split at spaces (so no spaces inside a
path). The engine adds the arguments below, waits for the command to end, and reads the file it wrote; a non-zero
exit is a failure, reported with the last lines of its stderr. Which model or service runs behind a tool is the
tool's business. Examples to start from (a text reader on RapidOCR, a transcriber on faster-whisper, a speaker on
sherpa-onnx with Kokoro), each with its setup and its voices:
https://github.com/PopostAI/popost/tree/main/skills/popost/tools/video

| Variable | Called as | Must write |
|---|---|---|
| `POPOST_OCR_CMD` (text reader) | `<cmd> <list.json> <out.json>`; list.json is `[{ "frame": 120, "file": "/abs/000120.jpg" }]` | out.json: `[{ "frame": 120, "lines": [{ "text": "...", "confidence": 0.97, "box": [x, y, w, h] }] }]`, boxes as fractions of the frame |
| `POPOST_ASR_CMD` (transcriber) | `<cmd> <audio.wav> <out.json> [language]` | out.json: `{ "language": "zh", "words": [{ "text": "...", "start": 1.02, "end": 1.16, "confidence": 0.99 }] }`, times in seconds |
| `POPOST_TTS_CMD` (speaker) | `<cmd> <text.txt> <out.wav> [voice] [speed]` | a WAV at out.wav; optionally `<out.wav>.words.json`: `{ "words": [{ "text", "start", "end" }] }` in seconds |
| `POPOST_GEN_CMD` (generator) | `<cmd> video\|image <request.json> <out-file>`; request `{ "prompt", "seconds"?, "aspect"?, "images"?, "videos"?, "audios"?, "firstFrame"?, "lastFrame"? }`, references and frames as paths (frames only without references) | the clip or picture at out-file, and one JSON line on stdout: `{ "credits"?: number }`. To have a price agreed first: nothing made, `{ "confirm": { "credits": n, ... } }` and exit code 3; such a tool answers a request with `"priceOnly": true` that way whatever its budget |

- What they change: a text reader lets `describe` read the captions (the beats) and `readback` check the render; a
  transcriber reads what is said (spoken beats) and times a voice's words; a speaker makes the voice-over
  (`plan --voice`, `template fill --speak`); a generator makes clips and pictures from prompts with
  `popost video materials` (every call may cost money: the tool must price and limit it; the built-in one below
  asks before it charges).
- For a custom tool, the voice argument is passed to the speaker as it is: the README beside the tool that `POPOST_TTS_CMD` names says
  which voices exist (for a male voice, pick one it calls male). `POPOST_OCR_JOBS` runs several readers side by side (default 1).
- `POPOST_CPUS=2` keeps all video work to two processors (ffmpeg threads, Chrome pages, tool threads, parts run side
  by side); unset, it is what the process may use (its affinity and its container's CPU quota), and `popost video
  doctor` prints it. Tools get it as `POPOST_TOOL_THREADS` (at most 4) unless you set that yourself.
- `POPOST_LLM_URL`, `POPOST_LLM_MODEL`, `POPOST_LLM_KEY` configure a model for `plan` without `--dry`,
  `template see` and `scene write`. An agent that writes the fill and the scenes itself does not need them. A key
  is never written to a file or printed.

## Generated clips

`popost video materials requests.json --out project --confirm --max-credits <left>` makes the clips and
pictures of a list through the generator (`POPOST_GEN_CMD`), one after another; `--check` only reads the list. A file
that exists is never made again, so running it twice costs once, and what each file shows goes to
`project/materials.json`. Paid generation follows the money rule ("Paying for popost.ai") and the agreed clips ("The
built-in generator").

```json
[{ "file": "assets/walk.mp4", "prompt": "a woman walks briskly through a market, handheld, the camera follows",
   "seconds": 5, "aspect": "9:16", "images": ["assets/product.png"], "note": "the walk through the market" }]
```

- `file`: where it goes in the project; `.mp4` is a clip, `.png`, `.jpg` or `.webp` a picture. `seconds`: whole
  seconds of a clip. `aspect`: the canvas's ratio. `images`, `videos`, `audios`: reference files of the project, which
  the prompt names in order as `@image1`, `@video1`, `@audio1`. `note`: what it shows, for `materials.json`
  (default: the prompt).
- It prints, per file, `made`, `credits`, a clip's `seconds` and its `motionAmount`: how much its picture changes
  between frames 1/15 s apart, the measure `describe` gives every reference shot (`shots/NN.md`, `Motion amount`).
  A clip far under its shot's amount moves too little for it: ask again with the action and the pace of the shot in
  the prompt before building on it. `popost video compare` gives the same pair for every shot of the finished video.

**One anchor picture keeps the clips alike.** Words do not: "the same woman" gives another woman in every clip. With
two or more clips in the list, one of them is made first (the first that is not a close-up), a frame of it is saved
as `anchor.jpg` beside it and goes to every other clip as a reference picture, with a sentence asking that whatever
the clip shares with it (a person and their clothes, a product, a place) looks the same. It never asks for a person,
so it holds for clips of a product alone. No clip is made that was not asked for, and on popost.ai a reference
picture does not change the price.

| Option | What it does |
|---|---|
| `--anchor-image <file>` | a picture of the user's (the person, the product) is the anchor of every clip; no clip is made first |
| `--character <id>` | a character of the user's popost.ai character library is the anchor: its picture is downloaded to `assets/character-<id>.png` and every clip that shows a person shows that one. Needs the account (`popost auth login`) |
| `"anchor": false` in a request | this clip neither gives nor takes the picture. For a clip that shares nothing with the others (another place and subject, a cutaway, an abstract ground): a reference picture pulls a clip towards what it shows |
| `--no-anchor` | no anchor at all: unrelated clips, or a generator that takes no reference pictures |
| `--anchor` | the anchor also for a list of one clip, so that a later list finds `anchor.jpg` |

**How many calls.** A call's sound is continuous only inside it: shots generated one by one each bring a sound of
their own, and the film sounds cut up. So group by the continuity of the scene, not by shot:

- Consecutive short shots of one look or world (a wordless brand film, a b-roll montage) are ONE request, up to the
  model's longest clip (`popost video generate --models`): the prompt gives the look once, asks for "one continuous
  soundtrack over all shots", and lists the shots in order, each with its length and what it shows, with "hard cuts"
  between them. Longer runs are split at a change of place or look, into few long calls rather than many short ones.
- Never a call for one shot shorter than the model's shortest clip when it can join its neighbours: the rest of the
  clip is paid for and thrown away.
- A shot gets a call of its own only when it needs lip-synced speech, an exact first picture or label
  (`"firstFrame"`), or other reference pictures than its neighbours.
- What it costs: the cuts fall only about where they were asked for, a shot may come out shorter than asked, and one
  bad shot means making the whole group again. `materials` and `materials --check` warn when a list asks for three or
  more clips of 5 s or less one by one.

Putting such a clip on the template: `popost video shots project/assets/film.mp4 --out look/film` finds the cuts
inside it with the detector `describe` uses and keeps a frame of each shot (`look/film/shot-NN.jpg`: open them, a soft
cut can be missed and a fast move read as one). With `--onto template --first 3` it also prints `fill`: for each shot
of the clip the entry of the template shot it goes on, `{ "footage", "in", "speed" }`, where `speed` makes the clip's
shot as long as the template's shot needs (a note names a shot that would have to play slower than 0.9: ask for it
longer next time, never slow it down), and `bed`, to copy into the fill's `"beds"`: the clip's sound then runs on in
one piece under those shots instead of being cut and re-timed with each (`video-templates.md`).

**Reference pictures or frames.** A clip is steered in one of two ways, never both in one request:

- Reference pictures (`"images"`, the anchor): who or what is in the clip. The model composes the shot itself and
  keeps the person or the product of the pictures. This is the default, and the way to keep identity across clips.
- Frames: `"firstFrame"` is the exact picture the clip starts from, `"lastFrame"` (only with it) the one it ends on.
  Use them for an exact composition (the clip must begin on this still: a product photo, the last picture of the
  scene before it), and for a shot longer than one clip: `"continues": "assets/part-1.mp4"` makes a clip start from
  the last frame of that clip (of the list, or already in the project), made after it. `template save --max-shot
  <seconds>` cuts such a shot into parts, and each later part takes the clip that continues the part before it. A
  clip with frames takes no `"images"`, `"videos"` or `"audios"` and no anchor: what it shows is
  in its first frame.

While a clip another one needs is not there (the anchor clip, the clip it continues), the one that needs it is not
made. When the needed clip's price waits for the user it is only priced, so `confirm.credits` is the total of the whole
list; when the needed clip failed it is listed with `"waiting": true` and costs nothing. Run the command again once
the needed clip exists.

## The built-in generator

`popost video generate` makes clips and pictures on popost.ai, in the user's own popost.ai account. Every clip and
every picture costs popost.ai credits. Set it up once:

```bash
popost auth login                         # the account (or POPOST_API_KEY; POPOST_BASE_URL for another address)
export POPOST_GEN_CMD="popost video generate"
popost video generate --models            # the video models: ids, resolutions, seconds, aspect ratios, reference limits, credits
```

| Variable | What it sets | Unset |
|---|---|---|
| `POPOST_VIDEO_MODEL` | the model of a clip: an `id` from `--models` | the platform's default model |
| `POPOST_VIDEO_RESOLUTION` | the resolution of a clip, one its model lists | the model's default |
| `POPOST_IMAGE_MODEL` | the model of a picture (`popost provider cli models` lists them) | the platform's default |
| `POPOST_GEN_MAX_CREDITS` | older form of a ceiling for one call; `--confirm --max-credits N` is the one to use | every call asks first |
| `POPOST_GEN_WAIT_MIN` | the minutes a clip is waited for | 30 |

The request never chooses the model, the resolution or the budget. Its `"aspect"` goes to the model as it is (some
models take `"adaptive"`; `--models` lists each model's ratios), and a clip without `"seconds"` is 5 seconds long.
References are uploaded to the account first: `"images"` JPEG, PNG or WebP, `"videos"` MP4 or MOV, `"audios"` MP3 or
WAV (clips and sounds for a clip only). `"firstFrame"` and `"lastFrame"` (pictures) go the same way, for a model that
`--models` lists with `"frames": true`; another model refuses them and says so, and nothing is charged.

**The price is agreed before anything is charged.** Every request is priced first. Without `--confirm` nothing is
charged: `generate` prints one line,
`{"confirm": {"credits": 25, "model": "<id>", "resolution": "480p", "seconds": 5, "aspectRatio": "9:16", "balance": 900}}`,
and exits with 3; `popost video materials` puts that price on the file (`confirm`), the total of the list in
`confirm.credits` and `items`, makes nothing that waits for it, and exits with 3. Within the agreed budget (the money
rule above), run `materials` again with `--confirm --max-credits <left>`: it makes the files one by one within
that ceiling (it hands what is left to the generator as `POPOST_GEN_MAX_CREDITS`) and prints `chargedCredits`. A price
above what is left asks again. Without enough credits it fails before asking (`popost account` shows the balance).
`POPOST_GEN_MAX_CREDITS` and `--yes` (`POPOST_GEN_CMD="popost video generate --yes"`) still work as before.

**Generated video is the expensive item: only the agreed clips are made.** The first `materials --confirm
--max-credits N` of a project makes its list the agreed clips and records each clip it pays for (its request key, its
file, what it shows, the agreed price) in `production/approved-clips.json` of the project. Any other paid clip after
that is unplanned: a new clip, a regeneration or variant (a new request key), or a changed request (another prompt,
length, resolution, model or reference). `materials` and `generate` (also when it is called on its own with an output
file inside the project) stop it whatever the budget, charge nothing, and exit with 3:
`{"confirm": {"credits": 25, "reason": "unplanned", "clip": {"key": "video-...", "file": "assets/b.mp4", "what": "...", "seconds": 5}}}`.
Never regenerate a clip to fix its quality, or add one, without showing the user the clip, the reason and the price
and getting a yes. Only then run the same command again with `--approve-unplanned <key>` (once per approved clip, on
`materials` or `generate`); the clip is added to the record. Running an agreed clip again is not new: it neither asks
nor charges. Pictures and speech are not part of the record: the budget alone covers them.

Then the clip is made on popost.ai, which takes minutes: the command checks every 10 seconds, downloads the clip to
out-file and prints `{"credits": n, "chargedCredits": n, "key": "video-..."}`: what the clip cost, what this call
charged (0 when it was paid before) and its request key.

- **Kept 7 days.** popost.ai keeps a generated clip, and the reference files uploaded for it, for 7 days and then
  deletes them. Once downloaded, the clip is a file of the project.
- **A retry never pays twice.** A request goes out with an idempotency key derived from it (model, resolution,
  prompt, seconds, aspect ratio and the contents of its references), and what was sent is kept in
  `~/.cache/popost/tasks/videos/` (`POPOST_TASK_DIR` moves it). After a crash or a timeout, run the same command again:
  it finds the clip, waits for it or downloads it, and pays nothing more. Only a clip that failed (its credits were
  refunded) or expired is made again, as a new attempt that is priced again.
- **Failures** print one line on stderr and exit with 1 (2: the setup or the request needs fixing): no account
  connected, video generation not available for the account (`VIDEO_GENERATION_DISABLED`), not enough credits, a
  setting the model does not take (`VIDEO_OPTION_UNSUPPORTED`; frames together with references are refused before
  anything is sent), content rejected (`CONTENT_REJECTED`, refunded), or
  still being made after `POPOST_GEN_WAIT_MIN` (run the same command again later).

## Collecting a source

`popost video source <https address or file> --out project/source [--max-pictures 40]` collects one source of the new
video: a web page, a raw README, or a local `.md`, `.txt` or `.html` file. Only that page is fetched. It writes the
text (`<name>.md` for Markdown, `<name>.txt` for a page without its tags), the pictures
(`pictures/<name>/NN-<file>.<ext>`, at most 10 MB each and 80 MB in all) and `pictures.inventory.json`, which the
checks read; a second source joins the same inventory, and running a source again replaces its entry.

- Order: pictures that call themselves the logo, then the others as the source has them, then a page's own icon and
  preview picture. Left out: status badges and counters (by their address), pictures of 3 px or less (tracking
  pixels), anything over the limits; `skipped` counts them and lists what could not be fetched.
- An SVG stays an SVG (it is not turned into pixels): an `<img>` of a scene shows it at any size. A GIF stays a GIF:
  a scene shows its first picture only.
- `site.hosts` is a guess from the addresses (the page's own site, the site its pictures come from, a host that
  carries the repository's name); `otherHosts` are the rest. Nothing there is fetched.
- A picture beside a local file is copied only from inside that file's directory.

## Capture plans

`popost video capture <url> --plan plan.json --out page.mp4` records a page by a JSON list of steps, played one after
the other at `--fps` frames a second (30). A `"to"`, `"into"`, `hover` or `click` takes a selector: one that
`--outline` printed, any CSS selector, or `text=Buy now`. Options: `--size WxH` (the window, 1280x720), `--zoom F`
(the page laid out F times larger, 1 to 4, for readable text), `--scale F` (more pixels), `--hide 'css,css'`, `--dark`,
`--caption-band Y` (the top of the video's caption band: the `y` of `slots.captions.box`, or pixels of the video; a
`zoom` then ends with its element in the room above the band, and `notes` say when it cannot or when a highlight lies
under the band). Pointer, boxes and zoom are drawn into the recording, the same at any size.

| Step | What it records |
|---|---|
| `{ "hold": 30 }` | the page as it is for 30 frames; its animations play |
| `{ "scroll": { "to": "#plans", "frames": 45 } }` | scrolls until the element is a little below the top; `"to"` also takes px from the top, `"top"`, `"bottom"` |
| `{ "zoom": { "to": "div.card", "frames": 20, "fill": 0.7 } }` | moves and enlarges the view until the element is in the middle and fills `fill` (0.7) of the width or height, at most 3 times; `"to": "page"` goes back; `"to": [x, y, width, height]` in page px. A scroll keeps the zoom |
| `{ "highlight": { "to": "div.price", "frames": 12, "color": "#e5342b", "pad": 6, "style": "box" } }` | draws a box around the element over the frames; `"underline"` a line under it, `"spot"` dims everything else. It stays on the element until `clear` or the next highlight |
| `{ "clear": 10 }` | the highlight fades out over 10 frames |
| `{ "point": { "to": "button.buy", "frames": 18 } }` | shows the pointer (the first time from the lower right) and moves it to the middle of the element |
| `{ "click": "button.buy" }` | with a pointer shown: it moves there (12 frames), presses (8 frames), the page is clicked. Without one: the click and one frame. A page that loads is waited for, unrecorded |
| `{ "hover": "a.menu" }` | the pointer moves there (12 frames) and the page reacts; without one, one frame |
| `{ "type": { "into": "input.search", "text": "running shoes", "frames": 30 } }` | empties the field and types the text, a few characters a frame, the caret shown |
| `{ "pointer": "hide" }` | removes the pointer (no frame) |
| `{ "wait": 800 }` | 800 ms of real time for the page to load (no frame) |

- `frames` may be left out: zoom 20, highlight 12, point 18, type 30. `"ease"` (scroll, zoom, point): `in-out`
  (default), `in`, `out`, `linear`.
- A click that opens another page: the pointer stays where it was, a highlight follows its selector if the new page
  has it, the zoom goes back to the whole page (a note says so).
- The JSON printed: `text` (`smallestPx`, `medianPx`: font sizes of the text seen, in pixels of the video) and
  `notes`. `--outline` prints `text`, `sections`, `targets` and `overlays` instead, each element with a `selector` and
  a `box`, `[x, y, width, height]` in page pixels.
- `--still page.png` writes one picture instead of a video, for a scene (`--at <selector or px>` places the window,
  `--full-page` takes all of the page). It prints `y`, where the picture starts on the page, and `stillScale`: an
  element's place in the still is its box with `y` taken from its y, times `stillScale` (same `--size` and `--zoom`).
- A picture of the window's size (such a still, a screenshot) is recorded the same way, so that one picture gives
  several shots views of their own: `popost video capture file:///<absolute path>/page.png --size <its width>x<its height>
  --plan zooms.json --out page-zooms.mp4`, with a `zoom` step to `[x, y, width, height]` (its pixels) for each shot.
  `template check` asks for this when one picture fills more than two shots or a third of the video.

## Common failures

| What you see | What to do |
|---|---|
| `doctor`: `ffmpeg was not found` | Install ffmpeg or set `POPOST_FFMPEG` to its path. |
| `doctor`: a browser message | Install Chrome or Chromium, or set `POPOST_CHROME` to it. |
| `describe`: `leftOut` lists on-screen text or speech | The reader or transcriber is not set up (no account connected and no tool of the user's own), or `--no-speech` was given: the template has no caption or spoken beats. Go on; look at the pictures. `toAdd` says how to add it (`popost auth login` first). |
| A paid command ends with exit code 3 and `confirm` | Nothing was made or charged. Within what is left of the agreed budget: run it again with `--confirm --max-credits <left>`. Above it, or the scope changed: show the user `confirm` and ask. `"reason": "unplanned"`: "The built-in generator". |
| `describe`: `while decoding frames for the sheets`, `Error initializing filters`, `Cannot allocate memory` on a longer reference | Earlier video test builds made a deeply nested FFmpeg selection expression. Update to a build with balanced frame selection, rebuild the matching CLI, and retry the same reference. This error alone does not prove missing dependencies or insufficient physical memory. |
| `template check`: `The fill has N shots; the template has M` | One entry per shot, in order; `template show` lists them. |
| `template check` / `fill`: a line over its limit or budget | Shorten the line; `fix` gives a shorter version. Do not raise `--pace`. |
| `template fill`: `Speaking the captions needs a speaker` | No speaker: run it without `--speak --keep-length --fit-tempo`. |
| `template fill`: a file is missing | Paths are relative to the project; the file must be in `project/` (`ls project/assets`). A picture in a scene's `slots` is relative to the scene file: `"../assets/x.png"`. |
| `scene check` or `check --layout`: `The picture "..." of the scene ... could not be loaded` | A path in a scene or a picture slot is wrong: it is relative to the scene file (`../assets/x.png`). The message says where the path led; do what `fix` says. |
| `scene check`: `does not fit its box: its glyphs run N px past ...` | Make the element larger (no fixed height), the text shorter, or the `line-height` larger: 1.2 for Chinese, 1.4 for Latin letters that reach below the line. |
| `scene check`: `is cut off ... X around it hides what lies outside it` | Make the element X larger or remove its fixed height, or shorten the text. |
| `scene check`: `shows the same flat picture` | Its elements are invisible (opacity, colour on the ground, outside the canvas) or its motion starts after the shot. |
| `plan --voice`: `needs a speaker` | No speaker: run `plan` without `--voice`. |
| `materials`: `the user has not agreed to that price` | Nothing was charged. Within what is left of the agreed budget, run `materials` again with `--confirm --max-credits <left>`; above it, show the user `confirm` and ask first. |
| `materials` / `generate`: `"reason": "unplanned"` | The clip is not one of the agreed clips; nothing was charged. Show the user the clip, why it is needed and its price; only after a yes run again with `--approve-unplanned <confirm.clip.key>`. |
| `capture`: `The page answered HTTP 429` (or 503) | Wait a minute and run it again, or record another page. |
| `capture` notes: `the scroll does not move` | The page is shorter than the plan: scroll to a heading from `--outline` or to `"bottom"`. |
| `capture` notes: `a fixed element ... covers` | Add the selector it names to `--hide`; keep the site's header if you want it. |
| `capture` notes: `text is small` | Record again with the `--zoom` it names, or zoom to what the line is about. |
| `capture` notes: `does not enlarge` or `the zoom stops at 3` | Zoom to a smaller element (a card, not its section) or a larger one (a card, not one word). |
| `capture`: `nothing on ... matches` | Copy the selector from `--outline` exactly, or record the page that has the element. |
| `render` is slow or runs out of memory | `--scale 0.5` for a draft, or `POPOST_RENDER_PAGES=1`. |
| `No space left on device` | Set `TMPDIR` to a directory on a disk with room. |
