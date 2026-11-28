# measure: reading a video

`measureVideo(rt, file)` turns any video into a `Measure` (types.ts); `scoreMeasures(a, b)` in `../score` compares two.
The same file always gives the same JSON, byte for byte.

## Parts

| File | What it does |
|---|---|
| `../media/decode.ts` | ffmpeg to raw rgb24 or gray8 frames at a given width, reading the YUV with the source's matrix and range (BT.709 for an untagged HD source, as `colourOf` in `footage.ts` decides) and exact rounding; refuses decodes over 600 MB, naming the option to lower |
| `index.ts` | two decodes side by side: every frame at about 72 x 128 (pass 1) and up to 15 fps at 144 x 256 (pass 2) |
| `signals.ts` `pixels.ts` | per-frame histograms, 6 x 8 block means, detail; distances between frames |
| `cuts.ts` | hard cuts: a jump in histogram and pixels that stands above the medians on both sides and covers 55% of the grid; or, between two still frames of one layout, a change of 10% of the pixels spread over 45% of the cells and 70% of the frame both ways |
| `gradual.ts` | ramps: windows of 0.15 to 1.7 s, steady on both sides, most blocks change, not a camera move (chained alignment over six-frame pieces, or frame by frame for a fast push-in whose chain must also carry the first frame onto the last), not light (gain and offset), not a cut inside a moving shot |
| `span.ts` | widens cuts over fast, soft or flat-black frames; tightens ramps to the frames that differ from both ends |
| `boundaries.ts` | merges cut chains, ramps and the two halves of a fade, then describes each span; a video neither starts nor ends with a boundary (a shot under 0.1 s at either end joins its neighbour) |
| `fits.ts` `orientation.ts` `kinds.ts` | the kind by fitting models: veil (fade via black or white, flash), blend (dissolve), moving edge (wipe, push, cover, reveal, whip by smear), region (circle wipes), scaled blend (zoom), turn (spin), softness (blur), swings and jolts (glitch, shake) |
| `switch.ts` | transitions that switch instead of mixing (spin, shake, glitch, blur, and cuts between flat colours): every frame read against both settled ends as the same picture, moved, turned, blurred, veiled or other; one-sided effects (side 'before' or 'after'): one picture at rest on one side of the largest step and the other under a veil (fade, flash), a turn (spin), a blur, a move that only scales (zoom), a travel at its own size (whip) or jolts (shake, glitch) |
| `unmix.ts` | a mix of a picture and a flat colour unmixed with each frame's weight, and the picture's scale fitted: a zoom with a flat side |
| `robust.ts` | trimmed differences (the 80% best pixels), Gaussian blur, warps: comparisons that elements on top cannot spoil |
| `align.ts` | global similarity between two frames: pyramid Gauss-Newton with Huber weights, optional coarse search and rotation |
| `camera.ts` | chains alignments about 1/3 s apart over a shot's clean interior; fits zoom and pan in CameraSpec units; a keyframed move first (`moves.ts`), with zoomPerS its mean rate over the shot |
| `moves.ts` | keyframed camera moves: consecutive samples aligned (softened by 1 px) and chained into a scale track; hold, eased ramp (linear, in, out, in-out) and hold fitted to its log; the end scale and the focus point (the fixed point c + t / (1 - s)) from a direct fit of the closer frame onto the wider one |
| `motion.ts` `profile.ts` | events: 4 x 4 cells that change while the frame holds (samples softened by 1 px, so compression noise is not change), grouped by start time then place, then followed on every frame for timing, how, direction, ease, overshoot, colour; lines of one element (same kind, manner and frames, stacked) joined into one event; events under confidence 0.55 are dropped |
| `colour.ts` | background (the cluster on the border) and up to 6 palette colours, Lab clusters 12 ΔE apart |
| `rhythm.ts` `signature.ts` | change every 0.1 s; 16 x 16 gray thumbnails, at most 240 |
| `curve.ts` | the progress curve of one region between two frames (ease, overshoot, kind) |
| `tracks.ts` `reveal.ts` | trajectories (`Measure.tracks`): the region of the new picture during a transition whose two pictures hold still (each pixel old, new or neither; the connected region followed from the last frame back), as the object at its front (the part before the narrowest place behind the front) or as its edge, with the edge's shape (straight, circle, wedge: the model that parts the two sides best); and an element that travels while it appears or disappears (the pixels of the event's box that differ from the picture without it). Samples of centre and size in fractions of the canvas, at most 24 |

