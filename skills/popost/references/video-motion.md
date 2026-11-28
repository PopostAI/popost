# Motion: the rulebook

Read this before writing the scene of any shot that `ref/shots/NN.md` says **moves throughout**, and for every scene
when the reference is motion graphics. It says how things move, in numbers, and gives each move as a function of the
shot's time, which is the only kind of motion the engine can render (`video-scenes.md`, "Motion: the engine owns the
clock"). The effects are in the Skill's motion helper and in the effects catalogue; draw by hand only what neither has.

```bash
popost video scene library project --name motion      # project/lib/popost-motion.js: every effect below, as functions of time
popost video scene example --search "bounce ball"     # the catalogue: a ready scene for most effects (video-effects.md)
popost video measure curve reference.mp4 --from 2.1 --to 3.4 --roi 0.3,0.1,0.4,0.8   # the reference's curve, in numbers
popost video scene cues project                        # where the scenes' sounds belong, in the video's time
```

## 1. Look, measure, then write

1. **Look.** Open `ref/shots/NN-frames.jpg`. Say what the main move is, what follows it, and what keeps moving.
2. **Measure, do not guess.** `ref/shots/NN.md`, "Motion events", has the measured curve of the shot's main mover:
   its start, length, distance, overshoot, bounces, squash and the closest easing, with a line to paste. Measure any
   other element with `popost video measure curve` (`video-tools.md`, "Measuring one move"). After the render, measure
   the same region of your video and hold the two against each other: the same ease family, the overshoot within a
   few percent, the length within two frames.
3. **Write** the scene from those numbers with the helper, a catalogue entry, or a GSAP timeline.
4. **Check.** `popost video scene check` for the scene; `popost video compare` after the render names every shot that
   stands still for more than 40% of its length while the reference moves throughout. That is fixed, not noted.

## 2. Three layers: what makes a shot move to its last frame

| Layer | What it is | How long | Examples |
|---|---|---|---|
| **Primary** | the one move the shot is about | as long as the reference's | a ball that bounces, a title that slams in, a shape that morphs, a camera that travels |
| **Secondary** | what answers the primary move, a little later | 0.05 to 0.2 s behind it, 0.2 to 0.6 s long | a contact shadow, a trail, a ring on the floor, a settle, sparks, a second element nudged by the first |
| **Ambient** | what never stops | the whole shot | rays that turn (3 to 20 degrees a second), a ground that drifts, moving light, slow particles, a slow camera orbit |

- A shot with only a primary layer is a still picture from the moment the move ends. Two thirds of the shots of a
  re-made motion graphic went still after 0.3 s for exactly this reason.
- **Titles land and stay still.** Once a title is in, it does not wobble, float, breathe or keep scaling. The motion
  goes on in the world behind it (the ambient layer) or in the next element.
- **One move per role.** Never every element entering the same way: a shot whose parts all fade and slide up, or all
  pop on the same overshoot, reads as a template. The headline may slam, the list staggers in on a rise, the number
  counts, the ground drifts.

## 3. Numbers

**Ease by role.** The same `power2.out` at 0.5 s on everything is what makes a film feel generated.

| Role | Ease | Why |
|---|---|---|
| an arrival | `expo.out`, `power4.out`, `power3.out` | arrives fast, lands on a long tail |
| an exit, a zoom through | `power3.in`, `expo.in` | accelerates away; an exit is 40 to 50% shorter than the entrance |
| a move that stays on screen (a camera, a colour flood) | `power2.inOut`, `sine.inOut` | eases both ways |
| a turn, a progress bar, a conveyor | `linear` | constant speed is the point |
| a playful arrival | `back.out(1.4)` to `back.out(2.2)`, a spring | overshoots once and settles |
| a loop | `sine.inOut` | no seam |

**Lengths.** A fast move takes 0.3 to 0.6 s. A tap or a toggle 0.12 to 0.18 s; a card 0.2 to 0.35 s; a full-frame
change 0.4 to 0.6 s; a dramatic reveal 0.6 to 1.2 s; an ambient cycle 2 to 20 s. Longer distances take longer, but not
in proportion: twice the distance is about 1.3 times the length.

**Springs, by damping ratio.** `spring(damping, stiffness)` is a closed form of the time, so any frame can be drawn on
its own:

