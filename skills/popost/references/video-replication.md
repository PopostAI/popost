# Strict video replication

Use this workflow when a reference supplies the video's format and the user replaces its subject, product, characters, or text. The user's brief can remain short. The agent must do the reference reading, event inventory, production mapping, and evidence review internally before spending on new media. A request to preserve the reference is not satisfied by matching its duration and broad layout alone.

This workflow extends [video.md](video.md), [video-elements.md](video-elements.md), [video-templates.md](video-templates.md), and [video-scenes.md](video-scenes.md). It does not replace their editable-project, generation, audio, budget, or delivery rules.

## 1. Establish source facts before paid production

Keep the real reference file, user brief, and supplied materials in the case's own directory. Read the opening, every shot, custom transitions, and the source audio. Use the actual frames to resolve mistaken automatic labels. An OCR line is not necessarily a subtitle; an ASR token is not necessarily dialogue or narration. Music vocals and recognition fragments must not create a new narrator.

Create the source contract next to the reference analysis:

```bash
popost video replication init ref --reference inputs/reference.mp4
popost video replication check ref --reference inputs/reference.mp4
```

Initialization binds the real source file's fingerprint and clock. It is not an automatic assertion that the agent has understood its visual style, speech, or story. Complete the inventory and evidence from the inspected source before choosing or buying production media. A successful local check is not a semantic content recognizer.

Record these source invariants:

- **Audio intent:** actual dialogue/narration, music, effects, ambient sound, and uncertainty. Preserve the original spoken voice/no-voice choice unless the user explicitly changes it. Intelligible sung lyrics can mean `sourceSpeech: "present"` with `sourceRoles: ["music"]` and `narration: "forbid"`; they do not imply voice-over. Confirm upstream `speech.json` kinds as well: on-camera lines belong to native/lip-synced footage, narration to voice-over, sung/fragments to neither. A language preference does not request a new narrator. Separate music defaults to `audio.music: "none"`; native clips retain their own sound. `preserve` or `requested` needs `musicEvidence` recording the actual user approval, including an already approved plan. Never add a filler voice, tone or music bed to make a quiet video seem finished.
- **Visual medium and finish:** photography, screen footage, polished character animation, cut paper, drawn animation, or designed graphics; the material, light, depth, texture, lens/focus and rendering treatment that make the source recognizable. “3D” alone is not a complete style description.
- **Objects and causality:** each actor and prop, its owner, where it appears, who moves or receives it, and the before/after states that make the payoff work. Count separate instances. Do not invent a hinge, handoff, reveal, or mechanism because it would be easy to animate.
- **Temporal mechanisms:** letter/word growth, cursor travel and pauses; separate rolling digit columns; a mark attached to its intended UI target; camera/foreground/focus changes; incoming and outgoing transition ownership; meaningful actions and comparison stages. A single uncut shot can contain many required events.
- **Content mapping:** which source roles stay fixed and which user-specified subjects change. Preserve the source's event and visual grammar while adapting its content. Unknowns remain unknown until inspected; do not hide them with generic prose or an empty unresolved list.

No paid generation is needed to write these facts. Keep source facts separate from a later production plan and from any final review.

## 2. Keep the four sidecars with the project

| File | Purpose |
| --- | --- |
| `replication.json` | Version 1 source contract: source fingerprint/FPS/frame count; audio intent and explicit overrides; visual medium/style; complete or unknown inventory; source-frame events and evidence. |
| `replication.plan.json` | Version 1 target mapping. `visual` has `medium`, `style`, `evidence[]`, and an optional explicit `userOverride`. Each event has `id`, optional `segment`/`scene`, target `span`, `method`, optional `mechanism`, and `evidence[]`. Map every required source event to its target implementation. |
| `replication.audio.json` | Version 1 audio-use manifest. Each item names its actual project-relative `file`, `sha256`, `kind` (`speak`, `sound`, `native`, or `bed`), `role`, `speech` presence, and `evidence[]`. Include direct sound files and native clip audio as well as explicit speech commands. Use an empty item list for genuinely silent output. |
| `replication.pairs.json` | Version 1 comparison-source manifest, when actual reference/remake pairs are used. Bind declared pair IDs, source provenance, both files/hashes, product/character/stage identity, source FPS, trims with explicit units, and semantic pairing evidence. |

