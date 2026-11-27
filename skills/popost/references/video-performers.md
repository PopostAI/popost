# People and shared voices

Use these rules for every generated video, including product demonstrations, explainers, dramatic scenes and mixed footage. A reference provides structure and an archetype; it does not grant an instruction to reproduce its creator.

## Choose identity by role and recurrence

Inventory the visible roles and the generated clips where each appears before requesting media. Follow the user's explicit character requirements and supplied/selected character material first. Without those, use a new fictional person with a similar role, age range, energy and presentation style, but different facial proportions and features. Similar mood is not permission to reproduce the reference face.

Instructions such as "keep the male presenter", "retain the avatar window", or "preserve the host's timing, position, size and crop" describe the format. They do **not** select the original person's identity, even when copied into `permission`. Do not extract that person's face as the new cast image, attach their portrait to the image generator, or ask the model to preserve their facial features. Describe the archetype in words and generate an independent face. Review the actual result against the reference before generating the clips; changing only hair, glasses or clothing is insufficient.

Preserve a reference person's identity only for an explicit same-person request, such as "use this same person from my reference". In that case set `identity: "reference"`, `referenceSelection: "same-person"`, and quote the actual identity instruction in `permission`. Legacy `permission` text alone no longer authorizes this route. Do not add this selection merely to make an old manifest pass: reassess the original instruction and use `identity: "new"` for format-only requests. A supplied character picture instead uses `identity: "user"` and its actual material.

A new role in one generated clip can be defined directly in its video prompt; do not generate an identity image unnecessarily, even if that clip contains several shots or is cut into several timeline segments. A role in multiple generated clips uses one reviewed identity image for every clip; do not generate a different face per clip. Different people have separate role ids and images. Identity, wardrobe, product and scene references have distinct jobs.

Write `project/cast.json`:

```json
{"version":1,"roles":[
 {"id":"host","description":"A fictional adult presenter with short wavy hair, round glasses and an olive overshirt","identity":"new","shots":["opening","closing"]}
]}
```

`popost video cast prepare project --requests materials.json` counts independent generation requests and prints the necessary host image jobs. Without a request list, `shots` is a conservative estimate of recurrence. For recurring roles, actually use the host image generator without the original person's portrait, inspect its output and import it with `popost video cast complete project --role host --file generated.png --tool image_gen`. User/library identities require their actual selected picture. A new role in one generated clip can leave `image` absent. The materials command also counts role uses across its request list.

Each video material lists `"cast":["host"]`; `[]` explicitly means no visible person. Send the generated identity pictures, product assets and measured motion descriptions to the video model. Do not send the raw original creator's video as a generation reference: a model may copy its face despite a text instruction. The engine refuses this combination. Keep role ids stable; a different identity or voice uses a new output filename rather than silently reusing a previous clip.

Before delivery, inspect the opening, later appearances and each new clip boundary. Check both requirements separately: the person is visibly different from the reference and is consistent with the new cast image throughout the result. Record any drift honestly; a valid manifest or image hash does not prove visual identity quality.

## Visible speech has one final audio source

When the audience can see somebody say the words, use one of two explicit paths:

- Native: `"speech":{"mode":"native","speaker":"host","text":"The exact final words"}`. Generate the performance and speech together. Its embedded audio is authoritative. Do not add a different TTS voice later, fit a replacement voice to independently timed mouth motion, or stretch the two separately. After generation the engine extracts and hashes its actual audio and writes a speech receipt. Read back the words and inspect articulation; a receipt is provenance, not a phoneme-quality score.
- Audio first: generate the final voice, then use `"speech":{"mode":"lip-sync","speaker":"host","text":"The exact final words","audio":"assets/dialogue.wav"}`. A real `POPOST_LIPSYNC_CMD` must synchronize the performance to that exact audio. Merely supplying audio to a general video model is not a verified lip-sync operation. Without that capability the request stops before generation; it never silently publishes unrelated dubbing. The tool contract is `<command> <request.json> <out.mp4>` with `{video,audio,text,speaker}`. It must return a real synchronized clip. The engine verifies duration and muxes the final audio without independently retiming the video.

Render checks require the locked clip's audio, in-point, cuts and speed to agree with its visible performance. For a silent B-roll shot, an off-screen narration track does not need lip sync. For several visible speakers, identify who speaks each line and synchronize their performances independently.

## One timbre across a mixed video

Use one project-wide speaker profile for a visible host and the voice-over on demonstrations or screen recordings. Register a user-supplied voice with `popost video voice add project --speaker host --file voice-reference.wav`. An existing preset/clone can also be recorded with `--provider-voice ID`. `voices.json` records the actual reference file and hash.

With a connected popost.ai account, its voices are the first choice for voice-over and dialogue (no local speaker needed, word times included); a speaker of the user's own (`POPOST_TTS_CMD`, `POPOST_VOICE_CMD`) remains an option. Read the live catalog with `popost video voice list`. It includes published official voices and the account's personal voices, with playable preview URLs and clone state; `--scope mine` lists only the personal ones, `--scope official` only the official ones (default `all`). Names and defaults come from the platform; never embed a copied catalog or upstream clone ids in the Skill. Honour the user's chosen voice. Otherwise use `default-male` for a male speaker or `default-female` for a female speaker; without a gender requirement use `default-male`. A missing configured default is an error, not permission to substitute another voice.

