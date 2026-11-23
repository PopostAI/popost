# Template: demo

4 shots, 7.0 s (210 frames at 30 fps), 360x640 portrait, from a measured reference (a synthetic reference rendered by the engine: footage, a still with a push-in, a title card, a gradient end). You give the content; the program keeps every length, cut, transition and caption time. Captions: 5 beats in one band.

## Beats

1. shots[0] 0.0-2.0 s, in: start. Source: footage (footage needs 2.13 s)
   - captions[0] 0.0-1.5 s: was "先看结果" (4)
   - captions[1] 1.5-3.3 s: was "这个方法只要三步" (8)
2. shots[1] 2.0-3.8 s, in: slide left push 7f. Source: picture
   - captions[2] 3.3-5.0 s: was "第一步先定主题" (7)
3. shots[2] 3.8-5.0 s, in: cut. Source: colour, showed "三个要点"
4. shots[3] 5.0-7.0 s, in: dissolve 8f. Source: colour
   - captions[3] 5.0-6.2 s: was "第二步" (3)
   - captions[4] 6.2-7.0 s: was "关注我下期见" (6)

## Fill (fill.json)

{"shots": [4 entries], "captions": [5 lines]}

- shots[k]: {"footage": "assets/a.mp4", "in": 0, "speed": 1} | {"picture": "assets/b.webp", "zoom": 0.04} | {"color": "#101014"} | {"card": {"title": "...", "lines": ["..."]}} (1 s or more; title at most 5 full-width or 10 Latin characters, up to 5 lines of 11 or 23) | {"scene": "scenes/shot-01.html", "slots": {"title": "..."}}: every shot takes a scene, an HTML page of the project that draws the whole shot.
- captions[i]: the words of beat i+1; "" for none.
- Optional: voice, speed, say (spoken with --speak: beats take the spoken length), captionColor, captionOutline, sound.

## Rules

- Lists are matched by position. Write no times or frames.
- A caption line holds at most 20 full-width or 36 Latin characters (2 lines); a longer one is refused.
- Footage lasts its shot from "in". Neighbouring colour shots need clearly different colours. No "keep". Limits: slots.json.
- template check <this dir> --fill fill.json checks the fill; template fill <this dir> --fill fill.json --out <project> checks its files once they are in <project> (scenes, footage, pictures), then builds it.