```js
// x(u) from 0 to 1, u in units of the tween's length; z the damping ratio, w = sqrt(stiffness)
function spring(z, k) { var w = Math.sqrt(k); return function (u) {
  if (u <= 0) return 0;
  if (z < 1) { var wd = w * Math.sqrt(1 - z * z); return 1 - Math.exp(-z * w * u) * (Math.cos(wd * u) + (z * w / wd) * Math.sin(wd * u)); }
  return 1 - Math.exp(-w * u) * (1 + w * u); }; }
```

| Damping | Overshoot | Reads as |
|---|---|---|
| 1.0 | none | exact, a tool |
| 0.7 to 0.85 | 1 to 5% | restrained, expensive |
| 0.4 to 0.6 | 10 to 25% | playful |
| under 0.3 | 35% and more, several swings | a cartoon |

Stiffness sets the speed of the swing: 100 is about one and a half swings in the tween's length, 250 two and a half.
Position and size may spring; **opacity and colour never overshoot** (the helper clamps them).

**Overshoot budget by tone.** A warning or an error: 0. A calm or expensive brand: 0 to 3%. Ordinary feedback: 2 to
5%. A success: 5 to 10%. A celebration, a toy, a cartoon: 15 to 25%. One overshoot, then rest: a second bounce on UI
reads as a mistake.

**Squash and stretch.** Squash only on the frames of contact (2 to 4 frames), about 1.2 wide by 0.8 tall; stretch
along the direction of travel at speed, about 0.85 by 1.15, in proportion to the speed. Keep the volume: what is gained
in width is lost in height. Never squash in mid-air. A rigid thing (metal, glass, a phone) does not squash at all.

**Anticipation.** Before a large move, a small one the other way: 10 to 20% of the move, 0.1 to 0.2 s. A card backs
off 5 to 10 px before it leaves; a ball sinks a little before it jumps. Not for anything under 0.15 s.

**Stagger and overlap.** The next element starts when the one before is 30 to 50% done: all at once looks cheap, one
after another looks robotic. Letters 1 frame apart, words 60 to 120 ms, list items 40 to 80 ms, tiles of a grid 20 to
50 ms; a whole group is in within about half a second. What trails (a tail, a shadow, a child) follows 50 to 150 ms
behind and stops later.

**A slam-in.** From 2.5 to 4 times its size (or from off the frame) on an accelerating ease (`power3.in`) in 0.15 to
0.25 s; on the landing frame the picture flashes white for one frame at about 85% and one more at 40%; the ground
shakes 8 to 16 px for 0.3 s and dies away; a ring or dust spreads from the landing. Then the title is still.

**On twos.** Hand-drawn and stop-motion animation holds each drawing for two frames (12 drawings a second at 24).
Hold the time, not the picture: `M.stepped(seconds, fps, 2)`, or the `steps(n)` ease. Camera moves stay on ones.

**Motion blur.** A fast mover is smeared along its own path, most at its fastest frame: 6 to 12 px for something the
size of a word, 15 to 20 px for a full-frame move, only in the direction it travels. On a canvas, draw the moments
between two frames on top of one another (`M.motionBlur`); on an element, a blur that follows the speed.

**Cut on the fastest frame** of a move, with the same direction and speed on both sides of the cut.

## 4. What reads as generated

- a title that wobbles, floats, breathes or pulses for the whole shot;
- a slow creeping scale on everything;
- every element fading and sliding up; every pop on the same overshoot; every scene entering the same way;
- one easing and one length for all moves;
- a bounce that is one element dropping with a squash in mid-air, no arc, no shadow, nothing that answers the landing;
- a flat stand-in where the reference shows a lit, turning, reflecting object (section 7);
- a shot that is a still picture after its first third of a second.

## 5. Determinism

A frame depends on its time only (`video-scenes.md`): the renderer draws frames in any order and several at once.

- Every position is a **function of `seconds`**: `x = from + (to - from) * ease(clamp01((seconds - start) / length))`.
  Never add to a value from the frame before.
- Randomness is **seeded**: `var r = M.rng(7); r(); r.range(a, b)`, or `M.hash(i, seed)` and `M.noise(x, seed)` with
  no state at all. Never `Math.random()`.
- Particles are closed forms too: a particle thrown at speed `v` with drag `k` is at `v * (1 - exp(-k u)) / k` after
  `u` seconds, plus `g u² / 2` down.
