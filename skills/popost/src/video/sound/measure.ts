/**
 * What a program can measure of a sound without listening to it: its level over time, its silences, its onsets (the
 * moments something new begins: a hit, a note, a word), a tempo with a beat grid, and how the picture's events line up
 * with them. The input is one channel of PCM samples in -1..1 (sound/pcm.ts decodes a file to it with ffmpeg); every
 * result is rounded, so the same samples give the same JSON. No model: what kind of sound it is (music, a voice, an
 * effect) is not decided here; the hosted sound analysis says that (sound/analysis.ts). Pure.
 */

/** The rate the measurement works at: enough for onsets and tempo, and half the samples of a 44.1 kHz file. */
export const ANALYSIS_RATE = 22050;
/** The spectrum is taken over FRAME samples every HOP samples: 46 ms windows, one every 11.6 ms. */
export const FRAME = 1024;
export const HOP = 256;
/** A level below this is silence: -50 dBFS is under the noise of an ordinary recording and above digital silence. */
export const SILENCE_DB = -50;
/** A silence is at least this long: shorter gaps are the pauses inside speech and between notes. */
export const SILENCE_SECONDS = 0.3;
/** The lowest level written: digital silence has none. */
export const FLOOR_DB = -90;
/** The tempi looked for. Below 50 and above 210 beats a minute a pulse is heard as half or double of one inside. */
export const BPM_RANGE = [50, 210] as const;
/** How near an event lies to a beat or an onset to count as on it: two frames of a 30 fps video. */
export const ON_BEAT_SECONDS = 0.07;

const r1 = (v: number): number => Math.round(v * 10) / 10;
const r2 = (v: number): number => Math.round(v * 100) / 100;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/** The RMS level of samples from..to-1 in dBFS (a full-scale sine is -3), never below FLOOR_DB. */
export const rmsDb = (pcm: Float32Array, from = 0, to = pcm.length): number => {
  const a = Math.max(0, Math.floor(from)), b = Math.min(pcm.length, Math.ceil(to));
  if (b <= a) return FLOOR_DB;
  let sum = 0;
  for (let i = a; i < b; i++) sum += (pcm[i] ?? 0) ** 2;
  const rms = Math.sqrt(sum / (b - a));
  return rms > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(rms)) : FLOOR_DB;
};

/** The level of each window of `step` seconds, in dBFS to a tenth. It is an RMS level, not a K-weighted loudness. */
export const levelCurve = (pcm: Float32Array, rate: number, step = 0.5): number[] => {
  const size = Math.max(1, Math.round(step * rate));
  return Array.from({ length: Math.ceil(pcm.length / size) }, (_, i) => r1(rmsDb(pcm, i * size, (i + 1) * size)));
};

/** The spans (seconds) in which the level stays under `db` for at least `least` seconds, read in 50 ms steps. */
export const silencesOf = (pcm: Float32Array, rate: number, db = SILENCE_DB, least = SILENCE_SECONDS): [number, number][] => {
  const size = Math.max(1, Math.round(0.05 * rate));
  const out: [number, number][] = [];
  let start = -1;
  const n = Math.ceil(pcm.length / size);
  for (let i = 0; i <= n; i++) {
    const quiet = i < n && rmsDb(pcm, i * size, (i + 1) * size) < db;
    if (quiet && start < 0) start = i;
    if (!quiet && start >= 0) {
      const a = (start * size) / rate, b = Math.min(pcm.length, i * size) / rate;
      if (b - a >= least) out.push([r2(a), r2(b)]);
      start = -1;
    }
  }
  return out;
};

/** In-place radix-2 FFT of FRAME real samples; returns the magnitudes of bins 0..FRAME/2-1. */
const spectrum = (() => {
  const n = FRAME, bits = Math.log2(n);
  const reverse = new Uint16Array(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); reverse[i] = r; }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = Math.sin((2 * Math.PI * i) / n); }
  const hann = new Float64Array(n);
  for (let i = 0; i < n; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  const re = new Float64Array(n), im = new Float64Array(n);
  return (pcm: Float32Array, at: number, out: Float64Array): void => {
    for (let i = 0; i < n; i++) { re[reverse[i] as number] = (pcm[at + i] ?? 0) * (hann[i] as number); im[i] = 0; }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0; j < half; j++) {
          const c = cos[j * step] as number, s = sin[j * step] as number;
          const a = i + j, b = a + half;
          const xr = (re[b] as number) * c + (im[b] as number) * s, xi = (im[b] as number) * c - (re[b] as number) * s;
          re[b] = (re[a] as number) - xr; im[b] = (im[a] as number) - xi;
          re[a] = (re[a] as number) + xr; im[a] = (im[a] as number) + xi;
        }
      }
    }
    for (let k = 0; k < n / 2; k++) out[k] = Math.hypot(re[k] as number, im[k] as number) / (n / 4);
  };
})();