## Thresholds worth knowing

- Cut: score > 0.2, above 2.5 x the calmer side's median + 0.06 and the busier side's + 0.12, 55% of cells (`cuts.ts`).
- Ramp: change >= 8 levels, >= 50% of blocks, plateau <= 0.3 of the change just outside (`gradual.ts`).
- Span ends: within max(0.6, 2.5 x shot noise) + 1.5% of the change of the end picture (`span.ts`).
- Via black / white: brightest channel < 40 / darkest > 215, flat (`signals.ts`); a black card over 0.5 s is a shot.
- Kinds: veil residual <= 0.2 and beyond both ends (darker than the darker end by a quarter of its level, or lighter
  than the lighter by a quarter of the room above it), edge residual <= 0.25 and < 0.7 x blend with at least two
  in-between frames, smear (lower quartile) < 0.8 = whip, region purity >= 0.5, spin >= 20 degrees, zoom: scaled
  blend residual < 0.7 of plain (`kinds.ts`, `fits.ts`).
- Each transition keeps how well its kind fits (`Boundary.residual`): its model's residual relative to the change
  across the span (a moving edge's found to the pixel; a shaped wipe's block by block; a zoom's scaled blend), or for a
  kind read from the switch the share of frames no reading explains. A moving edge also keeps its `bend`: how far
  apart the edge stands across its travel when four bands along it find their own places (0 for a straight edge).
  On ffmpeg's and our own transitions the residual stays under 0.15 (moving content included; shaped wipes about
  0.25, ffmpeg's zoomin about 0.38) and the bend is 0; a curved edge bulging a third of the frame bends about 0.15.
  describe says a label does not fit when the residual passes 0.2 (shaped wipes 0.3, zooms 0.45, switched kinds
  0.34), the bend 0.1, or the confidence is under 0.4 (`describe/frames.ts`).
- A flash switches in the middle of its white plateau. A span no model explains is a cut when it has one in-between
  frame, or when a hard cut inside it carries 85% of the change (`kinds.ts`, `boundaries.ts`).
- Switched transitions: a frame is the same picture under 1.2 levels, moved or turned or blurred when the model
  explains half of the difference, veiled when a veil leaves a quarter (and, against a flat end, at most 4 levels);
  a jolt is under 12% of the frame and scales 0.85 to 1.3 (`switch.ts`). Jolts are a shake when they travel
  vertically more than 12% of their sideways path, or flip side on every frame (twice or more, never keeping a side);
  otherwise a glitch. A dissolve needs an in-between frame that mixes the two pictures (alpha 0.15 to 0.85); a fade
  through white that never holds full white on two frames is a fade, not a flash.
- One-sided: the frames on one side of the largest step are their end at rest, at least two on the other side are
  explained, at most a quarter between the first explained frame and the step are not, and none shows the other
  side's picture. A move that only scales (shift under 1%, scale off by 3%) is a zoom; one that travels one way
  without scaling (under 3%) a whip.
- Camera moves: at least 5% of scale over at least 1/3 s, a fit four times better than one rate and within 1.5%
  rms, at least two samples between a tenth and nine tenths of the ramp, and the direct fit of the end frames
  confirms the 5%; a fifth of a second may be dropped at either end of the interior (a transition's tail); a shot
  whose third-of-a-second steps stay within 3% of scale is not searched (`moves.ts`, `camera.ts`). A fast
  push-in is not a boundary when frame-to-frame steps (80% of them, or sub-pixel ones) explain three quarters of
  each change and the chain carries the first frame onto the last within a fifth of its scale, the last frame laid
  directly onto the first loses half of its difference, and no frame of the window is flat black or white (a fade
  through a colour is never a camera; `gradual.ts`). A boundary may sit on the second or the last frame (a one-frame
  cover before the first shot is a shot of its own).
- Events within 2 frames of a gradual transition's span are its eased tail, not elements (`index.ts`).
- Camera still under 0.005 per second; texture under 1.5 levels per pixel is "unknown" (`camera.ts`).
- Trajectories: colours differ at 30 levels a channel on average; the pictures must differ on 15% of the frame; a
  picture holds still under 0.2% of pixels changing in 1/15 s, and the window reaches at most 1 s past the measured span
  (not into a camera move of the next shot); at most a quarter of the pixels neither picture and a mix under 0.2 (a
  dissolve stands near 0.5); new pixels within 2 px of each other are one part (a shape and a trail that touch in a
  point), and the region is the largest part that continues the next frame's; the cover must reach 0.9 and fall back by at most 0.1; straight or circle at a fit of 0.9,
  wedge at 0.85 and at most 170 degrees; a head is 3 px broad with a neck of at most 0.6 of it, found on half of the
  frames whose front is inside the frame, its area steady within 3 times; an element travels 3% of the width with its
  area within 0.6 (`tracks.ts`, `reveal.ts`).
- Events: samples softened by 1 px, pixel change > 12, cell 15% active, steps with > 50% active cells skipped, cells
  active > 70% of the shot are a layer, at least 0.2% of the frame, confidence at least 0.55, 24 per shot
  (`motion.ts`).

## Accuracy (2026-11-21, reading round 3)

Round 3 took each round 2 change against the real development floor, one at a time, fixed the synthetic generator and
its truth, and made reading a third faster with byte-for-byte the same results (`46815e2`).

Real videos (development set, 10 cases; reference reading against the reading of its model-free replica):

| Reading | structure | transitions | camera | motion | rhythm | colour | picture | composite |
|---|---|---|---|---|---|---|---|---|
| Round 1 | 0.940 | 0.876 | 0.915 | 0.209 | 0.571 | 0.871 | 0.681 | 0.7107 |
| Round 2 as delivered | 0.959 | 0.849 | 0.909 | 0.270 | 0.498 | 0.844 | 0.616 | 0.6901 |
| Round 3 final (`b578cec`) | 0.955 | 0.876 | 0.909 | 0.273 | 0.570 | 0.868 | 0.661 | 0.7246 |

Runs are deterministic (a repeated run gives the same numbers). Against round 1 by case: 01 0.525 -> 0.629, 04 0.713 ->
0.775, 06 0.668 -> 0.714, 12 0.751 -> 0.773, 05 and 07 up 0.01; 10 0.748 -> 0.694, 09 0.689 -> 0.659, 13 0.833 -> 0.804,
02 0.581 -> 0.575. Case 01 has no events in either reading now, so its motion leaves the mean; counted as 0, as in round
1, the composite would be 0.7156.

Each round 2 change removed on its own from the state "round 2 with the speed-up, no edge guard" (0.7168). Synthetic:
the same renders of the round 3 generator re-measured, development seeds 1-40, and with `--features sides,moves` where
the change reads sides or moves (one ledger decision line each):

| Round 2 change | Decision | Real floor, without -> with | Synthetic, without -> with |
|---|---|---|---|
| Edge guard: no boundary within 0.1 s of either end | dropped | 0.7168 -> 0.6901 (case 07: a one-frame cover joined the first shot and became its picture) | identical (0.8703; features 0.8204) |
| H17b: chained small steps explain a ramp as a camera | changed: not across a flat black or white frame, and the whole fit must lose half | 0.7242 -> 0.7168; changed 0.7246 | features 0.7906 -> 0.8204 (moves 23 -> 34/48, false boundaries 21 -> 10); changed: the same |
| H18: softened event samples, confidence 0.55 | kept | 0.7062 -> 0.7168 (+0.0016 without case 01, whose motion leaves the mean) | 0.8531 -> 0.8703: events 166 -> 193/231, false events 30 -> 22 |
| H13: softness 1 in readFrame | kept | 0.7151 -> 0.7168 | kind right 106 -> 105/119, composite 0.8701 -> 0.8703 |
| H12: fade or flash by the white plateau | kept | 0.7160 -> 0.7168 | kind right 103 -> 105/119 |
| H14b: shake or glitch by vertical travel and side flips | kept | 0.7166 -> 0.7168 | kind right 106 -> 105/119 (the boundary H13 also loses) |
| H11: a dissolve needs a mixed frame | kept | 0.7172 -> 0.7168 (one boundary one frame later) | identical (on the round 2 renders 98 -> 100/117) |
| H16: one-sided transitions | kept | 0.7174 -> 0.7168 | features: kind right 88 -> 92/119, one-sided 19 -> 23/36 |
| H17a: keyframed camera moves | kept | 0.7175 -> 0.7168 | features: moves 0 -> 34/48, camera 0.688 -> 0.911 |
| H22: gate of the move search | kept | identical; floor work 339 -> 330 s | identical |

The generator and the truth changed (`859d45f`, `32d1451`, `00aa0b5`): `gradients` takes its colours from the seed
and every picture is rgb24, so a seed renders the same picture on every run; cellauto and life are no longer drawn
under a camera or a transition that moves, scales or turns the picture; the truth of a keyframed move no longer adds
its segment's start twice. read-render reads development seeds 1-4 (`5c9d11a`). **Synthetic numbers before and
after these fixes are not comparable**: the round 2 table below was measured on other pictures and another truth.
Fresh renders (the same seed now gives the same render, so "same renders" and "fresh renders" agree):

| Set | Round 2 reading, fixed generator | Round 3 final |
|---|---|---|
| Development, seeds 1-40 (40 projects, 119 transitions, 231 events) | kind right 105/119 (88%), found 100%, false boundaries 6, events 193/231 (how right 75%), false events 22; structure 0.968, transitions 0.839, camera 0.908, motion 0.709, colour 0.936, composite 0.870 | the same, every number |
| Development with `--features sides,moves` (36 one-sided, 48 moves) | kind right 92/119 (77%), one-sided 23/36 (takeover within 1 frame 36/36), moves 34/48 (start within 3 frames 33, scale within 5% 34, focus within 0.1 32), spurious moves 0, false boundaries 10, false events 50; camera 0.911, composite 0.820 | the same, every number |
| Validation, seeds 71-100 (30 projects, 86 transitions, 157 events) | kind right 71/86 (83%), false boundaries 0, events 145/157, false events 8; composite 0.903 | the same, every number |
| Validation with `--features sides,moves` (29 one-sided, 29 moves) | kind right 66/86 (77%), one-sided 19/29, moves 16/29, false boundaries 7, false events 22; camera 0.828, composite 0.813 | kind right 66/86, one-sided 19/29, moves 15/29, false boundaries 8, false events 22; camera 0.821, composite 0.810 (seed 88: the changed H17b no longer explains a move right after a flash as a camera; it reads as a zoom boundary and the move is lost) |
| Seeds 41-70, run once at the end (30 projects, 89 transitions, 181 events) | (not run) | kind right 69/89 (78%), found 100%, false boundaries 2, events 85.6% (how right 83%), false events 22; structure 0.972, transitions 0.779, camera 0.907, motion 0.692, composite 0.851 |
| Seeds 41-70 with `--features sides,moves`, once | (not run) | kind right 52/89 (58%), false boundaries 4, false events 38; transitions 0.630, camera 0.844, composite 0.806 |
| Held out, seeds 101-130, run once at the end (30 projects, 91 transitions, 207 events) | (not run) | kind right 69/91 (76%), found 100%, false boundaries 0, events 84.5% (how right 79%), false events 20; structure 0.964, transitions 0.731, camera 0.913, motion 0.703, composite 0.842 |
| Held out 101-130 with `--features sides,moves`, once | (not run) | found 90/91, kind right 64/90 (71%), false boundaries 5, false events 40; transitions 0.698, camera 0.839, composite 0.811 |

Reading time (one process, Chrome not counted):

| What | Round 1 | Round 2 | Round 3 |
|---|---|---|---|
| A 15.4 s synthetic clip (462 frames) | 2.96 s | 5.78 s | 3.10 s |
| Ten synthetic clips of 8.6 to 16.9 s | 26.6 s | 59.1 s | 27.6 s |
| Real floor: measuring 10 references and 10 replicas | 150 s | 410 s | 223 s |
| Real floor: the whole run (draft and render included, work summed) | 243 s | 502 s | 312 s |

Unseen seeds are now 10 to 12 points of kind right under the development seeds (88% against 76 to 78%; with
`--features` 77% against 58 to 71%). Validation and the unseen seeds were opened only as totals.

## Accuracy (2026-11-21, reading round 2)

Round trip of our own renders (`eval roundtrip`; seeds 1-40 are for development, 71-100 for validation and were
opened only as totals, 101-130 are held out and were run once at the end). Fresh renders of the final state:

| Set | Clips | Round 2 start (state after round 1) | Final |
|---|---|---|---|
| Development, seeds 1-40 | 40 projects, 119 transitions, 231 events | kind right 98/117 (84%), composite 0.835 | kind right 102/117 (87%), found 98%, false boundaries 7, events 186/231, false events 19; structure 0.940, transitions 0.830, camera 0.887, motion 0.700, colour 0.936, composite 0.853 |
| Validation, seeds 71-100 | 30 projects, 86 transitions, 157 events | kind right 64/86 (74%), composite 0.874 | kind right 71/86 (83%): fade 9/9, shake 9/10, spin 3/4, zoom 4/6, glitch 2/6, slide 2/7; false boundaries 3, events 139/157, false events 8; composite 0.888 |
| Development with `--features sides,moves` | 40 projects, 119 transitions (36 one-sided), 48 camera moves | kind right 82/118, one-sided 18/36, moves 0/48, false boundaries 24, false events 69, camera 0.637, composite 0.729 | kind right 89/118 (75%), one-sided 22/36 (takeover within 1 frame 36/36, span within 2 frames 13/36), moves 30/48 (start within 3 frames 27, end 29, scale within 5% 27, focus within 0.1 29), spurious moves 0, false boundaries 13, false events 41; structure 0.954, transitions 0.740, camera 0.865, motion 0.618, composite 0.812 |
| Validation with `--features sides,moves` | 30 projects, 86 transitions (29 one-sided), 29 camera moves | kind right 53/85, one-sided 15/29, moves 0/29, false boundaries 11, false events 40, camera 0.627, composite 0.745 | kind right 58/85 (68%), one-sided 16/29 (27/29, 7/29), moves 18/29 (16, 17, 15, 17), spurious 0, false boundaries 4, false events 21; structure 0.951, transitions 0.686, camera 0.854, motion 0.638, composite 0.814 |
| Held out, seeds 101-130 (run once) | 30 projects, 91 transitions, 207 events | (not run before) | kind right 61/91 (67%): dissolve 9/9, flash 9/9, fade 4/4, cut 9/10, slide 7/10, zoom 6/9, wipe 4/7, glitch 4/9, whip 3/8, shake 2/5, spin 2/8; false boundaries 3, false events 22; structure 0.945, transitions 0.698, camera 0.903, motion 0.701, composite 0.829 |
| Seeds 41-70 (round 1 held-out, run again unopened) | 30 projects, 89 transitions | kind right 65.9%, false events 44, composite 0.821 | kind right 67.0%, false events 18, motion 0.698, composite 0.839 |

Each hypothesis was decided on the same kept renders (development and validation, both before and after); the ledger
(`eval/ledger.jsonl`, round 2 decision lines) holds those numbers. Unseen seeds stay 16 to 20 points under the
development seeds, mostly on spin, whip, shake and glitch.

Real videos (development set, 10 cases; reading of a reference against reading of its model-free replica, so both
halves move it): composite 0.711 (round 1) -> 0.690; structure 0.940 -> 0.959, transitions 0.876 -> 0.849, camera
0.915 -> 0.909, motion 0.209 -> 0.270, rhythm, colour and picture lower (0.571 -> 0.498, 0.871 -> 0.844, 0.681 ->
0.616; the making half changed since round 1). Reading takes about twice as long as in round 1 (a 15 s synthetic clip:
3.1 s -> 7 s; the frame-by-frame move search, the one-sided reading of every span, the softened event samples).

| What | Clips | Result |
|---|---|---|
| Camera moves (read-moves, new) | 5 clips with a keyframed move (centre, corner, pull-out, late, and a hard cut followed at once by a 28-frame eased 2.6x push-in to a corner), 2 negatives | every move found: start and end exact, scale within 0.2%, focus within 0.001, mean rate within 0.3% (the test allows 1 frame, 1%, 0.02 and 2%); no move on a steady push-in or a still shot; the fast push-in is no boundary |
| Camera moves in the round trip (`--features`, same renders) | 48 moves (development), 29 (validation) | found 30/48 and 18/29; of those, start within 3 frames 27 and 15, end 29 and 18, scale within 5% 27 and 15, focus within 0.1 29 and 17; spurious moves 2 and 0. Missed: moves on animated noise textures (cellauto, life) and on zoom transitions the boundary reader misses |
| One-sided transitions (`--features`, same renders) | 36 (development), 29 (validation) | kind right 17 -> 22 and 15 -> 17; takeover within 1 frame 36/36 and 27/29; whole span within 2 frames 13/36 and 7/29 |
| Re-encode stability (read-render) | 4 renders against a half-size crf-32 re-encode | same boundary 13/16, boundaries paired 16/16, same camera 18/20 shots, motion agreement 0.455 -> 0.621 (motion against the truth 0.590 -> 0.614) |
| Boundaries (read-boundaries) | 65 clips with 130 boundaries, 10 negatives (2 new: a cover frame first, a stray frame last) | recall 1.000, precision 1.000, start / end MAE 0.35 / 0.25, kind exact 0.938, kind credit 0.962, nothing in the negatives |
| Motion events (read-motion) | 5 clips with 29 events, 2 negatives | 29/29 found, none extra |

## Accuracy (2026-11-20, reading round 1)

Synthetic clips (independent of our renderer unless said):

| What | Clips | Result |
|---|---|---|
| Boundaries (read-boundaries) | 65 ffmpeg xfade and scene clips with 130 boundaries, 8 negatives | recall 1.00, precision 1.00, start / end MAE 0.32 / 0.24 frames, kind exact 0.938 (0.965 with look-alike credit), no boundary in the negatives |
| Real-video situations (read-findings) | 8 clips: light-to-dark dissolves, a cut with one partly updated frame, a cut then a push-in, page cuts of one layout, a caption change, a text block, cuts on the second and last frame | all boundaries and kinds right, nothing extra (the code before this round got 5 of them wrong) |
| Our renderer (read-render) | 4 synthetic projects rendered by Chrome, 16 transitions | recall 16/16, kind exact 12/16, motion 0.59 against the truth |
| Re-encode stability (read-render) | the same 4 renders at half size, crf 32 | same boundary (kind, frame within 1) 13/16, same camera 19/21 shots, motion 0.455 of one reading against the other |
| Round trip, seeds 1-40 (our renderer, 40 projects, 119 transitions, 231 events) | | found 98%, kind right 82% (was 60%), false boundaries 5 (was 7), false events 28 (was 129); scores structure 0.940, transitions 0.806, camera 0.883, motion 0.631, colour 0.936, composite 0.833 (was 0.783) |
| Round trip, seeds 41-70 (held out, run once) | 30 projects, 91 transitions, 181 events | found 99%, kind right 64% (glitch 1/8, shake, spin, zoom and slide half), false boundaries 3, false events 44; structure 0.955, transitions 0.716, camera 0.908, motion 0.623, colour 0.937, composite 0.821 |
| Camera (read-camera) | 13 | kind 13/13; zoom and pan within 0.001 per second |
| Motion events (read-motion) | 5 with 29 events, 2 negatives | 29/29 found, none extra, how 100%, direction 100%, ease 83%, start / end MAE 0.3 / 0.5 frames, box IoU >= 0.91 |
| Decoded colour (read-colour) | 4 clips of flat colours, tagged or not | within 4 levels (an untagged HD clip was 21 off before) |

Real videos (development set, 10 cases; the floor compares our reading of a reference with our reading of its replica,
so it is not an accuracy against truth): composite 0.683 -> 0.711, structure 0.862 -> 0.940, transitions 0.835 ->
0.876, motion 0.180 -> 0.209, colour 0.869 -> 0.871. Case 05, read by eye: 11 boundaries, all now read as seen (6 were wrong or missing).
Re-encoded at half size and 250 kbit/s, cases 05, 06 and 10 keep their boundaries but for 2 to 3 borderline ones and
score 0.88 to 0.94 against themselves (motion 0.39 to 0.65).

Round trips are not reproducible from run to run: ffmpeg's `gradients` source picks random colours and positions
even with a seed, so synthetic pictures of that kind change (compare readings on kept renders). Fixed in round 3: the
colours come from the seed and every picture is rgb24.

Run `tests/read-*.test.ts`: each prints its table.

## Weak spots

- The same pixels, different kinds (the round trip counts them wrong; see the round 2 report): a spin, shake or glitch
  between two flat colours is a cut; a slide whose moving layer is flat is a wipe, a wipe onto a flat colour a cover;
  an effect on a flat side shows nothing; a one-sided fade to white of strength s is a flash of strength s / 1.5; the
  cellauto and life textures change on every frame, so moves, turns and jolts on them alias (since round 3 the
  generator keeps them away from cameras and transforming transitions; a real video can still have such a texture).
- One-sided or two-sided cannot be told when the side at rest is flat or an animated texture: a two-sided shake whose
  new side is such a texture can read as a one-sided glitch. Whole one-sided spans are often 3 or more frames short.
- Glitch is right a third to a half of the time: for lengths 6 to 13 and 18 its hash never swings back to the old
  picture, so it is jolts on each side of one switch, like a shake whose vertical travel happens to be small.
- Camera moves on an animated texture are not found, and a zoom transition the boundary reader misses becomes a move.
- Gradual spans are narrow: dissolves end 2 to 4 frames early, switched kinds 3 to 5 frames on each side.
- Circle wipes: the start and end are 2 to 3 frames inside the true span; their direction is often up or down.
- Elements that fly in right after a cut are events of the new shot (before, a one-frame "wipe" hid them).
- Under a lower-quality re-encode, events change most (agreement 0.62): a transition read as a cut there lets its tail
  through as events, a shot whose camera reads still in one and moving in the other keeps different events, and thin
  strips along moving edges appear.
- The background picker can jump from one colour cluster to another on a 1 to 4 level change of the decode.
- A still title of 10% of the frame or more over a camera move makes that shot's camera "unknown" and its events
  are lost; events over a moving camera are only appear and disappear, never change.
- Eased element moves end 1 to 2 frames early (the last frames sit within 2% of rest), so ease can tip to linear.
- Events next to each other in time and place merge; an instant exit in the last frames can read as a short fade.
- Real case 10 since H18: fewer and longer entrances, some lasting a whole shot; the draft turns them into slowly
  sliding items, which costs picture and makes the replica's camera read as a pan.
- The keyframed move search can find a small move (5%) in a replica that its reference does not have (real case 13).
- A keyframed move that starts right after a flash can read as a zoom boundary (validation seed 88 with `--features`,
  since H17b changed), and that move is lost.
- When neither reading of a case has an event, its motion dimension leaves the composite (real case 01 since H18):
  the composite rises without a better reading.
- read-render seeds 1-4: the dissolve of seed 4 is missed and the glitch of seed 1 reads as a cut; in the round trip, a shake of
  seed 1 reads as a glitch only when H13 and H14b are both on.

## The curve of one moving element (move.ts, easing.ts)

`curvesOf` follows the thing that differs from the ground inside a region (its box and ink per frame), splits each
property into moves separated by holds of 0.15 s, and describes the largest: start, length, distance, peak speed,
overshoot, turns and bounces, settle time, squash and stretch, and the closest named easing by least squares
(`fitEase`). Ported from HyperFrames' `measure curve` (Apache-2.0; the file headers say what changed).

Measured on a dot drawn into 240x136 frames (`tests/video/measure-curve.test.ts`): every curve of the named set comes
back from its own samples within 0.01; a slide on power1.out, linear and power2.inOut comes back by name, start
within 2 frames; power3.out over 30 frames comes back as power2.out over 24 (the tail is under a pixel); back.out(1.7)
within 0.2 of its amount; a spring by its damping within 0.1; bounce.out by name with its bounces and its squash.

