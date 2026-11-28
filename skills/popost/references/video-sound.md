# Video sound: voice, music, clip sound and effects

Read this before you plan the sound of a video: the voice-over, the music, what each generated clip sounds like, and
the effects. The programs hold a project to these rules (`popost video check`, `materials`, `render`); this page says
why and what to do.

## The five rules

- **R1. One lead voice at any moment.** A clip in which the video's speaker talks plays at full level, and no
  voice-over lies over it. While the voice-over speaks, the sound of the clips under it is lowered by 18 dB, with
  ramps of 0.2 s, and comes back in its pauses.
- **R2. One music source at any moment.** By default the video has one music bed for its whole length: the user's
  own file first; else one generated track when the reading of the reference has music; none when the reference has
  none. Clips are asked for speech, ambience and effects only, never music.
- **R3. Every clip has a sound mode**: `speech`, `exhibit`, `ambience` or `silent` (below). It decides the end of the
  clip's prompt, whether it is made with a sound track, and how it is mixed.
- **R4. Music made by a clip is an exception** with a recorded basis, shown to the user with the plan: (a) one
  continuous clip with no cut; (b) the reference changes its music per segment on purpose (then no bed there); (c)
  music in the scene; (d) singing or lip-sync; (e) a short brand sting; (f) the user's own filmed footage; (g) the
  user's explicit wish.
- **R5. Music and voice follow the reading of the reference, not taste.** A voice-over only when the reference has
  narration or the user asked for one; music only when the reference has music or the user asked for it; none where
  the reference has music only when the user said so.

Kept on purpose: the timed lines in the prompt of a clip that re-makes a speaking shot (`video-performers.md`), and
the check that a clip really said its lines (below).

## Sound modes of a clip

A material request names its clip's sound mode in `"sound"`; a use of the clip on the timeline may name another in
`"soundMode"` (on a segment base or a video item).

| Mode | What the clip is | Prompt | Mix |
|---|---|---|---|
| `speech` | its person is the video's speaker | the voice leads, clear and close, over the quiet sound of the place; no music | full level; no voice-over over it (R1) |
| `exhibit` | the thing shown (a song, a demo, a performance): all its sound belongs to it | left free | lowered 18 dB under the voice-over, full level in its pauses; the bed gives way |
| `ambience` | a place or an action: its sound, nobody speaks | only the sound of the place and of what happens; no voice, no music | lowered 18 dB under every voice |
| `silent` | B-roll under a narrator, never heard | nobody speaks to the camera | not heard |

Left out, the mode is inferred: a request with `"speech"` lines is `speech`; in a re-make of a reference whose
speech is narration and whose places are not heard (`materials --template`, from the reading), a clip without lines
is `silent`; any other clip is `ambience`. `"sound": "speech"` without lines, and `"silent"` or `"ambience"` with
lines, are refused before anything is paid.

A `silent` clip is asked for without a sound track (`generateAudio: false`) only on a model whose
`audioOptional` is true (`popost video generate --models`); any other model makes its track as usual and
`materials` takes it out of the file. The mode is kept beside the clip, `<clip>.mode.json`, and the mix reads it; a
clip made before it was named keeps its file and gets the receipt. A clip made without sound has no audio stream at
all: everything that reads a clip's sound (the mix, the render, the Studio, the draft export, the checks) takes it as
silence. A speaking clip that comes back that way says nothing: materials and `speech-check` report it, with a
remake to offer.

## The music plan

Agree the music with the user in the cost overview of `video.md` (the end of step 1), before any clip is made, and
record it:

```bash
popost video music plan --project project --reading ref                 # prints what the reading proposes, free
popost video music plan --project project --music generated --style "<genre, mood, tempo, instruments>"
popost video music plan --project project --music own                   # the user's file (popost video music own)
popost video music plan --project project --music none
```

- `--reading` is what describe wrote (its `sound.json`) or the template; without it the plan reads the template the
  project was filled from. Without `--music` the command prints the plan on record, or the proposal: `own` when a
  file of the user's is in `assets/`; `generated` when the reference has music (with the quote's credits); `none`
  when it has none; `ask` when the reading cannot tell (ask the user, or run describe with the sound analysis).
- A plan that departs from the reading (generated music where the reference has none, none where it has some) needs
  the user's own words: `--asked "<their words>"`. `own` is always allowed.
- Generated music needs a connected account. When popost.ai's music generator is not available (its quote answers
  HTTP 503, nothing is charged), the plan has no generated bed and says so in one line (`unavailable`); the user's
  own file still works. Say it once to the user; nothing waits for the generator or asks it again.