/** Frames of the onset envelope a second, at `rate`. */
export const envelopeRate = (rate: number): number => rate / HOP;

/**
 * The onset envelope: for every hop, how much the spectrum grew since the hop before (spectral flux of
 * log-compressed magnitudes, the growth only). A hit, a new note and the start of a word each raise it; a held tone
 * does not. Value i belongs to the window that starts at sample i * HOP.
 */
export const onsetEnvelope = (pcm: Float32Array): Float32Array => {
  const frames = Math.max(0, Math.floor((pcm.length - FRAME) / HOP) + 1);
  const env = new Float32Array(frames);
  let prev = new Float64Array(FRAME / 2), cur = new Float64Array(FRAME / 2);
  for (let i = 0; i < frames; i++) {
    spectrum(pcm, i * HOP, cur);
    let flux = 0;
    for (let k = 1; k < FRAME / 2; k++) {
      // log(1 + 100 m): a quiet onset counts beside a loud one, as it does to the ear.
      const v = Math.log1p(100 * (cur[k] as number));
      cur[k] = v;
      const d = v - (prev[k] as number);
      if (d > 0) flux += d;
    }
    env[i] = i === 0 ? 0 : flux;
    [prev, cur] = [cur, prev];
  }
  return env;
};

/**
 * Where in its window an onset is heard to begin: a click raises the envelope most when it enters the last quarter
 * of the Hann window. Measured on synthetic clicks (tests/video/sound-measure.test.ts: within 15 ms).
 */
const ONSET_AT = 0.86;
/** An onset is a peak of the envelope over this many hops each side (35 ms) ... */
const PEAK_HOPS = 3;
/** ... above 1.5 times the mean of the 0.4 s around it plus a twentieth of the sound's strongest onsets ... */
const LOCAL_FACTOR = 1.5, GLOBAL_SHARE = 0.05, AROUND_SECONDS = 0.2;
/** ... and at least this long after the onset before it ... */
const ONSET_GAP_SECONDS = 0.07;
/**
 * ... and above this in absolute terms (the flux of log-compressed magnitudes summed over the spectrum): a held tone
 * and digital silence leave rounding noise a hundredth of this, a click 40 dB under full scale about ten times it.
 */
const ONSET_FLOOR = 0.5;

export interface Onset { t: number; strength: number }

const percentile = (values: Float32Array, p: number): number => {
  if (!values.length) return 0;
  const sorted = Float32Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
};

/** The onsets of an envelope: time in seconds, strength 0..1 against the strongest onsets of the sound (its 99.5th percentile). */
export const onsetsOf = (env: Float32Array, rate: number): Onset[] => {
  const fps = envelopeRate(rate), top = percentile(env, 0.995);
  if (!(top >= ONSET_FLOOR)) return [];
  const around = Math.max(1, Math.round(AROUND_SECONDS * fps));
  // A running sum gives every local mean in one pass.
  const sums = new Float64Array(env.length + 1);
  for (let i = 0; i < env.length; i++) sums[i + 1] = (sums[i] as number) + (env[i] as number);
  const out: Onset[] = [];
  for (let i = 1; i < env.length - 1; i++) {
    const v = env[i] as number;
    let peak = true;
    for (let j = Math.max(0, i - PEAK_HOPS); j <= Math.min(env.length - 1, i + PEAK_HOPS) && peak; j++) if ((env[j] as number) > v || ((env[j] as number) === v && j < i)) peak = false;
    if (!peak) continue;
    const a = Math.max(0, i - around), b = Math.min(env.length, i + around + 1);
    const mean = ((sums[b] as number) - (sums[a] as number)) / (b - a);
    if (v < ONSET_FLOOR || v < LOCAL_FACTOR * mean + GLOBAL_SHARE * top) continue;
    const t = (i * HOP + ONSET_AT * FRAME) / rate;
    const last = out[out.length - 1];
    if (last && t - last.t < ONSET_GAP_SECONDS) { if (v / top > last.strength) out[out.length - 1] = { t: r3(t), strength: r2(Math.min(1, v / top)) }; continue; }
    out.push({ t: r3(t), strength: r2(Math.min(1, v / top)) });
  }
  return out;
};

