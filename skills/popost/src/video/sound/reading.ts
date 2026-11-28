/**
 * The reading of a reference's sound, as describe writes it (sound.json) and as the card, the template and the plan
 * say it: what a program measured (sound/measure.ts), what a listener said (the hosted sound analysis, when it ran),
 * and what follows for the re-make. Whether the re-make has music, ambience and effects follows this reading, not
 * taste (video-sound.md, rules R2 and R5): music in the reference means one music bed for the whole video; no music
 * means none; a reading that could not tell says so and plans none until someone listens. Pure.
 */
import type { SoundAnalysisResult } from '../hosted-api';
import type { SoundMeasure } from './measure';

export const SOUND_FILE = 'sound.json';
export const SOUND_FORMAT = 'popost-video-sound';

/**
 * Why there is, or is not, a listener's reading: done; the video has no sound; --no-sound-analysis; no account is
 * connected; the platform does not offer it (an older server); the sound is longer than it takes; it failed.
 */
export type AnalysisStatus = 'done' | 'silent' | 'skipped' | 'no-account' | 'unavailable' | 'too-long' | 'failed';

export interface SoundAnalysisRecord { status: AnalysisStatus; why?: string; id?: string; chargedCredits?: number; result?: SoundAnalysisResult }

export type Known = 'yes' | 'no' | 'unknown';

/** What the re-make is held to: the facts of the reference's sound in a few fields, each with how it is known. */
export interface SoundFacts {
  /** yes and no: a listener said so (or the video is silent). likely: only measured (a steady pulse through the sound). unknown: nobody listened. */
  music: Known | 'likely';
  /** One line of style when a listener gave one: genre, mood, instruments. */
  style?: string;
  tempo?: 'slow' | 'medium' | 'fast';
  /** Beats a minute: the listener's when given, else the measured grid's when its confidence is at least TEMPO_SURE. */
  bpm?: number;
  vocals?: 'none' | 'sung' | 'spoken-sample' | 'rap';
  sections?: { from: number; to: number; what: string }[];
  ambience: Known;
  ambienceWhat?: string;
  /** One-shot effects a listener named, with their times in seconds. */
  effects: { at: number; what: string; kind: string }[];
  /** Whether the effects are known: yes with some, no when a listener heard none, unknown when nobody listened. */
  sfx: Known;
  /** The share of the picture's cuts that lie on a beat, with what cuts placed without regard to the beat would give. */
  cutsOnBeat?: { share: number; byChance: number; bpm: number };
  /** The default sound plan of the re-make (R2, R5). */
  plan: SoundPlanDefault;
}

/** bed: one music track under the whole video. none: no music. ask: the reading cannot tell; nothing is planned until someone listens or the user says. */
export interface SoundPlanDefault { music: 'bed' | 'none' | 'ask'; sfx: Known; ambience: Known; says: string[] }

export interface SoundFile {
  format: typeof SOUND_FORMAT;
  version: 1;
  /** The hash of the sound as it was read (16 kHz, one channel), so that the same sound is not analysed, or paid for, twice. */
  audioSha256?: string;
  measured?: SoundMeasure;
  analysis: SoundAnalysisRecord;
  facts: SoundFacts;
}

/** A measured tempo counts as the sound's from this confidence on; below it the grid is a guess and is called one. */
export const TEMPO_SURE = 0.3;
/** Music is "likely" from a measurement alone with a sure tempo and at least this many onsets a second. */
export const LIKELY_MUSIC_ONSETS = 1;
/** Cuts follow the beat when their share on it is at least twice what chance gives, and at least a half. */
export const CUTS_FOLLOW = { timesChance: 2, share: 0.5 } as const;

const WHY: Readonly<Record<Exclude<AnalysisStatus, 'done' | 'silent'>, string>> = {
  skipped: 'the sound analysis was skipped (--no-sound-analysis)',
  'no-account': 'no popost.ai account is connected, so nobody listened (popost auth login)',
  unavailable: 'this popost.ai server does not offer the sound analysis',
  'too-long': 'the sound is longer than the sound analysis takes',
  failed: 'the sound analysis failed',
};

const styleOf = (m: SoundAnalysisResult['music']): string => [m.genre, m.mood, m.instruments.slice(0, 4).join(', ')].map((s) => s.trim()).filter(Boolean).join('; ') || m.description.trim();

