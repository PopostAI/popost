# The project file (video.json)

`template fill` writes `video.json`; you edit it by hand only for what a fill cannot say (a logo over every shot, a
text that appears when a word is spoken, another transition). `template fill` writes the whole file again each time
it runs, so make hand edits last, after the fill is final, and keep a copy of them. After every edit run
`popost video check <project>` (add `--layout` to measure text in the page) and look at a frame with
`popost video frame <project> --frame 45 --out f45.png`. The example that uses every feature once:
`<skill>/references/video-examples/showcase/video.json`.

## Conventions

- Every time is a whole number of frames at `canvas.fps`. Every position and size is a fraction of the canvas:
  `box: [x, y, width, height]`, origin top left.
- Paths are relative to the project directory. Ids have no spaces.
- Unknown keys are warnings and are ignored; `check` names each problem with its place and a fix.

## The parts

```json
{ "version": 1,
  "canvas": { "width": 1280, "height": 720, "fps": 30 },
  "materials": [ { "id": "page", "kind": "video", "file": "assets/page.mp4" } ],
  "segments": [ { "id": "shot-01", "frames": 105, "base": { "scene": "scenes/shot-01.html" } },
                { "id": "shot-02", "frames": 105, "base": { "material": "page" }, "in": { "transition": "dissolve", "frames": 8 } } ],
  "tracks": [ { "id": "logo", "type": "text", "text": "popost", "box": [0.82, 0.04, 0.14, 0.06],
                "during": { "segment": "shot-01", "from": 10 }, "style": "label", "enter": { "preset": "fade" } } ] }
```

- **Material**: a file the project uses, with an `id`: `kind` is `image`, `video`, `audio` or `font`; an audio
  material may name a `words` file (the time of every spoken word, written by `--speak`).
- **Segment**: one shot, in order; the video is the segments one after another, each `frames` long. Its **base** is
  what fills it: `{ "color": "#101014" }` (or a gradient: `{ "type": "linear", "angle": 160, "stops": [ { "at": 0,
  "color": "#1b1f3b" }, { "at": 1, "color": "#e94e77" } ] }`), `{ "material": "<id>", "fit": "cover" }` for a picture
  or footage (footage also takes `in`, `speed`, `audio`: a gain in dB or `false`; left out, its own sound is kept only in
  a project with no `audio` track; a picture a `camera`: `{ "zoom": 0.04 }` or keyframed
  `moves`), or `{ "scene": "scenes/x.html", "slots": { ... } }`.
- **Transition**: the segment's `in`, the change from the shot before: `transition` is one of `cut`, `fade`,
  `flash`, `dissolve`, `wipe`, `slide`, `zoom`, `spin`, `blur`, `glitch`, `shake`, `whip`, with `frames` and,
  by kind, `direction`, `mode` (`push`, `cover`, `reveal`), `via` (`black`, `white`), `side`, `strength`. A
  transition overlaps the cut; it never changes the length of the video.
- **Track**: something laid over the segments. `text`, `image`, `shape` and `video` tracks are items with a
  `box`, a `during`, and optionally `enter` / `exit` (`preset`: `none`, `fade`, `pop`, `scale-in`, `slide`,
  `wipe`, `type`, `blur`), a `loop` (`pulse`, `float`, `sway`, `blink`, `spin`), `rotate`, `opacity`,
  `border`, `shadow`, `z`. A text's `style` is a name (`headline`, `subtitle`, `label`, `caption`) or an object
  (`size` as a fraction of the canvas height, `weight`, `color`, `align`, `stroke`, `background`, `spans`, ...).
  A `caption` track holds `cues`, each a `text` with its own `during`. An `audio` track plays a material, with
  `gain` in dB.
- **During**: when an item is on screen. `{ "segment": "shot-02", "from": 4, "to": 60 }` counts frames from the start
  of that segment (`to` may run past its end). `{ "phrase": "every word on time", "lead": 4, "hold": 10 }` puts it on
  the words of a voice that has a words file, so it moves with the voice.

## The record of the reference (reference.facts.json)

`template fill` also writes `reference.facts.json`, written again with every fill: the template the project was filled
from (`template.dir`, from the project directory), the caption band and the size of its letters (`captions`), and for
every reference shot the segment made of it, its length in the reference's frames, what it most likely is (`looks`),
the share of its middle picture that is not ground (`fill`, when describe measured it) and the text the reference
showed in it (`text`, when describe read text). The checks compare the project with it: `popost video check` holds
the captions' size to the reference's, and `scene check` holds each scene's `fill` to its shot's and warns about the
reference's own words and figures. Never edit it, and never take words or numbers from it: they are the reference's.
A project made by hand has none, and every check works without it.
