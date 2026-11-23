#!/usr/bin/env python3
"""A transcriber for the video engine's development loop, on faster-whisper (CTranslate2, CPU).

Not part of the engine: the engine calls whatever POPOST_ASR_CMD names (see src/speech/index.ts).
Set up once, outside the repository:

    python3 -m venv ~/.local/share/popost-asr/venv
    ~/.local/share/popost-asr/venv/bin/pip install faster-whisper
    export POPOST_ASR_CMD="$HOME/.local/share/popost-asr/venv/bin/python -I <repo>/packages/video/tools/asr-faster-whisper/asr.py"

Called as: asr.py <audio.wav> <out.json> [language]
  audio.wav  16 kHz, mono, 16-bit
  out.json   {"language": "zh", "words": [{"text": "...", "start": 1.02, "end": 1.16, "confidence": 0.99}]}
The model is chosen by POPOST_ASR_MODEL (default "small"; it is downloaded on first use).
"""
import json
import os
import sys
import wave


def main() -> int:
    if len(sys.argv) not in (3, 4):
        print("usage: asr.py <audio.wav> <out.json> [language]", file=sys.stderr)
        return 2
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    from threads import threads

    for name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
        os.environ.setdefault(name, str(threads("POPOST_ASR_THREADS")))
    import numpy as np
    from faster_whisper import WhisperModel

    with wave.open(sys.argv[1], "rb") as wf:
        if wf.getframerate() != 16000 or wf.getnchannels() != 1 or wf.getsampwidth() != 2:
            print("the audio must be 16 kHz, mono, 16-bit", file=sys.stderr)
            return 2
        # The samples are handed over as an array: the library's own file decoder is not needed.
        audio = np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    model = WhisperModel(os.environ.get("POPOST_ASR_MODEL", "small"), device="cpu", compute_type="int8",
                         cpu_threads=threads("POPOST_ASR_THREADS"))
    language = sys.argv[3] if len(sys.argv) == 4 else None
    segments, info = model.transcribe(audio, language=language, word_timestamps=True, vad_filter=True, beam_size=5)
    words = []
    for segment in segments:
        for w in segment.words or []:
            words.append({"text": w.word, "start": round(w.start, 3), "end": round(w.end, 3), "confidence": round(w.probability, 3)})
    with open(sys.argv[2], "w", encoding="utf-8") as fh:
        json.dump({"language": info.language, "words": words}, fh, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
