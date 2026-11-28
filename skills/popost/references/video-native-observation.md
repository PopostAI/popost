# Actual speech in native clips

A generated clip's `.speech.json` preserves what was **requested** and locks its video/audio provenance. A requested line at 2.5 seconds does not establish that the model waited 2.5 seconds. Keep this receipt unchanged.

For a new strict replication project, transcribe each actual speaking clip, then import its independent observation:

```sh
popost video transcript P/assets/take.mp4 --language en --project P --out P/drafts/take-actual.json --confirm --max-credits N
popost video replication observe P --media P/assets/take.mp4 --transcript P/drafts/take-actual.json
```

Use the current account, live quote and remaining finite budget for transcription. Importing an existing observation is local and free. The import writes `take.mp4.speech-observed.json`, retaining the real media SHA-256, native frame clock, original ASR file hash and its independent clock. A transcript at 25 FPS over video at 24 FPS means `word.start / 25` seconds, not `word.start / 24`. The compiler then maps those seconds through the actual source in-point, playback speed and target FPS. It uses these observed intervals for dialogue detection, overlap checks and music ducking; picture and embedded audio still share one trim/speed.

A missing observation may render a first draft. Strict drafts conservatively protect the entire speaking clip until its timing is observed, rather than advertising the requested slots as actual timing. A malformed, stale or changed observation is an error and never silently falls back to requested slots. Legacy projects and clips without speech retain their existing behavior.

ASR estimates audible word times. It does not prove that the words are correct or that the visible mouth says them. Inspect the actual clip's audio and at least two distinct frames during articulation. Save that internal review as JSON, with the actual values from the inspected media:

```json
{
  "words": "passed",
  "articulation": "passed",
  "evidence": [
    {"kind":"observed","detail":"Describe the actual audible words checked.","file":"assets/take.mp4","sha256":"ACTUAL_64_HEX_VIDEO_SHA256","media":"video","at":[0.08,3.2]},
    {"kind":"observed","detail":"Describe the first inspected articulation state.","file":"assets/take.mp4","sha256":"ACTUAL_64_HEX_VIDEO_SHA256","media":"video","frame":3},
    {"kind":"observed","detail":"Describe a different articulation state.","file":"assets/take.mp4","sha256":"ACTUAL_64_HEX_VIDEO_SHA256","media":"video","frame":70}
  ]
}
```

The example is a shape, not a ready-made verdict; use the real frame indices and audible intervals. Use `unknown` or `failed` when either finding is unresolved. Evidence paths are relative to the project. A locked extracted audio file can support the words review; the articulation samples must refer to this exact native video. Preserve any recognizer mistakes in the raw ASR file and explain the actual listening result in the review rather than pretending the request proves it.

```sh
popost video replication observe P --media P/assets/take.mp4 --transcript P/drafts/take-actual.json --review P/drafts/take-review.json
popost video replication timeline P --out P/drafts/actual-timeline.json
```

Strict final acceptance requires the hash-bound actual timing plus both reviewed words and articulation. An ASR file, a requested receipt or a text-only `passed` note is insufficient. `template fill --assets` copies the separate observation and its bound ASR/review evidence, including bed clips, so moving the project or refilling does not discard the observation. Changed media, ASR or evidence must be re-inspected and imported before a new final review.
