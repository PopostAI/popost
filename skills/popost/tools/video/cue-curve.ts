/**
 * The pure half of check-cues.ts (maintainer tool): where a picture's changes start and peak, from its frames, and how
 * far each sound cue sits from the change it belongs to. Frames are integers at the scene's frame rate; d[f] and
 * fresh[f] describe the step from frame f-1 to frame f (index 0 is not used).
 */

/** One change of the picture: the frame it shows on first, the frame of its largest step, the last frame it runs on. */
export interface Change { onset: number; peak: number; end: number; by: 'start' | 'jump' | 'fresh' }

export interface CueVerdict {
  cue: string;
  at: number;
  /** The cue's frame (at x fps, rounded). */
  frame: number;
  /** cue frame - change frame: negative, the sound comes before the picture. */
  offsetFrames: number;
  /**
   * ok: within OK_FRAMES of its change. early / late: the nearest change is up to NEAR_FRAMES away. inside: a cue of a
   * row of the same kind (a stagger, typing, a counter) inside a running change whose own start the curve cannot tell
   * apart, or a cue far from every change on a picture that still moves faintly; left for the eye. nothing: no change
   * within NEAR_FRAMES and a still picture at the cue.
   */
  verdict: 'ok' | 'early' | 'late' | 'inside' | 'nothing' | 'error';
  /** The frame the cue was judged against (an onset, or a peak for impact and pop), and how that change was found. */
  change?: number;
  by?: Change['by'] | 'peak' | 'landing' | 'faint';
  note?: string;
}

/** A frame changes when more than this share of its pixels moved (6 pixels of a 320x180 frame: one typed letter of small code text moves about ten). */
export const QUIET = 0.0001;
/** A change a sound can belong to moves at least this share of the pixels in one step (17 pixels of 320x180). */
export const SALIENT = 0.0003;
/** Inside a running change, a new one starts where the curve jumps to JUMP times its recent low and by JUMP_MIN. */
const JUMP = 3, JUMP_MIN = 4 * QUIET, LOOK_BACK = 4;
/** Pixels that start to change where nothing changed in the last FRESH_BACK steps (a new element, a new word). */
const FRESH_BACK = 3, FRESH_GROW = 2;
export const OK_FRAMES = 2, NEAR_FRAMES = 15;
/** Cues of one kind closer than this (seconds) form a row: a stagger, typing, the ticks of a counter. */
const ROW_GAP = 0.4;
/** Cues heard at the hit of their change, not at its start. */
export const PEAK_CUES = new Set(['impact', 'pop']);

/**
 * The curves of grey frames (w x h bytes each, one after another): d, the share of pixels that moved by more than
 * level; fresh, the share that moved where no pixel within FRESH_GROW moved in the FRESH_BACK steps before.
 */
export const curvesOfGrey = (raw: Uint8Array, w: number, h: number, level = 6): { d: number[]; fresh: number[] } => {
  const size = w * h, n = Math.floor(raw.length / size), d = [0], fresh = [0];
  let recent: Uint8Array[] = [];
  for (let f = 1; f < n; f++) {
    const moved = new Uint8Array(size), near = new Uint8Array(size);
    let count = 0, newCount = 0;
    for (let i = 0, a = f * size, b = (f - 1) * size; i < size; i++) if (Math.abs((raw[a + i] as number) - (raw[b + i] as number)) > level) { moved[i] = 1; count++; }
    for (let i = 0; i < size; i++) if (moved[i] && !recent.some((m) => m[i])) newCount++;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (moved[y * w + x])
      for (let yy = Math.max(0, y - FRESH_GROW); yy <= Math.min(h - 1, y + FRESH_GROW); yy++) near.fill(1, yy * w + Math.max(0, x - FRESH_GROW), yy * w + Math.min(w - 1, x + FRESH_GROW) + 1);
    recent = [near, ...recent].slice(0, FRESH_BACK);
    d.push(count / size);
    fresh.push(newCount / size);
  }
  return { d, fresh };
};