export interface Tempo {
  bpm: number;
  /** 0..1: how strongly the envelope repeats at this period (its autocorrelation there against lag 0). Under 0.2 there is no steady pulse to speak of. */
  confidence: number;
  /** Seconds between beats, and the time of the first beat. */
  period: number;
  first: number;
  /** Other periods that repeat nearly as well (often half or double), strongest first. */
  others: { bpm: number; confidence: number }[];
}

/**
 * The tempo of an envelope by autocorrelation: the lag at which the envelope best matches itself, among the lags of
 * BPM_RANGE, weighted towards 120 beats a minute (one octave either way counts 0.6), since a pulse repeats at its half
 * and its double as well. The grid's first beat is the phase at which the beats collect the most envelope. undefined
 * for a sound too short (under four seconds) or without onsets. A low confidence is information: no default is put in
 * its place.
 */
export const tempoOf = (env: Float32Array, rate: number): Tempo | undefined => {
  const fps = envelopeRate(rate);
  if (env.length < 4 * fps) return undefined;
  let mean = 0;
  for (const v of env) mean += v;
  mean /= env.length;
  // Onsets are a hop or two wide: spread over five hops, a period that is not a whole number of hops still matches itself.
  const sharp = Float64Array.from(env, (v) => (v >= ONSET_FLOOR ? Math.max(0, v - mean) : 0));
  const x = Float64Array.from(sharp, (_v, i) => ((sharp[i - 2] ?? 0) + 2 * (sharp[i - 1] ?? 0) + 3 * (sharp[i] ?? 0) + 2 * (sharp[i + 1] ?? 0) + (sharp[i + 2] ?? 0)) / 9);
  let zero = 0;
  for (const v of x) zero += v * v;
  if (!(zero > 0)) return undefined;
  const lo = Math.floor((60 / BPM_RANGE[1]) * fps), hi = Math.min(Math.ceil((60 / BPM_RANGE[0]) * fps), Math.floor(x.length / 2));
  const acf = new Float64Array(hi + 2);
  for (let lag = Math.max(1, lo - 1); lag <= hi + 1 && lag < x.length; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < x.length; i++) sum += (x[i] as number) * (x[i + lag] as number);
    // Normalised by the samples that overlap, so that a long lag is not held back by having fewer of them.
    acf[lag] = (sum / (x.length - lag)) / (zero / x.length);
  }
  const weight = (lag: number): number => Math.exp(-0.5 * Math.log2((60 * fps) / lag / 120) ** 2);
  const peaks: { lag: number; value: number }[] = [];
  for (let lag = lo; lag <= hi; lag++) if ((acf[lag] as number) > (acf[lag - 1] as number) && (acf[lag] as number) >= (acf[lag + 1] as number) && (acf[lag] as number) > 0) peaks.push({ lag, value: acf[lag] as number });
  if (!peaks.length) return undefined;
  peaks.sort((a, b) => b.value * weight(b.lag) - a.value * weight(a.lag));
  const best = peaks[0] as { lag: number; value: number };
  // A parabola through the peak and its neighbours places it between whole lags.
  const [l, c, rgt] = [acf[best.lag - 1] as number, acf[best.lag] as number, acf[best.lag + 1] as number];
  const shift = l - 2 * c + rgt === 0 ? 0 : (0.5 * (l - rgt)) / (l - 2 * c + rgt);
  const lag = best.lag + Math.max(-0.5, Math.min(0.5, shift));
  const period = lag / fps;
  let phase = 0, most = -1;
  for (let p = 0; p < Math.round(lag); p++) {
    let sum = 0;
    for (let k = 0; p + k * lag < x.length; k++) sum += x[Math.round(p + k * lag)] ?? 0;
    if (sum > most) { most = sum; phase = p; }
  }
  const first = (phase * HOP + ONSET_AT * FRAME) / rate;
  return {
    bpm: r1(60 / period), confidence: r2(Math.max(0, Math.min(1, best.value))), period: r3(period), first: r3(first % period),
    others: peaks.slice(1, 3).map((p) => ({ bpm: r1((60 * fps) / p.lag), confidence: r2(Math.max(0, Math.min(1, p.value))) })),
  };
};

