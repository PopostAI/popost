#!/usr/bin/env python3
"""A text reader for the video engine's development loop, on RapidOCR (PP-OCR models through onnxruntime, CPU).

Not part of the engine: the engine calls whatever POPOST_OCR_CMD names (see src/text/reader-command.ts).
Set up once, outside the repository:

    python3 -m venv ~/.local/share/popost-ocr/venv
    ~/.local/share/popost-ocr/venv/bin/pip install rapidocr-onnxruntime
    export POPOST_OCR_CMD="$HOME/.local/share/popost-ocr/venv/bin/python -I <repo>/packages/video/tools/ocr-rapidocr/ocr.py"

Called as: ocr.py <list.json> <out.json>
  list.json  [{"frame": 120, "file": "/abs/000120.jpg"}, ...]
  out.json   [{"frame": 120, "lines": [{"text": "...", "confidence": 0.97, "box": [x, y, w, h]}]}, ...]
Boxes are fractions of the frame, origin top left.
"""
import json
import sys


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: ocr.py <list.json> <out.json>", file=sys.stderr)
        return 2
    import os
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    from threads import threads

    n = threads("POPOST_OCR_THREADS")
    for name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
        os.environ.setdefault(name, str(n))
    import cv2
    import onnxruntime

    cv2.setNumThreads(n)
    # Every session gets its thread count given: left on automatic, onnxruntime counts the machine's processors and
    # pins its threads to them, whatever processors this process was started on (see ../threads.py).
    plain_session = onnxruntime.InferenceSession

    def capped_session(*args, **kwargs):
        options = kwargs.get("sess_options") or (args[1] if len(args) > 1 else None) or onnxruntime.SessionOptions()
        options.intra_op_num_threads = n
        options.inter_op_num_threads = 1
        kwargs["sess_options"] = options
        return plain_session(*args[:1], **kwargs)

    onnxruntime.InferenceSession = capped_session
    from rapidocr_onnxruntime import RapidOCR

    with open(sys.argv[1], encoding="utf-8") as fh:
        frames = json.load(fh)
    ocr = RapidOCR()
    out = []
    for item in frames:
        img = cv2.imread(item["file"])
        if img is None:
            out.append({"frame": item["frame"], "lines": []})
            continue
        h, w = img.shape[:2]
        result, _ = ocr(img)
        lines = []
        for box, text, conf in result or []:
            xs = [p[0] for p in box]
            ys = [p[1] for p in box]
            lines.append({
                "text": text,
                "confidence": round(float(conf), 3),
                "box": [round(min(xs) / w, 4), round(min(ys) / h, 4), round((max(xs) - min(xs)) / w, 4), round((max(ys) - min(ys)) / h, 4)],
            })
        out.append({"frame": item["frame"], "lines": lines})
    with open(sys.argv[2], "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
