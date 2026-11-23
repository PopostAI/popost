#!/usr/bin/env python3
"""A speaker for the video engine's development loop, on sherpa-onnx with the Kokoro multi-language model (CPU).

Not part of the engine: the engine calls whatever POPOST_TTS_CMD names (see src/voice/index.ts).
Set up once, outside the repository:

    python3 -m venv ~/.local/share/popost-tts/venv
    ~/.local/share/popost-tts/venv/bin/pip install sherpa-onnx soundfile
    cd ~/.local/share/popost-tts
    curl -L -O https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2
    tar xjf kokoro-multi-lang-v1_0.tar.bz2
    export POPOST_TTS_MODEL="$HOME/.local/share/popost-tts/kokoro-multi-lang-v1_0"
    export POPOST_TTS_CMD="$HOME/.local/share/popost-tts/venv/bin/python -I <repo>/packages/video/tools/tts-sherpa-kokoro/tts.py"

Called as: tts.py <text.txt> <out.wav> [voice] [speed]
  voice  a speaker number of the model (default POPOST_TTS_VOICE, else 50)
  speed  1.0 is normal
"""
import glob
import os
import sys


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: tts.py <text.txt> <out.wav> [voice] [speed]", file=sys.stderr)
        return 2
    import sherpa_onnx
    import soundfile as sf

    root = os.environ.get("POPOST_TTS_MODEL", "")
    if not os.path.isfile(os.path.join(root, "model.onnx")):
        print("POPOST_TTS_MODEL must name the directory of the Kokoro model (with model.onnx)", file=sys.stderr)
        return 2
    with open(sys.argv[1], encoding="utf-8") as fh:
        text = fh.read().strip()
    voice = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else os.environ.get("POPOST_TTS_VOICE", "50")
    speed = float(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] else 1.0
    lexicons = sorted(glob.glob(os.path.join(root, "lexicon-*.txt")))
    config = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                model=os.path.join(root, "model.onnx"),
                voices=os.path.join(root, "voices.bin"),
                tokens=os.path.join(root, "tokens.txt"),
                data_dir=os.path.join(root, "espeak-ng-data"),
                dict_dir=os.path.join(root, "dict"),
                lexicon=",".join(lexicons),
            ),
            num_threads=int(os.environ.get("POPOST_TTS_THREADS", "4")),
            provider="cpu",
        ),
        max_num_sentences=1,
    )
    if not config.validate():
        print("the model directory is incomplete", file=sys.stderr)
        return 2
    tts = sherpa_onnx.OfflineTts(config)
    audio = tts.generate(text, sid=int(voice), speed=speed)
    if len(audio.samples) == 0:
        print("nothing was generated", file=sys.stderr)
        return 1
    sf.write(sys.argv[2], audio.samples, samplerate=audio.sample_rate, subtype="PCM_16")
    return 0


if __name__ == "__main__":
    sys.exit(main())
