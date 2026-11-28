# Templates and fills

A template is the structure of a reference video, kept so that nobody needs the reference again, plus a contract that
says what may change and within which limits. A fill is the new content: two lists that line up with the template
by position. The program keeps every length, cut, transition and caption time; a fill holds no times.

## A template directory

`popost video template save <dir from describe> --out template --name <name>` writes:

| File | Holds | Read it? |
|---|---|---|
| `TEMPLATE.md` | one screen: the beats, the shots, the forms of a fill, the rules | yes (`template show` prints it as `card`) |
| `template.json` | the structure: canvas, shots with their lengths and transitions, the caption band and its beats, the kind of the reference's speech as it was confirmed (`speech`), the frame around the content when the shots had one (`TEMPLATE.md` says it) | no |
| `slots.json` | the limits of every place a fill writes | no: `template show` prints it as `slots` |
| `shots.txt` | one line per shot saying what it showed (only when `template see` was run with a model) | if present |
| `reference-text.json` | the reference's on-screen text by shot (only when describe read text) | no: `template fill` copies it into the project's record |

`--max-shot <seconds>` cuts longer shots into equal parts (for clips a generator makes). `template save` refuses a
reference whose speech kind is unconfirmed (`popost video speech-kind confirm`, video.md step 1): the beats follow the
kinds. Sung words and fragments are no beats; a beat a person said on camera is marked.

A fill has a `voice` only when the kinds include `narration`. Otherwise `template check` and `template fill` refuse
`"voice"`, `"say"` and `--speak` with the fix "leave the voice out"; `--voice-asked "<the user's words>"` lifts that
when the user asked for a narration, and `template fill` keeps the words in the project (`voice-asked.json`), so
later commands need no flag. With the files at hand they also refuse an on-camera line that no clip of the fill says.

## Slots and limits

A slot is one place a fill writes, named by its position:

- `shots[k]`: `seconds` (its length), `source` (what filled it in the reference: `footage`, `picture` or
  `colour`), `accepts` (the fills the shot takes, the closest to the source first; `scene` is last, in every shot's list), and
  `footage.seconds`: how much footage a clip must have from its `"in"` so that it does not run out.
- `captions.lines[i]`: the beat's `seconds`, `max` (characters, full-width `cjk` or `latin`), the reference's
  line as `example` with its length, `shown: false` for a beat that was only said (its line is spoken, not drawn),
  `speech: "on-camera"` for a beat a visible person said (its line is said by the person of a generated clip, whose
  request names the beat in `speech.lines`; the voice-over never reads it),
  `unsure` when the reader or the transcriber was not sure. `captions.box` is the caption band as
  `[x, y, width, height]` fractions of the canvas; `captions.capacity` was measured by laying out text in the band
  in Chrome.
- `card`: how many characters a card's title and each of its lines hold, and how many lines fit.
- With a voice, `popost video plan template --dry --voice <voice>` adds `budgets`: for each line, the most characters
  the voice can say in its beat. `template check` and `template fill` hold the lines to them with `--pace`.

## A fill

```json
{ "shots": [ { "scene": "scenes/hook.html", "slots": { "title": "..." } }, { "footage": "assets/page.mp4", "in": 0 } ],
  "captions": ["first line", "second line"],
  "voice": "<voice>" }
```

A shot is exactly one of:

| Form | Keys | Notes |
|---|---|---|
| scene | `scene`, `slots` | an HTML page in the project that draws the shot (`video-scenes.md`); a slot of an `<img>` takes a picture path relative to the scene file (`"../assets/logo.png"`) |
| footage | `footage`, `in`, `speed` (0.25 to 4), `audio` (false or -60 to 24 dB), `fit` (`cover` or `contain`), `ground` | `in` is the first frame to show; `audio`: the clip's own sound, below |
| picture | `picture`, `zoom`, `fit`, `ground` | `zoom`: growth per second (0.04 is a slow push in), not a scale |
| color | `color` | neighbouring colour shots need clearly different colours |
| card | `card`: `title`, `lines`, `background`, `color` | a title and lines that enter one after another; 1 s or more |

The sound is mixed in layers, by itself, from times the program knows (no level is measured):

- A clip made with speech (its receipt, `<file>.speech.json`): at full level while it is shown; no line of the
  voice-over may be spoken over its lines (the checks refuse that).
- Every other clip (a footage shot, a `"video"` item): the sound it came with, at its own level; lowered by 18 dB
  while a line of the voice-over or a person of another clip speaks, with ramps of 0.2 s, and back up in the pauses.
  Without a voice and without speaking people it simply plays.
- `"sound"`: under everything; lowered the same way while anybody speaks, back up in the pauses, and faded out over
  the last second when the video cuts it off.

`"audio"` on a shot overrides this for its clip: `0` or another number of dB fixes its level (no lowering under
speech), `false` mutes it. The sound plays at the clip's `speed`. Leave `"audio"` out unless a clip's sound is wrong
for the video: never mute a clip to be safe.

`"beds": [{ "footage": "assets/film.mp4", "shots": [1, 7] }]` lets the sound of one clip run on, in one piece, under
the shots cut from it (the first and the last shot, from 1): the shots under a bed do not sound themselves, so nothing
is heard twice, and shots outside it keep the rule above. `"in"` is the clip's frame the sound starts at (default: the
`"in"` of the first of those shots), `"audio"` its gain in dB. The bed plays at the clip's own speed while the shots
may be re-timed a little, so it suits music and ambience, not speech that must match lips.