When the user has approved preservation of a music/effects soundtrack, make the initial silent fill first, then:

```bash
popost video replication sound project --reference inputs/reference.mp4 --out project/assets/reference.wav --given "<the actual approval or approved-plan instruction>"
```

This local command verifies the bound original and actual decoded PCM, writes an independent source copy and a
`.replication-sound.json` receipt, records the explicit music policy and inventories the WAV. Add
`"sound": "assets/reference.wav"` to the fill and fill again. Project intent survives the refill; reference facts still
come from the template. A source containing spoken dialogue/narration cannot use this route: its old product words
must not be copied into the new video. Do not disguise reference extraction as an uploaded user sound. Unrequested
separate music remains off. An existing approval is not a reason to ask again.

Prefer `template fill --speak` for narration. A real registered-voice asset used directly must retain its
`.voice.json`, `voices.json`, registered voice reference, actual role and line intervals on a `role: "voice"` track;
it cannot be passed as a music `sound`. Native dialogue uses timed `speech.lines` and template beats. Keep the source
presenter's full/bubble/off intervals independent of the durations of generated takes.

Contract event `span` is a half-open interval `[start, end)` in **reference frames**. Plan event `span` is in **target frames**. Pair trims use the named side's source clock, with `unit: "frames"` or `"seconds"`; they do not silently inherit the project's FPS. Evidence `at` values, when used, are seconds on the named evidence file. Keep these units explicit.

Evidence has a kind (`observed`, `measured`, `user`, or `unknown`) and a concrete description. Local file evidence should include its project-relative path, actual SHA-256, media kind, and relevant frame or time interval. Unknown evidence does not establish a pass. Do not put placeholder hashes, future file paths, or a prose claim of success into a completed review.

`replication check` also prints `sourceRevision`. Put it in the final review beside `sourceFingerprint`. It hashes
the source reading, not target-only audio choices or local evidence paths. Changing an event, style or source audio
fact invalidates the former review even if the original video bytes are unchanged.

Different hashes prove different bytes, not that two clips show a valid before/after relationship. Preserve the actual supplied comparison stages and product/character identities. If the relationship is unknown, leave the pair pending instead of inventing an example or presenting the same source under two labels. Rendered crops, labels and trims must still resolve to the declared pair and narrative stage.

## 3. Choose a production route that can preserve the source

Use authored text, paths, masks, UI framing and deterministic motion for work they can reproduce accurately. Use real supplied/first-party UI footage for the actual product actions. Use the configured generation route when photographic, character, material, or performance detail needs generated media; keep reviewed case-local identity and setting anchors. New image assets follow the selected image workflow, including host prepare, actual host generation, inspection, and completion when the host channel is selected.

Code is not a universal replacement for a failed native job. A simple geometric character or generic slideshow is a different result when the source needs polished acting or photographic finish. An alternative route must meet the same accepted invariants, or require an explicit user change in those invariants. Permission to spend on repairs does not itself authorize a visual downgrade.

Preserve request keys, receipts and partial checkpoints. Reconcile ambiguous submissions before retrying. Distinguish upload failure, pending continuation, refunded upstream failure, and content rejection from their actual statuses. Do not infer a universal model failure, unsupported duration, or rejected subject from a generic upstream error. Keep failed or unresolved cases visible; do not claim native generation succeeded because an authored replacement file exists.

Quote and execute with the account, model, budget and approvals applicable to the session. A new contract does not authorize an account/provider switch, purchase, top-up, or social posting.

## 4. Author from the final filled timeline

Custom transition ownership can change a filled segment's first and last frame. Obtain the actual target timeline after filling:

```bash
popost video replication timeline project
popost video replication helpers --out project/lib/replication-motion.js
```

Use the reported segment starts, effect spans, owner and FPS. Do not reconstruct them from rounded reference seconds or keep stale hand-entered offsets. Carry the required media into a neighboring scene when its custom effect owns those frames; a decorative frame around an unloaded or expired media item is still a blank.