export const planOf = (f: Omit<SoundFacts, 'plan'>, status: AnalysisStatus): SoundPlanDefault => {
  const music = f.music === 'yes' ? 'bed' : f.music === 'no' ? 'none' : 'ask';
  const says: string[] = [];
  if (music === 'bed') says.push('Music: one bed under the whole video. The user\'s own file first (popost video music own); else one generated track in the reference\'s style (popost video music make), priced and shown to the user with the clips. Every clip is asked for without music.');
  else if (music === 'none') says.push('Music: none, the reference has none. A music track is added only on the user\'s own words (popost video music plan --music generated|own records them).');
  else says.push('Music: not known (' + (status === 'done' ? 'the listener could not tell' : WHY[status as keyof typeof WHY] ?? 'nobody listened') + (f.music === 'likely' ? '; the measurement finds a steady pulse, which is most often music' : '') + '). Ask the user, or run describe with the sound analysis; until then no music is planned.');
  says.push(f.sfx === 'yes' ? 'Effects: the reference has sound effects on its actions (' + f.effects.length + ' named): place effects on the re-make\'s own events (popost video sfx place).'
    : f.sfx === 'no' ? 'Effects: none heard in the reference: none are added unless the user asks.'
      : 'Effects: not known; none are added unless the user asks or the reference is listened to.');
  says.push(f.ambience === 'yes' ? 'Ambience: the reference has the sound of its places' + (f.ambienceWhat ? ' (' + f.ambienceWhat + ')' : '') + ': clips that show a place keep theirs ("sound": "ambience").'
    : f.ambience === 'no' ? 'Ambience: none in the reference: clips under narration are made silent ("sound": "silent") unless their sound is wanted.'
      : 'Ambience: not known.');
  return { music, sfx: f.sfx, ambience: f.ambience, says };
};

/** The facts of a reading. hasAudio false: a silent video, where everything is a plain no. */
export const factsOf = (o: { hasAudio: boolean; measured?: SoundMeasure; analysis: SoundAnalysisRecord }): SoundFacts => {
  const heard = o.analysis.status === 'done' ? o.analysis.result : undefined;
  const t = o.measured?.tempo;
  const sure = t && t.confidence >= TEMPO_SURE ? t : undefined;
  const silent = !o.hasAudio || (o.measured !== undefined && o.measured.silentShare >= 0.98);
  const likely = sure !== undefined && o.measured !== undefined && o.measured.onsets.length / Math.max(1, o.measured.seconds) >= LIKELY_MUSIC_ONSETS;
  const music: SoundFacts['music'] = silent ? 'no' : heard ? (heard.music.present ? 'yes' : 'no') : likely ? 'likely' : 'unknown';
  const bpm = heard?.music.present && heard.music.bpm ? heard.music.bpm : music !== 'no' ? sure?.bpm : undefined;
  const cuts = o.measured?.cuts;
  const facts: Omit<SoundFacts, 'plan'> = {
    music,
    ...(heard?.music.present && styleOf(heard.music) ? { style: styleOf(heard.music) } : {}),
    ...(heard?.music.present && heard.music.tempo ? { tempo: heard.music.tempo } : {}),
    ...(bpm ? { bpm } : {}),
    ...(heard?.music.present ? { vocals: heard.music.vocals } : {}),
    ...(heard?.music.present && heard.music.sections.length ? { sections: heard.music.sections } : {}),
    ambience: silent ? 'no' : heard ? (heard.ambience.present ? 'yes' : 'no') : 'unknown',
    ...(heard?.ambience.present && heard.ambience.description ? { ambienceWhat: heard.ambience.description } : {}),
    effects: heard?.effects ?? [],
    sfx: silent ? 'no' : heard ? (heard.effects.length ? 'yes' : 'no') : 'unknown',
    ...(sure && music !== 'no' && cuts?.onBeat !== undefined && cuts.byChance !== undefined ? { cutsOnBeat: { share: cuts.onBeat, byChance: cuts.byChance, bpm: sure.bpm } } : {}),
  };
  return { ...facts, plan: planOf(facts, silent ? 'silent' : o.analysis.status) };
};

export const soundFileOf = (o: { hasAudio: boolean; audioSha256?: string; measured?: SoundMeasure; analysis: SoundAnalysisRecord }): SoundFile => ({
  format: SOUND_FORMAT, version: 1, ...(o.audioSha256 ? { audioSha256: o.audioSha256 } : {}), ...(o.measured ? { measured: o.measured } : {}), analysis: o.analysis, facts: factsOf(o),
});

export const isSoundFile = (v: unknown): v is SoundFile =>
  typeof v === 'object' && v !== null && (v as SoundFile).format === SOUND_FORMAT && (v as SoundFile).version === 1 && typeof (v as SoundFile).facts === 'object' && (v as SoundFile).facts !== null;

/** Whether the picture's cuts follow the beat (CUTS_FOLLOW). */
export const cutsFollowBeat = (c: SoundFacts['cutsOnBeat']): boolean => c !== undefined && c.share >= CUTS_FOLLOW.share && c.share >= CUTS_FOLLOW.timesChance * c.byChance;

const s1 = (v: number): string => v.toFixed(1);

