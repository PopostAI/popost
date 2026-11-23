# A transcriber for the development loop

Not part of the engine. The engine reads speech through an interface (`src/video/speech/types.ts`, `Transcriber`); in
development, `POPOST_ASR_CMD` names a command that implements it (`src/video/speech/index.ts` has the file format). This
directory is one such command, on faster-whisper (CTranslate2, CPU, MIT; the Whisper models are downloaded on first
use: "small" is about 480 MB). In the product the same interface is implemented by a server task.

The first run downloads the model and can take many minutes (15 on one new machine, at 19% CPU): run it once on a
short clip before timing anything. Its threads come from `POPOST_TOOL_THREADS`, which the engine sets from its CPU
budget (`POPOST_CPUS`), at most four unless you set it yourself.

```bash
python3 -m venv ~/.local/share/popost-asr/venv
~/.local/share/popost-asr/venv/bin/pip install faster-whisper
export POPOST_ASR_CMD="$HOME/.local/share/popost-asr/venv/bin/python -I $PWD/skills/popost/tools/video/asr-faster-whisper/asr.py"
popost video transcript <video> --language zh
```

Measured on 2026-11-20 on an 8-core arm64 machine with the "small" model: 17.8 s of Chinese speech in 5.9 s, with a
time and a confidence for every word. Ordinary words were right; a product name and a brand name were misheard, with
low confidence. Where the video has captions, the caption is the better spelling and the transcript is the better
clock: the description (`popost video describe`) shows both.