- `music plan` prints `show`: the lines to put in front of the user with the other items and the price.

### Exceptions: music made by a clip (R4)

```bash
popost video music plan --project project --clip-music assets/band.mp4 --basis c --why "<what the reading says, or the user's words>"
popost video music plan --project project --clip-music all --basis a --why "the reference is one continuous take"
popost video music plan --project project --drop-clip-music assets/band.mp4
```

`--basis` takes the letter (a to g) or its name: `single-clip`, `per-segment`, `in-scene`, `sung`, `brand-sting`,
`own-footage`, `user-wish`. `--clip-music all` records an exception for the whole video; (a) is always for the
whole video. The record goes into `music-plan.json` with its words, `show` lists it, and `materials` lists the
exceptions its clips use in its price (`confirm.clipMusic`). A clip under a recorded exception is asked for without
the sentence about music; a request may also name it, `"clipMusic": "in-scene"`, which is refused while no such
exception is on record.

In the mix the bed gives way altogether (60 dB, ramps of 0.5 s) while a clip with music of its own is heard (an
`exhibit`, or a clip made under an exception), and comes back after it. With (a), or (b) for the whole video, the
video has no bed: a music track is refused. `check` also refuses two music tracks at once, a bed whose `"gain"`
keeps it up under such a clip, two clips with music heard together, and a transition over words a person says on
camera (cut speaking clips hard).

## Generated music

With a connected account, `popost video music quote` prices a track and `popost video music make` makes it, paid
in credits as every other paid command (`--confirm --max-credits <left>`). The quote names the tier that will make
it (`model`) and the longest track it makes (`maxTrackSeconds`); a video longer than the longest track popost.ai
makes is refused with that maximum (`maxSeconds`): give the length of the part that has music, or leave the music to
the user. popost.ai returns a whole track and is asked for instrumental music and a length in words, so the track
can be longer than asked: `make` cuts it to the video's length with a fade-out of 1 s and records both lengths in
its receipt. Details of the commands: `video-tools.md`, "Generated music".

## One voice per character: the voice sample

Every speaking clip of a character gets one reference sound of that character's voice, and the voice-over of the
same character is spoken with the same registered voice, so the person sounds alike on camera and off. The sample
(`assets/voices/<id>.sample.wav`, 2 to 10 s) is cut from the registered voice by default; cut it from a recording
the user gave or from an approved clip in which the person speaks with:

```bash
popost video voice sample project --speaker host --from <recording or clip> [--start 3.2 --end 9.0]
```

Without `--start`/`--end` it takes the cleanest run of speech. A clip of several speakers gets each one's sample,
shorter so that they fit the model's reference sounds together; a model that takes fewer reference sounds than a
clip needs is refused before anything is uploaded or paid.

## Did the clip say its lines: the speech check

A model speaks the lines of its prompt, but not always all of them, and not exactly in their slots. After speaking
clips are made:

```bash
popost video speech-check project                                     # prices popost.ai's transcription: exit code 3
popost video speech-check project --confirm --max-credits <left>
```

Each clip with a script is transcribed once (the user's own transcriber, or popost.ai's, priced first), and its
words are held against the script: a clip that says less than 80% of its words is an error (`speech-not-as-written`)
that names what is missing; show the user and the price of a remake, and make it again only after their yes
(`materials --approve-unplanned <key>`). The measured word times go into the clip's receipt: the mix lowers other
sound on what was really said, and `template fill` puts the caption of each spoken line on the time it was said.

## Sound effects: the `sfx` item

An effect is an audio track of role `sfx`, placed by the frame its file starts on:

```json
{ "id": "sfx-1", "type": "audio", "material": "audio-whoosh", "role": "sfx", "at": 48, "gain": -6, "cue": "title slam" }
```

- `material`: an audio material (`{ "id": "audio-whoosh", "kind": "audio", "file": "assets/sfx/whoosh.wav" }`).
- `at`: the frame of the video the effect starts on (an integer, inside the video). It plays to the end of its file;
  `during` instead of `at` places it on a span as any audio track, and with both, `at` is its start and the span its end.
- `gain`: its level in the mix, in dB (default 0). It sits above the music and below speech: while the voice-over or
  a person of a clip speaks it comes down 6 dB, ramps of 0.2 s.
- `lead: true`: the effect is the lead of its moment and keeps its level under speech.
- `cue`: the event it was placed for, for the record; `fadeOut` as on any audio track.
- In a project made from a reference, an effect's file has a record of where it came from like any other sound
  (`<file>.sfx.json`, written by the command that brought the effect in).
- The effects catalogue lists free effects (CC0) by name and use, served from popost.ai's public storage.
