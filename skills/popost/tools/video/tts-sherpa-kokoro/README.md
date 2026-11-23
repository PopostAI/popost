# A speaker for the development loop

Not part of the engine. The engine has lines spoken through an interface (`src/video/voice/index.ts`, `Speaker`); in
development, `POPOST_TTS_CMD` names a command that implements it. This directory is one such command, on sherpa-onnx
with the Kokoro multi-language model (Apache-2.0, about 330 MB, CPU). It is a stand-in so that the whole loop can run
on one machine; the product's voices come from a speech vendor through the same interface.

```bash
python3 -m venv ~/.local/share/popost-tts/venv
~/.local/share/popost-tts/venv/bin/pip install sherpa-onnx soundfile
cd ~/.local/share/popost-tts
curl -L -O https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2
tar xjf kokoro-multi-lang-v1_0.tar.bz2
export POPOST_TTS_MODEL="$HOME/.local/share/popost-tts/kokoro-multi-lang-v1_0"
export POPOST_TTS_CMD="$HOME/.local/share/popost-tts/venv/bin/python -I <repo>/skills/popost/tools/video/tts-sherpa-kokoro/tts.py"
popost video retarget <reference-dir> --plan plan.json --out <project-dir> --speak
```

Measured on 2026-11-20 on an 8-core arm64 machine: a 4.5 s Chinese sentence in about 5 s. By pitch, voices 49 and 52
are male (about 130 Hz) and 47 and 51 female. A word the model's lexicon lacks is skipped without an error: a brand
name has to be given a spoken form (`"say": [{ "text": "Popost", "as": "pop post" }]` in the plan).