/** The beats of a grid from its first beat to `seconds`. */
export const beatsOf = (tempo: Pick<Tempo, 'period' | 'first'>, seconds: number): number[] => {
  const out: number[] = [];
  for (let k = 0; tempo.period > 0 && tempo.first + k * tempo.period <= seconds; k++) out.push(r3(tempo.first + k * tempo.period));
  return out;
};

export interface Alignment {
  /** The events held against the sound. */
  events: number;
  /** The share of them within ON_BEAT_SECONDS of a beat, and what events placed without regard to the beat would give. */
  onBeat?: number;
  byChance?: number;
  /** The share within ON_BEAT_SECONDS of an onset. */
  onOnset: number;
}

const near = (sorted: readonly number[], t: number, tolerance: number): boolean => {
  let a = 0, b = sorted.length - 1;
  while (a < b) { const m = (a + b) >> 1; if ((sorted[m] as number) < t) a = m + 1; else b = m; }
  return [sorted[a - 1], sorted[a]].some((x) => x !== undefined && Math.abs(x - t) <= tolerance);
};

/** How events of the picture (cuts, motion events; seconds) line up with the beat grid and with the onsets. */
export const alignmentOf = (events: readonly number[], onsets: readonly Onset[], tempo: Tempo | undefined, tolerance = ON_BEAT_SECONDS): Alignment => {
  const n = events.length;
  const share = (hits: number): number => (n ? r2(hits / n) : 0);
  const times = onsets.map((o) => o.t);
  const onOnset = share(events.filter((t) => near(times, t, tolerance)).length);
  if (!tempo) return { events: n, onOnset };
  const onBeat = events.filter((t) => { const k = Math.round((t - tempo.first) / tempo.period); return Math.abs(t - (tempo.first + k * tempo.period)) <= tolerance; }).length;
  return { events: n, onBeat: share(onBeat), byChance: r2(Math.min(1, (2 * tolerance) / tempo.period)), onOnset };
};

export interface SoundMeasure {
  seconds: number;
  /** RMS level in dBFS of every `step` seconds, its highest value and the level of the whole sound. */
  level: { step: number; db: number[]; peakDb: number; meanDb: number };
  /** Integrated loudness (EBU R 128, LUFS) when ffmpeg measured it. */
  loudness?: number;
  silences: [number, number][];
  /** The share of the sound that is silence. */
  silentShare: number;
  onsets: Onset[];
  tempo?: Tempo;
  /** The picture against the sound: the cuts, and the motion events of the shots. */
  cuts?: Alignment;
  motion?: Alignment;
}

/** Everything above for one sound. cuts and motion: times in seconds of the picture's events, when a measurement of it is at hand. */
export const measureSound = (pcm: Float32Array, rate: number, picture: { cuts?: readonly number[]; motion?: readonly number[] } = {}): SoundMeasure => {
  const seconds = pcm.length / rate;
  const db = levelCurve(pcm, rate);
  const silences = silencesOf(pcm, rate);
  const env = onsetEnvelope(pcm);
  const onsets = onsetsOf(env, rate);
  const tempo = onsets.length >= 4 ? tempoOf(env, rate) : undefined;
  return {
    seconds: r2(seconds),
    level: { step: 0.5, db, peakDb: db.length ? Math.max(...db) : FLOOR_DB, meanDb: r1(rmsDb(pcm)) },
    silences, silentShare: seconds > 0 ? r2(silences.reduce((n, [a, b]) => n + b - a, 0) / seconds) : 1,
    onsets, ...(tempo ? { tempo } : {}),
    ...(picture.cuts?.length ? { cuts: alignmentOf(picture.cuts, onsets, tempo) } : {}),
    ...(picture.motion?.length ? { motion: alignmentOf(picture.motion, onsets, tempo) } : {}),
  };
};

/**
 * The time of a one-shot sound's hit: the 5 ms window with the highest level, at its middle. An effect is placed so
 * that this moment meets the picture's event (sound/sfx-place.ts).
 */
export const peakTime = (pcm: Float32Array, rate: number): number => {
  const size = Math.max(1, Math.round(0.005 * rate));
  let best = 0, most = -1;
  for (let i = 0; i + size <= pcm.length; i += Math.max(1, size >> 1)) {
    let sum = 0;
    for (let j = i; j < i + size; j++) sum += (pcm[j] ?? 0) ** 2;
    if (sum > most) { most = sum; best = i; }
  }
  return r3((best + size / 2) / rate);
};