A scene receives seconds from its own segment's start. The engine may expose it early during a transition and seek frames in any order. Use one declared frame clock for its text, objects, media and marks. Do not add timers, wall-clock reads, random state, or an independent playback loop.

The exported helper file defines `window.popostMotion`. It has no network or Node dependency and changes no existing scene until that scene loads it. Load it synchronously from a scene in `scenes/`:

```html
<script src="../lib/replication-motion.js"></script>
```

### Typing with measured glyph positions

Compile a serializable typing plan once, after the actual font/layout is available. `start` plus `end` defines the complete interval including pauses; alternatively, give `start` plus `frames`, where `frames` counts active typing only. Give exactly one of `end` or `frames`. A pause's `after` counts complete graphemes already shown. It must precede at least one remaining grapheme.

```js
// Use the real canvas context and the actual loaded project font.
const ctx = document.querySelector('canvas').getContext('2d');
ctx.font = '24px monospace';
const M = window.popostMotion;
const text = 'One clear idea.';
const graphemes = [...new Intl.Segmenter('und', {
  granularity: 'grapheme'
}).segment(text)].map(s => s.segment);

// ctx.font must already be the real rendered font. Prefix widths include kerning.
const cursorStops = [[24, 30]];
let prefix = '';
for (const glyph of graphemes) {
  prefix += glyph;
  cursorStops.push([24 + ctx.measureText(prefix).width, 30]);
}
const typed = M.compileTyping({
  text, start: 0, end: 60,
  pauses: [{ after: 4, frames: 8 }],
  cursorStops, blinkFrames: 12, hideWhenDone: false
});

function drawTyping(frame) {
  const state = M.typingAt(typed, frame);
  ctx.textBaseline = 'top';
  ctx.fillText(state.text, 24, 30);
  if (state.cursor.visible) {
    ctx.fillRect(state.cursor.x, state.cursor.y, 3, 24);
  }
}
```

`cursorStops` has one point per visible prefix, including the empty prefix. Supply wrapped-line positions when needed. Alternatively provide one measured `advances` value per grapheme, `origin: [x, y]`, and `lineHeight`; newline graphemes then reset X and advance Y. Use prefix-width differences for kerning. Do not measure a fixed-width approximation and claim it follows proportional type. The compiled plan stores graphemes, reveal frames and cursor positions, so a later seek does not depend on what was drawn before it.

### Rolling digits, not a plain number count-up

`odometerAt` returns one column per place, each with `current`, `next`, fractional `offset`, `direction`, and `place`. The inputs are nonnegative safe integers. Keep cell width and the nearby label fixed while digits travel; clip each column to one cell.

```js
const digits = { from: 39, to: 40, start: 0, frames: 36,
  places: 2, stagger: 4, turns: 1, ease: 'out' };

function drawDigits(frame) {
  const state = M.odometerAt(digits, frame);
  const x = 24, y = 96, cellWidth = 24, cellHeight = 30;
  ctx.textBaseline = 'top';
  state.columns.forEach((column, index) => {
    const left = x + index * cellWidth;
    const shift = column.offset * cellHeight * column.direction;
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, y, cellWidth, cellHeight);
    ctx.clip();
    ctx.fillText(String(column.current), left, y - shift);
    ctx.fillText(String(column.next), left,
      y - shift + cellHeight * column.direction);
    ctx.restore();
  });
  // Reserve the number's maximum width, not the current glyph ink width.
  ctx.fillText('items', x + digits.places * cellWidth + 16, y);
}
```

`frames` is each column's travel time. Total span is `frames + (places - 1) * stagger`. Fit that full span into the measured target event. `turns` adds complete digit-column turns; it does not invent new factual values. Use the source's reveal order, direction and timing rather than assuming this example's settings.

Check actual measured number/label bounds with `layoutConflicts([{id, box}, ...], gap)`. Boxes are `[x,y,width,height]` in the same coordinate system. Conflicts must be resolved through the layout/font choice, not hidden by changing the source fact or silently compressing the label. The helper reports collisions; it does not pretend to recognize arbitrary painted text.

### Local/source clocks, camera keys and attached marks

Use the final filled timeline's frame mapping. This standalone example begins at source frame zero; in a multi-segment scene, inject its real start through a declared slot rather than copying a guessed number.