- No `requestAnimationFrame`, no timers, no clock. three.js is drawn from `render(seconds)` (section 7).
- **Measure only when the page is laid out.** The scene of a later shot loads in a layer that is not displayed, where
  every size is 0 until its first frame. Take the canvas size from the size the file declares, and read an element's
  size or a path's length inside `M.whenShown(function () { ... })` (the helper's own effects do).

## 6. Recipes

Each is a function of the time. `M` is `popostMotion` (load `../lib/popost-motion.js`); the name in brackets is the
catalogue entry that draws it with parameters (`popost video scene example <name>`).

**Bouncing ball** (`bouncing-ball`). Parabolic arcs, each keeping a share of the speed (the restitution: 0.35 heavy,
0.6 rubber, 0.8 lively); squash on the frames of contact only, stretch along the fall, a contact shadow that tightens
as the ball comes down, a ghost trail, a ring on the floor at the first landing.

```js
var b = M.bounce('#ball', { at: 0.2, for: 1.6, from: [380, 90], to: [900], floor: 590, size: 100,
                            bounces: 3, restitution: 0.6, squash: 0.3, stretch: 0.25, trail: 4, shadow: true });
M.shockwave({ at: b.contacts[0], x: 510, y: 590, radius: 160, flat: 0.22 });   // the floor answers the first landing
// By hand: the fall takes T0 = sqrt(2h/g); bounce i leaves at e^i * g * T0 and lasts 2 * e^i * T0; within an arc
// y = v s - g s²/2. M.bouncePath({ height, bounces, restitution, for }) gives at(u) -> { y, v, contact } and the contacts.
```

**Spring pop** (`spring-pop`). Scale from 0 to 1 on a spring, opacity in over the first fifth.
`M.pop('#badge', { at: 0.3, for: 0.6, damping: 0.45, stiffness: 200 })`.

**Slam-in** (`slam-title`). `var s = M.slam('#title', { at: 0.2, for: 0.22, from: 3.4 });` flashes on the landing
frame; add `M.shake('#world', { at: s.land, for: 0.35, amount: 12 })` and `M.shockwave({ at: s.land })`.

**Star or badge pop with a turning sunburst** (`spring-pop`). The rays are the ambient layer:
`M.sunburst({ at: 0.2, rays: 16, speed: 20 })` behind `M.pop(...)`, and `M.burst({ shape: 'star', count: 14 })` on the
landing.

**Pen-tip draw-on** (`pen-draw`). The stroke's dash offset runs from its length to 0, a dot rides the end:
`M.drawOn('#line', { at: 0.2, for: 0.8, ease: 'power2.inOut', tip: true })`. By hand: `stroke-dasharray: L L;
stroke-dashoffset: L * (1 - p)`, the tip at `path.getPointAtLength(L * p)`.

**Path morph** (`shape-morph`). Both outlines are sampled to the same number of points and each point travels:
`M.morph('#shape', { at: 1.1, for: 0.6, from: d1, to: d2, ease: 'power2.inOut' })`. Give a held shape a slow turn.

**Liquid, goo** (`goo-blobs`). Shapes under a blur and a hard alpha step melt where they come close:
`M.goo('#group', { blur: 16 })`; move the shapes on closed paths (two sines each) so that they meet and part.

**Kinetic type** (`kinetic-type`, and the ported `text` and `caption` entries).
`M.kinetic('#line', { at: 0.2, by: 'words', enter: 'rise', each: 0.09 })`; `by`: words, chars, lines; `enter`: rise,
drop, blur, scale, fade, left, right, turn, pop, slam. One accent word; the line lands and stays.

**Staggered grid reveal** (`grid-reveal`). `M.gridReveal('.cell', { cols: 6, order: 'diagonal', each: 0.05 })`;
orders: diagonal, rows, columns, radial, random. `M.stagger(els, { each, order, enter })` for a list;
`M.offsets(n, each, order, { cols })` gives the bare delays.

**Counter** (`counter-stat`). `M.counter('#n', { at: 0.2, for: 1.4, from: 0, separator: ',' })` counts to the
element's own text (a slot) on `power3.out`; a bar or a ring grows on the same ease.

**Particle burst, confetti, sparks, shockwave** (`particle-burst`). `M.burst({ at, x, y, count, speed, gravity, life,
shape })`, `M.confetti({ at, x, y })`, `M.sparks({ at, x, y, angle })`, `M.shockwave({ at, x, y, radius })`; all
seeded.