```bash
popost video voice use project --speaker host --voice default-male
popost video voice quote --voice default-male --text "Final words"
popost video voice speak project --speaker host --text "Final words" --out project/assets/line.wav --confirm --max-credits <what is left>
```

`voice speak` also writes `project/assets/line.wav.words.json` when the platform returns word times (it prints `words`): the time of each Chinese character or Latin word, in seconds from the start of the WAV. `template fill --speak` and `retarget --speak` with a `popost:` voice time the captions word by word with these times, so they need no transcriber for it.

`use` downloads the real preview and binds the platform voice id to the project profile. Official voices are already cloned; personal uploads are cloned on first actual speech use and the platform reuses that mapping afterwards. Listing, selection and quoting do not clone or charge. Speech is paid as images are, within the one budget of the video (`video.md`, money rule): the voice-over is in the cost overview (a `voice quote` of the script), and `voice speak` runs with `--confirm --max-credits <what is left>` and prints `chargedCredits`. Without `--confirm`, or above `--max-credits`, it speaks nothing and ends with exit code 3 and the price; ask the user only when the price is more than what is left. Each command enforces its own ceiling; there is no server-side or project-file budget. The resulting WAV and receipt are real synthesis results. Use this exact audio for voice-over and visible lip-sync shots.

For template narration and `plan --voice`, pass `popost:default-male`, `popost:default-female` or `popost:VOICE_ID`, and add `--confirm --max-credits <what is left>` to `plan --voice`, `template fill --speak` and `retarget --speak`: each prices all its lines first (and the pace-calibration sentence, once per voice) and counts its ceiling down line by line. Pace calibration synthesizes audio even with `--dry`; it is not a free preview. A custom `POPOST_TTS_CMD` stays selected unless the voice explicitly starts with `popost:`. Repeating the same text, speed and output path uses the same operation key; an unknown result must be reconciled before making a new paid attempt.

The default is `audio-first`. Configure `POPOST_VOICE_CMD` to a synthesizer that actually supports the supplied timbre/clone, then run `popost video voice speak project --speaker host --text "Final words" --out project/assets/line.wav`. Its contract is `<command> <request.json> <out.wav>`; the request has `{text,speaker,referenceAudio,voice?}`. It writes real speech, using the same profile for every line. Do not fall back to an unrelated system voice when cloning is unavailable. Voice-over plays these files directly; visible-mouth shots lip-sync to them. Plan cuts from the resulting audio lengths rather than forcing dialogue into arbitrary video lengths.

An available host voice service can be used directly instead: give it the registered sample or the same preset/clone id for all lines, actually synthesize the requested words, inspect the result, and import it with `popost video voice complete project --speaker host --text "Final words" --file actual-result.mp3 --out project/assets/line.mp3 --tool actual-host-tool`. This path needs no local synthesizer command. A receipt binds the real imported result to the profile; never claim a default voice was cloned.

`--mode native-reference` is an explicit alternative when the video model supports reference-audio timbre conditioning. The materials command supplies the same registered voice sample to each native-speaking request and asks for the new script, not the sample's words. Check both the spoken words and timbre across native and voice-over sections. Reference conditioning is probabilistic; use audio-first when continuity must be strict. The mode is never an automatic fallback after missing voice synthesis or lip sync.

Upload/generation providers keep their own capability checks and fees. Registering a sample does not authorize paid synthesis, clone creation or generation.

## A personal voice from the user's recording

When the user wants their own voice (or a speaker's who agreed), make a personal voice from a recording of that one person speaking clearly, alone and without music:

```bash
popost video voice create --file recording.m4a --name "Lena" --language en --consent
```

`--consent` is required and states that the user owns this voice or has the speaker's permission to make a voice of it. Ask the user for that statement in these words; never add `--consent` on your own, and never make a voice of a reference creator, a public figure or anyone else who has not agreed. `--file` is an audio or a video file; its sound becomes the sample: one channel, 16-bit PCM WAV at 24 kHz, 10 to 60 s (a shorter recording is refused; a longer one is cut to 60 s from `--start SECONDS`, default 0), at most 10 MB. `--language` is `zh` or `en`, `--description` an optional note (at most 500 characters), `--name` 1 to 100 characters. The command prints the voice as the catalog lists it (`voice.id`, `cloneState`) and the sample's length. Running the same command again does not make a second voice. The platform refuses with a readable `error` when the plan allows no more personal voices (`VOICE_PLAN_LIMIT`): tell the user, do not retry. Making a personal voice needs a paid plan; the command itself does not charge, and speech with the voice is quoted and confirmed like any other.

The new voice appears in `popost video voice list` (and `--scope mine`) and is used exactly like an official one: `voice use project --speaker host --voice <id>`, `voice quote --voice <id>`, `voice speak`, and `popost:<id>` for `plan --voice` and `template fill --speak`.