`fit` decides what happens to a picture or footage whose proportions differ from the canvas's: `"cover"` (the default)
fills the shot and cuts off what lies outside it, text included; `"contain"` shows the whole file with bands of
`ground` (a colour, black by default) above and below or left and right. With the files at hand, `template check` and
`template fill` warn per shot when cover would cut more than a tenth of a file's width or height ("assets/page.png is
1280x800 in a 960x720 shot: cover cuts 8% off its left and its right"), naming the colour along the file's edges as a
ground that joins it, when a file is much smaller than the shot (it is blown up and looks soft), and when
`contain` leaves more than a tenth of the shot to a bare ground (design that shot instead: a scene with the file as a
`video` or `image` item of the shot, its `"items"`, `video-scenes.md`, "A screen inside a scene"). Better than any of them: material
made at the canvas's proportions. They also warn when one picture fills more than two shots or more than a third of the
video (a slide show), and name the capture director's zooms over it (`video-tools.md`, "Capture plans").

Any shot may also carry `"items"` (optional `span: [start, end]` uses fractions of the shot; `enter` and `exit` use native motions): clips (`"video"`) and pictures (`"image"`) drawn over it in a `box` of the canvas,
such as a screen recording in the phone a scene draws (`video-scenes.md`, "Footage inside a scene"). Fill writes them
into `video.json` as tracks during the shot, so they survive every later fill and move with the shot in a re-flow.

A shot where the source laid words over the picture (a sticker word, a heading over a recording: its titles) has
places for them: `template.json` keeps each place's box, size and frames (not the words), `slots.json` lists them as
`shots[k].words[j]` with the source's words and about how many characters a line holds, and TEMPLATE.md names them
on the shot (`words "Step one" (8)`). `"words": ["..."]` gives the places new lines in order; each is drawn where the
source's was, at its size and on its frames, white with a dark outline (its colour is not measured), and `*marks*`
highlight a word as in captions. `""` leaves a place empty; more lines than places is refused, and fill names the places
a footage, picture or colour shot leaves without a line. A card or a scene draws its own text instead.