**Camera shake.** `M.shake('#world', { at, for: 0.4, amount: 12, frequency: 28, decay: 2 })`: smooth seeded noise that
dies away. Shake the world, not the title that landed.

**Glitch, RGB split** (`glitch-title`). `M.glitch('#title', { at, for: 0.5, amount: 18, rate: 24 })`: a red and a
cyan copy pull apart and bands jump sideways, in bursts.

**Sub-frame motion blur** (`motion-blur-streak`). `M.motionBlur('#canvas', function (ctx, t) { /* draw the mover at
t */ }, { samples: 12, shutter: 0.6 })`.

**Typed text, decode** (`type-on`). `M.typeOn('#cmd', { at, cps: 16 })`, `M.scramble('#word', { at, for: 0.9 })`.

**Speed lines, whip** (`speed-lines`). `M.speedLines({ at, for: 0.6, angle: 0 })` behind a card that arrives on
`expo.out` with a blur that follows its speed.

**Parallax** (`parallax-layers`). `M.parallax([{ el: '#far', depth: 0.2 }, { el: '#near', depth: 1.2 }], { to: [-150,
0], zoom: 1.08, for: 5 })`: one camera move, each layer by its depth; it lasts the whole shot.

**Bars that follow a sound** (`audio-bars`). `M.bars('#bars', levels, { rate: 30, count: 28 })`, `levels` the sound's
envelope (0..1, `rate` a second).

**Also**: `M.tween(el, { at, for, ease, from, to })` (x, y, scale, scaleX, scaleY, rotate, skewX, opacity, blur),
`M.wipe(el, { kind: 'left' | 'circle' | 'iris' | 'diagonal' | 'blinds' })`, `M.shimmer(el)`, `M.follow(el, path)`,
`M.trail(el, pose)`, `M.drift(el)` and `M.spin(el)` (ambient, never on a title), `M.flash()`, `M.put(el, key, state)`,
`M.on(function (seconds, fps) { ... })` for your own drawing, `M.ease(name)`, `M.rng(seed)`, `M.noise(x, seed)`.
Several effects on one element combine. A GSAP timeline and the helper can share a scene.

## 7. 3D

- **CSS 3D** is enough for flat things that turn: a card that flips, doors that fold, a stack of cards in depth, a
  tilt (`perspective`, `rotateX/Y`, `transform-style: preserve-3d`; the examples `card-flip`, `folding-doors`).
- **three.js** when the reference shows light on a form: a lit or reflective object, an extruded shape or letters
  with a cast shadow, a field of objects under an orbiting camera, soft clay. A flat drawing with a gradient is **not**
  an acceptable stand-in for these; it is the first thing a viewer sees. Entries: `three-chrome-knot`,
  `three-extruded-shape`, `three-cube-wave`, `three-clay`.

```bash
popost video scene library project --name three   # project/lib/three.min.js: three.js r147, 0.6 MB, unchanged, MIT
```

```html
<canvas id="gl" style="position:absolute;left:0;top:0;width:100%;height:100%"></canvas>
<script src="../lib/three.min.js"></script>
<script>
  var W = 1280, H = 720;                                                   // the canvas size the file declares
  var renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('gl'), antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1); renderer.setSize(W, H, false);               // made once
  var scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(35, W / H, 0.1, 100);
  /* geometry, materials, lights: once. An environment for reflections: a picture drawn on a 2D canvas,
     new THREE.CanvasTexture(c) with mapping = THREE.EquirectangularReflectionMapping, as scene.environment. */
  window.__popostScene = { render: function (seconds) {                    // every frame from the time alone
    mesh.rotation.y = seconds * 0.9; camera.position.set(Math.cos(seconds * 0.3) * 9, 3, Math.sin(seconds * 0.3) * 9); camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
  } };
</script>
```

- The renderer is created once, with `preserveDrawingBuffer: true` (the frame is read after it is drawn). No
  `setAnimationLoop`, no `requestAnimationFrame`, no `THREE.Clock`: the camera and every object are set from `seconds`.
- Nothing from the network: no HDR, no model, no texture file by URL. Draw the environment on a canvas; build shapes
  from `THREE.Shape` and `ExtrudeGeometry` (an SVG outline as points); a picture of the project by a relative path.
- Without a GPU the renderer draws with software GL: the result is the same on every render, at about 0.2 s a frame
  for a simple scene. Keep shadow maps at 2048 or less and instance counts in the hundreds.
