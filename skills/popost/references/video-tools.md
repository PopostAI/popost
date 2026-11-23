# Video tools and common failures

`popost video` needs ffmpeg and a Chrome or Chromium; everything else is an optional tool that you or the user
plug in through an environment variable. `popost video doctor` says what is there:

```json
{ "ok": true, "ffmpeg": "7.0.2", "browser": true,
  "tools": { "readText": null, "transcribe": null, "speak": "POPOST_TTS_CMD", "generate": null } }
```

## Programs

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
| `POPOST_GEN_CMD` (generator) | `<cmd> video\|image <request.json> <out-file>`; request `{ "prompt", "seconds"?, "aspect"?, "images"? }` | the clip or picture at out-file, and one JSON line on stdout: `{ "credits"?: number }` |

- What they change: a text reader lets `describe` read the captions (the beats) and `readback` check the render; a
  transcriber reads what is said (spoken beats) and times a voice's words; a speaker makes the voice-over
  (`plan --voice`, `template fill --speak`); a generator makes clips and pictures from prompts with
  `popost video materials` (every call may cost money: the tool must price and limit it).
- The voice argument is passed to the speaker as it is: the README beside the tool that `POPOST_TTS_CMD` names says
  which voices exist (for a male voice, pick one it calls male). `POPOST_OCR_JOBS` runs several readers side by side (default 1).
- `POPOST_CPUS=2` keeps all video work to two processors (ffmpeg threads, Chrome pages, tool threads, parts run side
  by side); unset, it is what the process may use (its affinity and its container's CPU quota), and `popost video
  doctor` prints it. Tools get it as `POPOST_TOOL_THREADS` (at most 4) unless you set that yourself.
- `POPOST_LLM_URL`, `POPOST_LLM_MODEL`, `POPOST_LLM_KEY` configure a model for `plan` without `--dry`,
  `template see` and `scene write`. An agent that writes the fill and the scenes itself does not need them. A key
  is never written to a file or printed.

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
| `template check`: `The fill has N shots; the template has M` | One entry per shot, in order; `template show` lists them. |
| `template check` / `fill`: a line over its limit or budget | Shorten the line; `fix` gives a shorter version. Do not raise `--pace`. |
| `template fill`: `Speaking the captions needs a speaker` | No speaker: run it without `--speak --keep-length --fit-tempo`. |
| `template fill`: a file is missing | Paths are relative to the project; the file must be in `project/` (`ls project/assets`). A picture in a scene's `slots` is relative to the scene file: `"../assets/x.png"`. |
| `scene check` or `check --layout`: `The picture "..." of the scene ... could not be loaded` | A path in a scene or a picture slot is wrong: it is relative to the scene file (`../assets/x.png`). The message says where the path led; do what `fix` says. |
| `scene check`: `does not fit its box: its glyphs run N px past ...` | Make the element larger (no fixed height), the text shorter, or the `line-height` larger: 1.2 for Chinese, 1.4 for Latin letters that reach below the line. |
| `scene check`: `is cut off ... X around it hides what lies outside it` | Make the element X larger or remove its fixed height, or shorten the text. |
| `scene check`: `shows the same flat picture` | Its elements are invisible (opacity, colour on the ground, outside the canvas) or its motion starts after the shot. |
| `plan --voice`: `needs a speaker` | No speaker: run `plan` without `--voice`. |
| `capture`: `The page answered HTTP 429` (or 503) | Wait a minute and run it again, or record another page. |
| `capture` notes: `the scroll does not move` | The page is shorter than the plan: scroll to a heading from `--outline` or to `"bottom"`. |
| `capture` notes: `a fixed element ... covers` | Add the selector it names to `--hide`; keep the site's header if you want it. |
| `capture` notes: `text is small` | Record again with the `--zoom` it names, or zoom to what the line is about. |
| `capture` notes: `does not enlarge` or `the zoom stops at 3` | Zoom to a smaller element (a card, not its section) or a larger one (a card, not one word). |
| `capture`: `nothing on ... matches` | Copy the selector from `--outline` exactly, or record the page that has the element. |
| `render` is slow or runs out of memory | `--scale 0.5` for a draft, or `POPOST_RENDER_PAGES=1`. |
| `No space left on device` | Set `TMPDIR` to a directory on a disk with room. |