/** The music in one line: present or not, how it is known, its style and tempo. */
export const musicLine = (f: SoundFacts, status: AnalysisStatus): string => {
  if (f.music === 'no') return 'Music: none' + (status === 'silent' ? ' (the video has no sound)' : status === 'done' ? ' (a listener heard none)' : '');
  if (f.music === 'unknown') return 'Music: not known; ' + (WHY[status as keyof typeof WHY] ?? 'nobody listened');
  const tempo = [f.tempo, f.bpm ? 'about ' + Math.round(f.bpm) + ' beats a minute' : ''].filter(Boolean).join(', ');
  if (f.music === 'likely') return 'Music: likely (measured only: a steady pulse' + (tempo ? ', ' + tempo : '') + '; ' + (WHY[status as keyof typeof WHY] ?? 'nobody listened') + ')';
  return 'Music: yes' + (f.style ? ': ' + f.style : '') + (tempo ? '; ' + tempo : '') + (f.vocals && f.vocals !== 'none' ? '; vocals: ' + f.vocals : f.vocals ? '; no vocals' : '');
};

/** The lines of REFERENCE.md about the sound (without a leading "- "): music, ambience, effects, the beat and the cuts, the default plan. */
export const soundLines = (file: SoundFile): string[] => {
  const f = file.facts, m = file.measured, status = file.analysis.status;
  const out: string[] = [musicLine(f, status)];
  if (f.sections?.length) out.push('Music sections: ' + f.sections.map((s) => s1(s.from) + '-' + s1(s.to) + ' s ' + s.what).join('; '));
  out.push(f.ambience === 'yes' ? 'Ambience: yes' + (f.ambienceWhat ? ': ' + f.ambienceWhat : '') : f.ambience === 'no' ? 'Ambience: none' : 'Ambience: not known');
  out.push(f.sfx === 'yes' ? 'Sound effects: ' + f.effects.slice(0, 12).map((e) => s1(e.at) + ' s ' + (e.kind ? e.kind + ' (' + e.what + ')' : e.what)).join('; ') + (f.effects.length > 12 ? '; +' + (f.effects.length - 12) + ' more in ' + SOUND_FILE : '')
    : f.sfx === 'no' ? 'Sound effects: none heard' : 'Sound effects: not known');
  if (m) {
    const t = m.tempo;
    out.push('Measured: ' + m.onsets.length + ' onsets in ' + s1(m.seconds) + ' s, level ' + s1(m.level.meanDb) + ' dBFS' + (m.loudness !== undefined ? ' (' + s1(m.loudness) + ' LUFS)' : '') + ', ' + Math.round(m.silentShare * 100) + '% silence'
      + (t ? '; beat grid ' + s1(t.bpm) + ' beats a minute from ' + t.first.toFixed(2) + ' s, confidence ' + t.confidence.toFixed(2) + (t.confidence < TEMPO_SURE ? ' (too low: no steady pulse, do not cut to it)' : '') : '; no beat grid'));
    if (f.cutsOnBeat) out.push('Cuts and the beat: ' + Math.round(f.cutsOnBeat.share * 100) + '% of the cuts lie on a beat (' + Math.round(f.cutsOnBeat.byChance * 100) + '% would by chance): ' + (cutsFollowBeat(f.cutsOnBeat) ? 'the edit follows the music; the re-make\'s cuts go on the beats of its own track' : 'the edit does not follow the beat'));
    else if (m.cuts) out.push('Cuts and onsets: ' + Math.round(m.cuts.onOnset * 100) + '% of the cuts have an onset of the sound on them');
  }
  out.push('Default sound plan: ' + f.plan.says.join(' '));
  return out;
};

/** The section of timeline.md: effects and sections with their times, the onsets the strongest first, the beats. */
export const soundSection = (file: SoundFile): string[] => {
  const f = file.facts, m = file.measured;
  const L: string[] = ['## Sound', '', 'What was measured (onsets, beat grid) and, when a listener ran, what was heard. Times are seconds of the reference. All of it, as data, is in ' + SOUND_FILE + '.', ''];
  L.push('- ' + musicLine(f, file.analysis.status));
  for (const s of f.sections ?? []) L.push('- music ' + s1(s.from) + '-' + s1(s.to) + ' ' + s.what);
  for (const e of f.effects) L.push('- effect ' + e.at.toFixed(2) + ' ' + (e.kind || 'effect') + ': ' + e.what);
  if (m?.tempo) L.push('- beat grid: ' + s1(m.tempo.bpm) + ' beats a minute, first beat ' + m.tempo.first.toFixed(2) + ' s, every ' + m.tempo.period.toFixed(3) + ' s, confidence ' + m.tempo.confidence.toFixed(2));
  const strong = [...(m?.onsets ?? [])].sort((a, b) => b.strength - a.strength).slice(0, 24).sort((a, b) => a.t - b.t);
  if (strong.length) L.push('- strongest onsets (seconds): ' + strong.map((o) => o.t.toFixed(2)).join(' '));
  if (m?.silences.length) L.push('- silences: ' + m.silences.slice(0, 12).map(([a, b]) => a.toFixed(2) + '-' + b.toFixed(2)).join(' '));
  return L;
};