- The package `three` is an optional dependency of the Skill (33 MB installed, of which the one file a project gets
  is 0.6 MB). When it was left out of an install, `scene library --name three` says how to add it.

## 8. Sound cues

Every effect says where a sound belongs, so that sound effects can be placed exactly on animation events without
looking at the picture.

**The contract.** A scene exposes a list of cues, each `{ "at": seconds from the start of the scene, "cue": the kind
of sound, "gain": 0..1 }` (`gain` 1 is the loudest hit of the shot; `effect`, optional, names what declared it):

- at run time, in `window.__popostScene.cues` (an array; the motion helper fills it: every effect adds its own, and
  `M.cue(at, name, gain)` adds one by hand);
- or as data, in `<script type="application/json" id="popost-cues">[{ "at": 0.42, "cue": "impact", "gain": 1 }]</script>`
  (a scene that uses a GSAP timeline and no helper writes its cues this way; ported catalogue entries carry such a block).

`popost video scene cues <project>` opens the scenes (it renders nothing) and prints every cue in the video's time:
`{ at (seconds of the video), frame, cue, gain, effect, segment, scene, local }`; a cue after the end of its segment is
left out and counted. `scene check` gives the number of cues per scene.

**The names**, and what each is for:

| Cue | Only on |
|---|---|
| `whoosh` | a large thing moving fast: a scene change, a card thrown in, a whip, speed lines |
| `swish` | a lighter, shorter move: a wipe, a morph, a group arriving |
| `pop` | a badge, a chip, a number or a sticker landing on a spring; a burst |
| `impact` | a slam, a landing, each contact of a bounce (gain falls with the bounces) |
| `rumble` | a shake of the ground after an impact |
| `click` | a pointer click on screen |
| `tick` | an element of a list arriving, a counter running |
| `type` | text arriving character by character (one cue for every third character) |
| `draw` | a pen stroke being drawn |
| `shimmer` | a sweep of light, rays opening, confetti falling |
| `sparkle` | sparks, stars |
| `glitch` | a glitch, a decode |
| `riser` | the build before the one payoff of the video; declare it by hand, once |
| `ding` | a result confirmed (a tick, a success); by hand, rarely |

**Placing rules**, for whoever places the sounds: a sound's peak falls on `at` (one frame later rather than earlier:
a sound that comes early feels wrong sooner than one that comes late); a hit sits a few dB over the bed and `gain`
scales it against the other hits of the shot; two or three takes of a repeated sound are rotated; few and exact beats
many: an effect's cue is a place where a sound may go, not an order to fill it.

**Cues of ported entries** are derived from their GSAP tweens by rule (`tools/video/port-hyperframes.mjs`, "CUE
RULES"): a scale from 1.5 or more landing in 0.35 s or less is an `impact` at its end; a `back` or `elastic` ease from a
small scale is a `pop`; a text plugin tween is `type`; a stroke offset is `draw`; a clip-path or a scale from 0 on one
axis is a `swish`; a move of 260 px or more within 0.9 s is a `whoosh`; a short rise with a fade is a `tick`; letters a
few hundredths apart are `type`. An entry whose tweens give none gets one cue from what it is. Check them against the
entry's sheet before a sound is placed on them.

## 9. Sources

This page is written for this engine, in its own words and structure. Numbers and rules were adapted from:

- **HyperFrames** (https://github.com/heygen-com/hyperframes, Copyright 2026 HeyGen, Inc., Apache License 2.0):
  `skills/hyperframes/references/motion.md` and `sound.md` at commit `a8332860c396e9224d42b7ea2a9cc8f42918c961`: ease by
  role, springs named by damping ratio, exits shorter than entrances, overlap and stagger, titles that land and stay
  still, the list of defaults that look generated, blur on fast moves, cutting on the fastest frame, and the rule that
  a sound has a cause on screen and peaks a frame after its picture. Changed: rewritten and reordered, the three
  layers, the recipes as functions of time, the cue contract and the 3D section are this Skill's.
- **LottieFiles motion-design-skill** (https://github.com/LottieFiles/motion-design-skill, Copyright (c) 2025
  LottieFiles, MIT License): squash and stretch proportions and frame counts, anticipation, follow-through delays, the
  overshoot budget by context, lengths by kind of element and the stagger budgets
  (`skills/motion-design/reference/timing-easing-tables.md`, `director/disney-principles.md`).

The licence texts are in the Skill's `THIRD_PARTY_NOTICES`.
