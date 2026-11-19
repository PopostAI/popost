"""Scratch skill project + server for parity_check.mjs (local mode).

Creates a throw-away project (3 pages, same blocks as the browser-mode fixture) in a temp
directory, starts the skill server on a free port and prints one JSON line:
  {"base": "http://127.0.0.1:PORT", "root": ".../project", "pages": {"p1": ".../p1.html", ...}}
Stops (and removes the temp directory) when stdin closes or on SIGTERM.
Usage: POPOST_PYTHON=<python with skill requirements> python parity_local_server.py
"""
import io
import json
import os
import shutil
import sys
import tempfile
import threading
from pathlib import Path

SKILL = Path(__file__).resolve().parents[3] / 'skills' / 'popost'
sys.path.insert(0, str(SKILL / 'scripts'))
import project_core as pc  # noqa: E402
import server  # noqa: E402
from PIL import Image  # noqa: E402


def png(c1, c2, size=(300, 200)):
    img = Image.new('RGB', size)
    px = img.load()
    for x in range(size[0]):
        for y in range(size[1]):
            t = x / size[0]
            px[x, y] = tuple(int(a + (b - a) * t) for a, b in zip(c1, c2))
    out = io.BytesIO()
    img.save(out, 'PNG')
    return out.getvalue()


PAGE1 = '''<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}.post{position:relative;width:1080px;height:1350px;background:#fff;overflow:hidden}
h1{margin:0;padding:80px 80px 20px;font-size:72px}p{margin:0;padding:0 80px;font-size:36px;color:#336699}
.b{position:absolute;background:#9cf;font-size:30px}</style></head><body>
<div class="post" data-canvas-width="1080" data-canvas-height="1350"><h1 id="h" data-layer-id="title">Page one</h1><p id="para" data-layer-id="caption">Body text here and more words</p>
<img id="im" data-layer-id="photo" src="../assets/img1.png" style="width:300px;height:200px;margin:40px 80px;display:block">
<img id="im2" src="../assets/img2.png" style="width:150px;height:100px;margin:0 80px;display:block">
<div class="b" id="b1" style="left:600px;top:700px;width:200px;height:100px">Box A</div>
<div class="b" id="b3" data-layer-id="card" style="left:700px;top:1100px;width:200px;height:150px;background:#fa8"></div>
<div class="b" id="b2" style="left:100px;top:1000px;width:300px;height:120px">Box B</div></div></body></html>'''
PAGE2 = '''<!doctype html><html><head><meta charset="utf-8"><style>.post{position:relative;width:1080px;height:1350px;background:#fff;overflow:hidden}h1{margin:0;padding:80px;font-size:72px}</style></head><body>
<div class="post" data-canvas-width="1080" data-canvas-height="1350"><h1>Page two</h1></div></body></html>'''
PAGE3 = '''<!doctype html><html><head><meta charset="utf-8"><style>.post{position:relative;width:1080px;height:1350px;background:#fff;overflow:hidden}p{margin:0;padding:0 80px;font-size:36px}</style></head><body>
<div class="post" data-canvas-width="1080" data-canvas-height="1350"><p>Page three</p></div></body></html>'''


def main():
    # PARITY_TMP: where to put the scratch project (kept short: Chrome launched by the server needs short temp paths)
    tmp = Path(tempfile.mkdtemp(prefix='popost-parity-', dir=os.environ.get('PARITY_TMP') or None))
    project = pc.Project.create(str(tmp / 'project'), 'Parity project', width=1080, height=1350)
    project.add_page('p2', 'Second', 1080, 1350)
    project.add_page('p3', 'Third', 1080, 1350)
    project.add_asset_bytes(png((230, 50, 50), (50, 50, 230)), 'img1.png')
    project.add_asset_bytes(png((50, 170, 50), (250, 160, 0)), 'img2.png')
    for pid, html in (('p1', PAGE1), ('p2', PAGE2), ('p3', PAGE3)):
        project.write_page_html(pid, html)

    class Handler(server._H):
        pass
    Handler.project = project
    http = server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=http.serve_forever, daemon=True).start()
    pages = {p['id']: str(Path(project.root) / p['htmlPath']) for p in project.manifest['pages']}
    print(json.dumps({'base': 'http://127.0.0.1:%d' % http.server_port, 'root': str(project.root), 'pages': pages}), flush=True)
    try:
        sys.stdin.read()
    finally:
        http.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    main()