A row of words the source kept on screen through the video, side by side (the sections of the video, the current one
marked by a plate or a colour), is a bar laid on in the edit, not a watermark: REFERENCE.md and TEMPLATE.md name it,
with the word each shot marks. `"bar": ["...", "..."]` gives it new words from the left; each is drawn in its place
through the whole video, and the word a shot marks is drawn over it on a plate in a colour that stands out (the
source's colours are not measured). More words than the source's bar has is refused.

Other keys: `captions` (one line per beat; `""` for none), `voice` and `speed` (passed to the speaker), `say`
(`[{"text": "SaaS", "as": "sass"}]`: how a word is spoken), `captionColor`, `captionOutline`, `captionSpoken`
(`true`: light up the spoken word), `captionReveal` (`"words"`: show each word when it is spoken; `"whole"`: every line whole at once; left out, the lines come on as the source's were measured to, below), `sound` (an
audio file for the whole video, relative to the project: the user's own file, taken in with `popost video music own`, or
generated music with its receipt; a file without such a record is refused. It starts with the video at its own level,
is lowered while anybody speaks (above), fades out over the last second when it is longer than the video and is not repeated when it is shorter), `beds`
(above), `note`. File paths are relative to the project. Lists are
matched by position; no times, no frames except `in`. The captions look as the reference's did when `describe` could
measure it: the colour that fills its letters (inside the outline, not the outline) on its plate (colour, opacity,
padding, corners), with its outline, or plain; a part it was not sure of has no colour in `text.json` and gets the
default; otherwise white with a dark outline. `captionColor` and `captionOutline` override that. Words wrapped in
asterisks, `"Save *50%* today"`, are drawn in the highlight colour: the reference's, when it filled a word or two of
its lines with another colour (`TEMPLATE.md` says so), else a yellow that stands out from the letters; the asterisks
are neither drawn nor spoken.

What is measured of the source's caption letters, and what follows from it:

- **Colour, outline, shadow, weight.** The fill colour is the core of the strokes, also on small or soft letters
  (30 to 45 pixels tall, where most of a stroke is edge and the commonest colour is a grey); an outline is found also
  when it has the colour of a dark picture; a shadow under an outline is kept; strokes are `heavy` or `regular`, and
  the captions of a fill are drawn in that weight.
- **How a line comes on.** `captionLook.reveal` is `whole`, `words` or `chars`, from the frames around the start of
  several lines. A fill follows it: whole lines stay whole; a source that built its lines up gets `captionReveal:
  "words"` by default when there is a voice. Do not add `"captionReveal": "words"` to a source measured `whole`
  unless the user asked: `template check` warns.
- **How many lines have a highlight.** `captionLook.highlight.share` is the share of the measured lines with a word or
  two in the highlight colour; `TEMPLATE.md` says it as "about 1 line in 4" with the number of your lines to mark.
  Mark that many: `template check` warns when the fill marks fewer than half of that share, or more than double, and
  says how many lines to mark or unmark. A warning of this kind is to be fixed, not noted.

## Commands

```bash
popost video template show template                                   # TEMPLATE.md and the slots
popost video template check template --fill fill.json [--assets project] [--pace P [--fit-tempo T]] [--voice-asked "<words>"]   # problems, each with a fix
popost video template fill template --fill fill.json --out project [--speak --keep-length --fit-tempo T] [--pace P] [--voice-asked "<words>"]
```

`template check` looks at the files only with `--assets` (the directory the fill's paths are relative to), the
pictures a fill gives a scene's picture places included (those paths are relative to the scene file). When that
directory is the project, it also holds `video.json` to the template: a caption track whose text a hand edit made much
smaller or larger than the reference's captions is a warning with both sizes in pixels. `template
fill` checks the fill, then writes `video.json`, `reference.measure.json` and `reference.facts.json` (the record the checks
compare the project with, `video-project.md`) into `--out`; it reads the fill's files
from `--out` itself (or copies them in from `--assets`) and never changes the files you put there, so it can run
again and again. `--speak` speaks the lines of the narration beats (`POPOST_TTS_CMD`; a line a person says on camera is left to its clip) and re-flows every beat to its spoken line: the
pauses between beats stay and each shot moves with the beat it falls in. `--keep-length` keeps a beat at least as
long as in the reference. `--fit-tempo T` (1 to 1.5; 1.12 is hardly heard) first speeds a line that would run over
its beat up as far as it needs, at most T times, pitch kept; only the rest re-flows, and a note per line says what
was done. With `--pace P`, `--fit-tempo T` lets each line hold T times as many characters. A line far shorter than
the reference's text of its beat is a warning: it is usually a cut that no longer says anything whole. A refused fill
prints `problems` and `repair` (the same list as one message).

## The example

`<skill>/references/video-examples/template-demo/` is a template saved from a synthetic reference (4 shots, 5 beats,
360x640) with a fill of colours, a card and English captions. To see the whole round:

```bash
popost video template show <skill>/references/video-examples/template-demo
popost video template fill <skill>/references/video-examples/template-demo --fill <skill>/references/video-examples/template-demo/fill.json --out demo
popost video render demo --out demo.mp4
```
