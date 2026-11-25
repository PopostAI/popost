# People and shared voices

Use these rules for every generated video, including product demonstrations, explainers, dramatic scenes and mixed footage. A reference provides structure and an archetype; it does not grant an instruction to reproduce its creator.

## Choose identity by role and recurrence

Inventory the visible roles and the shots where each appears before requesting media. Prefer the user's supplied character or selected library character. Preserve a reference person's identity only when the user explicitly requests it: record the actual instruction in `permission`.

Otherwise use a new fictional person. A role appearing once can be defined directly in the video prompt; do not generate an identity image unnecessarily. A role recurring in several clips or shots uses one approved identity image across those appearances. Different people have separate role ids and images. Identity, wardrobe, product and scene references have distinct jobs.

Write `project/cast.json`:

```json
{"version":1,"roles":[
 {"id":"host","description":"A fictional adult presenter with short wavy hair, round glasses and an olive overshirt","identity":"new","shots":["opening","closing"]}
]}
```

`popost video cast prepare project` prints host image jobs. For recurring roles, actually use the host image generator, inspect its output and import it with `popost video cast complete project --role host --file generated.png --tool image_gen`. User/library identities require their actual selected picture. A new single-appearance role can leave `image` absent. The materials command also counts role uses across its request list.

Each video material lists `"cast":["host"]`; `[]` explicitly means no visible person. Send the generated identity pictures, product assets and measured motion descriptions to the video model. Do not send the raw original creator's video as a generation reference: a model may copy its face despite a text instruction. The engine refuses this combination. Keep role ids stable; a different identity or voice uses a new output filename rather than silently reusing a previous clip.

## Visible speech has one final audio source

When the audience can see somebody say the words, use one of two explicit paths:

- Native: `"speech":{"mode":"native","speaker":"host","text":"The exact final words"}`. Generate the performance and speech together. Its embedded audio is authoritative. Do not add a different TTS voice later, fit a replacement voice to independently timed mouth motion, or stretch the two separately. After generation the engine extracts and hashes its actual audio and writes a speech receipt. Read back the words and inspect articulation; a receipt is provenance, not a phoneme-quality score.
- Audio first: generate the final voice, then use `"speech":{"mode":"lip-sync","speaker":"host","text":"The exact final words","audio":"assets/dialogue.wav"}`. A real `POPOST_LIPSYNC_CMD` must synchronize the performance to that exact audio. Merely supplying audio to a general video model is not a verified lip-sync operation. Without that capability the request stops before generation; it never silently publishes unrelated dubbing. The tool contract is `<command> <request.json> <out.mp4>` with `{video,audio,text,speaker}`. It must return a real synchronized clip. The engine verifies duration and muxes the final audio without independently retiming the video.

Render checks require the locked clip's audio, in-point, cuts and speed to agree with its visible performance. For a silent B-roll shot, an off-screen narration track does not need lip sync. For several visible speakers, identify who speaks each line and synchronize their performances independently.

## One timbre across a mixed video

Use one project-wide speaker profile for a visible host and the voice-over on demonstrations or screen recordings. Register a user-supplied voice with `popost video voice add project --speaker host --file voice-reference.wav`. An existing preset/clone can also be recorded with `--provider-voice ID`. `voices.json` records the actual reference file and hash.

The default is `audio-first`. Configure `POPOST_VOICE_CMD` to a synthesizer that actually supports the supplied timbre/clone, then run `popost video voice speak project --speaker host --text "Final words" --out project/assets/line.wav`. Its contract is `<command> <request.json> <out.wav>`; the request has `{text,speaker,referenceAudio,voice?}`. It writes real speech, using the same profile for every line. Do not fall back to an unrelated system voice when cloning is unavailable. Voice-over plays these files directly; visible-mouth shots lip-sync to them. Plan cuts from the resulting audio lengths rather than forcing dialogue into arbitrary video lengths.

An available host voice service can be used directly instead: give it the registered sample or the same preset/clone id for all lines, actually synthesize the requested words, inspect the result, and import it with `popost video voice complete project --speaker host --text "Final words" --file actual-result.mp3 --out project/assets/line.mp3 --tool actual-host-tool`. This path needs no local synthesizer command. A receipt binds the real imported result to the profile; never claim a default voice was cloned.

`--mode native-reference` is an explicit alternative when the video model supports reference-audio timbre conditioning. The materials command supplies the same registered voice sample to each native-speaking request and asks for the new script, not the sample's words. Check both the spoken words and timbre across native and voice-over sections. Reference conditioning is probabilistic; use audio-first when continuity must be strict. The mode is never an automatic fallback after missing voice synthesis or lip sync.

Upload/generation providers keep their own capability checks and fees. Registering a sample does not authorize paid synthesis, clone creation or generation.