const at = (v: readonly number[], f: number): number => v[f] ?? 0;
/** The lowest step of the running change in the LOOK_BACK frames before f (quiet frames before its start do not count). */
const lowOf = (v: readonly number[], f: number): number => Math.min(...v.slice(Math.max(1, f - LOOK_BACK), f).filter((x) => x > QUIET).concat([Infinity]));
const jumped = (v: readonly number[], f: number): boolean => { const low = lowOf(v, f); return at(v, f) >= JUMP * low && at(v, f) - low >= JUMP_MIN; };

/** The changes a sound can belong to: salient runs out of quiet, jumps inside a running change, bursts of fresh pixels. */
export const changesOf = (d: readonly number[], fresh: readonly number[] = []): Change[] => {
  const starts: { f: number; by: Change['by'] }[] = [];
  for (let f = 1; f < d.length; f++) {
    if (at(d, f) <= QUIET) continue;
    if (f === 1 || at(d, f - 1) <= QUIET) starts.push({ f, by: 'start' });
    else if (jumped(d, f) && !jumped(d, f - 1)) starts.push({ f, by: 'jump' });
    else if (at(fresh, f) >= SALIENT && at(fresh, f) >= 3 * Math.max(at(fresh, f - 1), QUIET)) starts.push({ f, by: 'fresh' });
  }
  const changes = starts.map((s, i) => {
    const next = starts[i + 1]?.f ?? d.length;
    let end = s.f, peak = s.f, top = 0;
    for (let f = s.f; f < next && at(d, f) > QUIET; f++) { end = f; if (at(d, f) > at(d, peak)) peak = f; }
    // A run out of quiet counts when it moves enough somewhere before it goes quiet again (past later jumps too).
    for (let f = s.f; f < d.length && at(d, f) > QUIET; f++) top = Math.max(top, at(d, f));
    return { onset: s.f, peak, end, by: s.by, top };
  });
  return changes.filter((c) => c.top >= SALIENT && (c.by !== 'fresh' || at(fresh, c.onset) >= SALIENT)).map(({ top: _top, ...c }) => c);
};

/** What check-cues.ts proposes for an entry: its cues with the misplaced ones moved or removed. */
export interface Proposal { cues: { at: number; cue: string; gain: number }[]; moved: number; removed: number }

/**
 * The cues an entry should have, from their verdicts: ok and inside stay; early and late move to their change; a cue on
 * nothing is removed, unless every cue of the entry would go, when the first one moves to the first change of the scene
 * (an entry with a change keeps at least one sound). Undefined when nothing needs to change, and when the picture never
 * changes in the frames drawn (a transition between two equal stand-ins): such cues cannot be judged here.
 */
export const proposeCues = (d: readonly number[], cues: readonly { at: number; cue: string; gain: number }[], verdicts: readonly CueVerdict[], fps: number, fresh: readonly number[] = []): Proposal | undefined => {
  const r3 = (v: number): number => Math.round(v * 1000) / 1000;
  if (!changesOf(d, fresh).length) return undefined;
  let moved = 0, removed = 0;
  const kept: { at: number; cue: string; gain: number }[] = [];
  cues.forEach((c, i) => {
    const v = verdicts[i];
    if (!v || v.verdict === 'ok' || v.verdict === 'inside' || v.verdict === 'error') { kept.push(c); return; }
    if ((v.verdict === 'early' || v.verdict === 'late') && v.change !== undefined) { kept.push({ ...c, at: r3(v.change / fps) }); moved++; return; }
    removed++;
  });
  if (!kept.length && cues.length) {
    const first = changesOf(d, fresh)[0], c = cues[0] as { at: number; cue: string; gain: number };
    if (first) { kept.push({ ...c, at: r3((PEAK_CUES.has(c.cue) ? first.peak : first.onset) / fps) }); removed--; moved++; }
  }
  // Two cues of one kind closer than a tenth of a second after the moves are one sound (as the port keeps them).
  const out = kept.sort((a, b) => a.at - b.at).filter((c, i, all) => !all.slice(0, i).some((x) => x.cue === c.cue && Math.abs(x.at - c.at) < 0.1));
  removed += kept.length - out.length;
  return moved || removed ? { cues: out, moved, removed } : undefined;
};