```html
<span data-slot="source-start" hidden>0</span>
```

```js
const sourceStart = Number(document.querySelector(
  '[data-slot="source-start"]').textContent);

function frameAt(seconds, fps) {
  return M.sceneClock(seconds, { fps, sourceStart });
}

// A vector can contain 3D position, target, lens/focus, or another numeric state.
const cameraKeys = [
  { frame: 0, value: [0, 2, 8, 0, 1, 0], ease: 'in-out' },
  { frame: 60, value: [2, 3, 6, 0, 1, 0] }
];
function cameraAt(localFrame) {
  return M.keyframeAt(cameraKeys, localFrame);
}

function drawMarkedPanel(localFrame) {
  const view = M.keyframeAt([
    { frame: 0, value: [1, 0, 0, 1, 0, 0] },
    { frame: 60, value: [1.2, 0, 0, 1.2, -20, -10] }
  ], localFrame);
  const box = [40, 80, 150, 50];
  ctx.save();
  ctx.setTransform(...view);
  ctx.fillRect(...box); // Content and marks share this exact viewport.
  ctx.restore();
  const visibleBox = M.viewportBox(box, view);
  ctx.strokeRect(...visibleBox);
  const [a, b] = M.viewportUnderline(box, view, 5);
  ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
}

window.__popostScene = {
  render(seconds, fps) {
    const clock = frameAt(seconds, fps);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    // Draw every controlled value from this frame, including after a backwards seek.
    // Use localFrame for local keys; sourceFrame for explicitly source-keyed data.
    drawTyping(clock.localFrame);
    drawDigits(clock.localFrame);
    drawMarkedPanel(clock.localFrame);
  }
};
```

`sceneClock` also accepts `sourceFps`, `sourceFrames` and `speed` when mapping into a real source file with a different clock. It reuses the footage frame mapping and clamps to the declared source's final frame. Do not use the source frame to index target-local events or add the segment offset twice. `keyframeAt` holds endpoint values, interpolates vectors with the existing easing curves, and supports `hold:true` for an explicit state until the next key.

`viewportBox` returns an axis-aligned extent. For a rotated outline, transform its four corners with `viewportPoint`; the underline's endpoints already follow rotation. The transform convention is Canvas/SVG `[a,b,c,d,e,f]`. Apply it to the content, target box, emphasis mark and any related label from the same source coordinates. Separate guessed zoom offsets make marks drift.

## 5. Review the actual artifact, then deliver

Run the normal render and visual/speech checks, inspect the original and output together, and correct actual failures. Record an output review only after the artifact exists:

```bash
popost video replication check project --reference inputs/reference.mp4 \
  --artifact renders/final.mp4 --review review.json
```

The review binds the actual source fingerprint, artifact fingerprint, target FPS and frame count. It separately records audio, visual, and every required event as pending, passed, failed or unknown, with evidence. Include all actual audio uses in the audio manifest. A generated speech file routed through a generic `sound` field still counts as added speech; it cannot bypass the no-new-narrator rule.

For every temporal event, inspect at least two different actual output frame indices; add intermediate states when a path, interaction or reveal needs them. Bind those indices to the real artifact hash. A source contact sheet, one attractive output frame, a statement saying “passed,” or evidence from an older render does not prove current motion. Recheck after any edit changes the artifact bytes.

Check the first seconds densely enough to distinguish a static sentence from typing and a sharp prop close-up from a focus reveal. Check object ownership and causal state changes, digit/label spacing during the roll, marks under the actual viewport motion, media coverage across transition boundaries, source-like acting/material finish, full duration and audio intent. Automated measurements and composite similarity scores are diagnostics; they do not establish semantic pairing or faithful performance.

Keep `artifactReady`, `requirementsMet` and quality status distinct. A playable file can still need review or iteration. Unknown source facts or unresolved native failures must stay visible. Do not declare a style/acting requirement met because a geometrical substitute has equal runtime. Deliver the editable project and the actual comparison, content and limitations required by the user; preserve the checkpoint for precise later repairs.

Existing projects without the new sidecars keep their previous behavior. Do not silently migrate, rewrite, add speech to, regenerate, or invalidate unrelated projects when using this workflow for an approved repair set.
