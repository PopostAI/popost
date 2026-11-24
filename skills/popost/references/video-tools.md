# Video tools and common failures

`popost video` needs ffmpeg and a Chrome or Chromium; everything else is an optional tool that you or the user
plug in through an environment variable. `popost video doctor` says what is there:

```json
{ "ok": true, "ffmpeg": "7.0.2", "browser": true,
  "tools": { "readText": null, "transcribe": null, "speak": "POPOST_TTS_CMD", "generate": null } }
```

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

## Tools

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
| `POPOST_GEN_CMD` (generator) | `<cmd> video\|image <request.json> <out-file>`; request `{ "prompt", "seconds"?, "aspect"?, "images"?, "videos"?, "audios"? }`, references as paths | the clip or picture at out-file, and one JSON line on stdout: `{ "credits"?: number }`. To have a price agreed first: nothing made, `{ "confirm": { "credits": n, ... } }` and exit code 3 |

- What they change: a text reader lets `describe` read the captions (the beats) and `readback` check the render; a
  transcriber reads what is said (spoken beats) and times a voice's words; a speaker makes the voice-over
  (`plan --voice`, `template fill --speak`); a generator makes clips and pictures from prompts with
  `popost video materials` (every call may cost money: the tool must price and limit it; the built-in one below
  asks before it charges).
- The voice argument is passed to the speaker as it is: the README beside the tool that `POPOST_TTS_CMD` names says
  which voices exist (for a male voice, pick one it calls male). `POPOST_OCR_JOBS` runs several readers side by side (default 1).
- `POPOST_CPUS=2` keeps all video work to two processors (ffmpeg threads, Chrome pages, tool threads, parts run side
  by side); unset, it is what the process may use (its affinity and its container's CPU quota), and `popost video
  doctor` prints it. Tools get it as `POPOST_TOOL_THREADS` (at most 4) unless you set that yourself.
- `POPOST_LLM_URL`, `POPOST_LLM_MODEL`, `POPOST_LLM_KEY` configure a model for `plan` without `--dry`,
  `template see` and `scene write`. An agent that writes the fill and the scenes itself does not need them. A key
  is never written to a file or printed.

## Generated clips

`popost video materials requests.json --out project` makes the clips and pictures of a list through the generator
(`POPOST_GEN_CMD`), one after another; `--check` only reads the list. A file that exists is never made again, so
running it twice costs once, and what each file shows goes to `project/materials.json`.

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
| `POPOST_GEN_MAX_CREDITS` | the most one call may cost without asking: a budget the user approved | every call asks first |
| `POPOST_GEN_WAIT_MIN` | the minutes a clip is waited for | 30 |

The request never chooses the model, the resolution or the budget. Its `"aspect"` goes to the model as it is (some
models take `"adaptive"`; `--models` lists each model's ratios), and a clip without `"seconds"` is 5 seconds long.
References are uploaded to the account first: `"images"` JPEG, PNG or WebP, `"videos"` MP4 or MOV, `"audios"` MP3 or
WAV (clips and sounds for a clip only).

**The price is agreed before anything is charged.** Every request is priced first. Within `POPOST_GEN_MAX_CREDITS` it
goes on. Otherwise nothing is charged: the command prints one line,
`{"confirm": {"credits": 25, "model": "<id>", "resolution": "480p", "seconds": 5, "aspectRatio": "9:16", "balance": 900}}`,
and exits with 3; `popost video materials` puts that price on the file (`confirm`), the total of the list in
`toConfirm`, and makes nothing. Show the user the price or the total. Only after they agree, run again with
`POPOST_GEN_MAX_CREDITS` set to the highest price they approved for one file, or once with
`POPOST_GEN_CMD="popost video generate --yes"`. A price above a budget that is set asks again, `--yes` or not. Without
enough credits it fails before asking (`popost account` shows the balance).

Then the clip is made on popost.ai, which takes minutes: the command checks every 10 seconds, downloads the clip to
out-file and prints `{"credits": n}`, what was charged.

- **Kept 7 days.** popost.ai keeps a generated clip, and the reference files uploaded for it, for 7 days and then
  deletes them. Once downloaded, the clip is a file of the project.
- **A retry never pays twice.** A request goes out with an idempotency key derived from it (model, resolution,
  prompt, seconds, aspect ratio and the contents of its references), and what was sent is kept in
  `~/.cache/popost/tasks/videos/` (`POPOST_TASK_DIR` moves it). After a crash or a timeout, run the same command again:
  it finds the clip, waits for it or downloads it, and pays nothing more. Only a clip that failed (its credits were
  refunded) or expired is made again, as a new attempt that is priced again.
- **Failures** print one line on stderr and exit with 1 (2: the setup or the request needs fixing): no account
  connected, video generation not available for the account (`VIDEO_GENERATION_DISABLED`), not enough credits, a
  setting the model does not take (`VIDEO_OPTION_UNSUPPORTED`), content rejected (`CONTENT_REJECTED`, refunded), or
  still being made after `POPOST_GEN_WAIT_MIN` (run the same command again later).

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
| `describe`: `leftOut` lists on-screen text or speech | The reader or transcriber is not set up: the template has no caption or spoken beats. Go on; look at the pictures. |
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
| `materials`: `the user has not agreed to that price` | Nothing was charged. Show the user `toConfirm`; after they agree, set `POPOST_GEN_MAX_CREDITS` (the built-in generator above) and run `materials` again. |
| `capture`: `The page answered HTTP 429` (or 503) | Wait a minute and run it again, or record another page. |
| `capture` notes: `the scroll does not move` | The page is shorter than the plan: scroll to a heading from `--outline` or to `"bottom"`. |
| `capture` notes: `a fixed element ... covers` | Add the selector it names to `--hide`; keep the site's header if you want it. |
| `capture` notes: `text is small` | Record again with the `--zoom` it names, or zoom to what the line is about. |
| `capture` notes: `does not enlarge` or `the zoom stops at 3` | Zoom to a smaller element (a card, not its section) or a larger one (a card, not one word). |
| `capture`: `nothing on ... matches` | Copy the selector from `--outline` exactly, or record the page that has the element. |
| `render` is slow or runs out of memory | `--scale 0.5` for a draft, or `POPOST_RENDER_PAGES=1`. |
| `No space left on device` | Set `TMPDIR` to a directory on a disk with room. |
