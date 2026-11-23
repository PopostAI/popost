# A text reader for the development loop

Not part of the engine. The engine reads on-screen text through an interface (`src/video/text/types.ts`, `TextReader`); in
development, `POPOST_OCR_CMD` names a command that implements it (`src/video/text/reader-command.ts` has the file formats).
This directory is one such command, on RapidOCR: PP-OCR models through onnxruntime, CPU only, Apache-2.0, about 15 MB
of models inside a 330 MB virtual environment. In the product the same interface is implemented by a server task.

```bash
python3 -m venv ~/.local/share/popost-ocr/venv
~/.local/share/popost-ocr/venv/bin/pip install rapidocr-onnxruntime
export POPOST_OCR_CMD="$HOME/.local/share/popost-ocr/venv/bin/python -I $PWD/skills/popost/tools/video/ocr-rapidocr/ocr.py"
popost video text <video>          # cues with roles
popost video describe <video> --out <dir>
```

Measured on 2026-11-20 on an 8-core arm64 machine: about 0.45 s per 1280x720 frame, so a video read at five frames a
second costs a little over two seconds per second of video. On one real 17.8 s reference it read all 11 caption
lines; one of them with one wrong character.