/** Local tops of the curve that move enough (a hit inside a running move: each bounce of a ball). */
const peaksOf = (d: readonly number[]): number[] => {
  const out: number[] = [];
  for (let f = 1; f < d.length; f++) if (at(d, f) >= SALIENT && at(d, f) >= Math.max(...d.slice(Math.max(1, f - 2), f + 3))) out.push(f);
  return out;
};

/**
 * Every cue against the nearest change: its onset; for pop its onset or a peak (a small pop among larger changes has
 * no top of its own, and its start and top are a frame or two apart); for impact a peak or the frame a move lands on.
 */
export const judgeCues = (d: readonly number[], cues: readonly { at: number; cue: string }[], fps: number, fresh: readonly number[] = []): CueVerdict[] => {
  const changes = changesOf(d, fresh);
  const onsets = changes.map((x) => ({ f: x.onset, by: x.by }));
  const peaks = [...changes.map((x) => ({ f: x.peak, by: 'peak' as const })), ...peaksOf(d).map((f) => ({ f, by: 'peak' as const }))];
  const landings = changes.filter((x) => at(d, x.end + 1) <= QUIET).map((x) => ({ f: x.end, by: 'landing' as const }));
  // Frames are exact, so a change that rises from a still picture is real however small (a thin line that starts to draw,
  // one typed letter): it is the cue's change when it starts within OK_FRAMES of the cue, never a place to move one to.
  const faintStarts = d.map((x, f) => (f > 1 && x > 0 && at(d, f - 1) === 0 ? f : -1)).filter((f) => f > 0);
  return cues.map((c) => {
    const frame = Math.round(c.at * fps);
    const marks: { f: number; by: CueVerdict['by'] }[] = c.cue === 'impact' ? [...peaks, ...landings] : c.cue === 'pop' ? [...peaks, ...onsets] : onsets;
    const best = marks.reduce<{ f: number; by: CueVerdict['by'] } | undefined>((b, x) => (b === undefined || Math.abs(x.f - frame) < Math.abs(b.f - frame) ? x : b), undefined);
    if (!best) return { cue: c.cue, at: c.at, frame, offsetFrames: 0, verdict: 'nothing' as const, note: 'nothing visible changes in the frames drawn' };
    const faintStart = faintStarts.find((f) => Math.abs(f - frame) <= OK_FRAMES);
    if (faintStart !== undefined && Math.abs(frame - best.f) > OK_FRAMES) return { cue: c.cue, at: c.at, frame, offsetFrames: frame - faintStart, verdict: 'ok' as const, change: faintStart, by: 'faint' as const };
    const offsetFrames = frame - best.f;
    const inRow = cues.some((o) => o !== c && o.cue === c.cue && Math.abs(o.at - c.at) < ROW_GAP);
    const moving = at(d, frame) > QUIET || at(d, frame + 1) > QUIET;
    // Far from every change but on a picture that still moves a little (small typing, a thin stroke, a scroll that never
    // stops): its change is too faint or too even to be found, so it is left for the eye, not removed.
    const faint = d.slice(Math.max(1, frame - 1), frame + 4).some((x) => x > 0);
    const verdict = Math.abs(offsetFrames) <= OK_FRAMES ? 'ok' : inRow && moving ? 'inside' : Math.abs(offsetFrames) <= NEAR_FRAMES ? (offsetFrames < 0 ? 'early' : 'late') : faint ? 'inside' : 'nothing';
    return { cue: c.cue, at: c.at, frame, offsetFrames, verdict, change: best.f, by: best.by };
  });
};
