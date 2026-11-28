/**
 * Lines a person says in a generated clip, with their times. The integrated video models speak lines written into
 * the prompt, with matching mouths, and keep to times given as "0.0-2.3 s ... says": so a request names the lines, who
 * says each, and their language, and this program writes the times and the dialogue block of the prompt. The times
 * come from the template: a line names the beat it re-makes ("beat"), the clip starts where a shot of the template
 * starts ("shot", from 1; default: the shot in which the first named beat begins), and a line's slot is its beat's
 * time counted from that shot's start. A fill then shows the clip from "in": 0 in that shot, and the person speaks
 * where the reference's did. Seconds written by hand ("at", "to") are for a project without a template's beats only.
 * Everything here is checked before a clip is paid for. Pure.
 */
import { OVERRUN, spokenChars, type Pace } from '../retarget/pace';
import { error } from '../project/check-common';
import type { Problem } from '../types';

/** One line of a request: who says what, in which beat of the template (or, without beats, from when to when in the clip). */
export interface SpeechLine { speaker: string; text: string; beat?: number; at?: number; to?: number }
/** Native speech with timed lines: the model speaks them, lips and voice made together. */
export interface DialogueSpeech { mode: 'native'; language: string; lines: SpeechLine[]; shot?: number }
/** A line with its slot in the clip, in seconds from the clip's first frame. */
export interface TimedLine { speaker: string; text: string; at: number; to: number; beat?: number }
export interface TimedDialogue { mode: 'native'; language: string; lines: TimedLine[] }

/** What the times are read from: the template's shots and beats on its clock, and how fast its speaker spoke. */
export interface BeatTimes {
  fps: number;
  /** The frame each shot starts at. */
  shots: readonly number[];
  beats: readonly { start: number; end: number; speech?: 'on-camera' }[];
  /** true: the template says which beats are said on camera (a template saved with the kinds of its speech). */
  kinds: boolean;
  pace?: Pace;
}

export const isDialogue = (v: unknown): v is DialogueSpeech =>
  typeof v === 'object' && v !== null && (v as DialogueSpeech).mode === 'native' && Array.isArray((v as DialogueSpeech).lines);

const NAMES: Readonly<Record<string, string>> = {
  en: 'English', 'en-us': 'American English', 'en-gb': 'British English', 'en-au': 'Australian English', 'en-in': 'Indian English',
  zh: 'Mandarin Chinese', 'zh-cn': 'Mandarin Chinese', 'zh-hans': 'Mandarin Chinese', 'zh-tw': 'Mandarin Chinese as spoken in Taiwan', 'zh-hk': 'Cantonese', yue: 'Cantonese',
  ja: 'Japanese', ko: 'Korean', es: 'Spanish', 'es-mx': 'Mexican Spanish', pt: 'Portuguese', 'pt-br': 'Brazilian Portuguese', fr: 'French', de: 'German', it: 'Italian',
  ru: 'Russian', ar: 'Arabic', hi: 'Hindi', id: 'Indonesian', ms: 'Malay', th: 'Thai', vi: 'Vietnamese', tr: 'Turkish', nl: 'Dutch', pl: 'Polish', fil: 'Filipino',
};
const TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
/** Languages written in Han characters, kana or hangul. */
const WIDE_LANGUAGES = ['zh', 'yue', 'ja', 'ko'];
const WIDE = /[\u{3040}-\u{30ff}\u{3400}-\u{9fff}\u{ac00}-\u{d7af}]/u;

/** A language tag in plain words ("en-US": "American English"); a tag the list does not know is said as it is. */
export const languageName = (tag: string): string => {
  const t = tag.trim().toLowerCase();
  return NAMES[t] ?? NAMES[t.split('-')[0] ?? ''] ?? tag.trim();
};

const wideLanguage = (tag: string): boolean => WIDE_LANGUAGES.includes(tag.trim().toLowerCase().split('-')[0] ?? '');
/** Whether most of a line's characters are Han, kana or hangul. */
const wideText = (text: string): boolean => {
  const chars = spokenChars(text);
  return chars.filter((c) => WIDE.test(c)).length * 2 >= chars.length;
};

/**
 * The fastest a line may have to be said: OVERRUN times the reference speaker's pace when it was measured in the
 * line's script, else OVERRUN times an ordinary pace (characters a second, counted as spokenChars counts them).
 */
export const ORDINARY_PACE = { wide: 5, latin: 15 } as const;
export const fastestPace = (text: string, pace?: Pace): number => {
  const wide = wideText(text);
  const measured = pace && pace.charactersPerSecond > 0 && wideLanguage(pace.language) === wide ? pace.charactersPerSecond : undefined;
  return OVERRUN * (measured ?? (wide ? ORDINARY_PACE.wide : ORDINARY_PACE.latin));
};

const r2 = (v: number): number => Math.round(v * 100) / 100;
const quote = (t: string): string => '"' + t.replace(/"/g, "'") + '"';

/** The shot (from 0) in which a frame lies. */
const shotAt = (shots: readonly number[], frame: number): number => Math.max(0, shots.reduce((k, start, i) => (start <= frame ? i : k), 0));

/** The first shot of the clip (from 0): the one the request names, else the one its first named beat begins in. */
const firstShot = (s: DialogueSpeech, times: BeatTimes): number | undefined => {
  if (s.shot !== undefined) return Number.isInteger(s.shot) && s.shot >= 1 && s.shot <= times.shots.length ? s.shot - 1 : undefined;
  const beats = s.lines.flatMap((l) => (Number.isInteger(l.beat) && times.beats[l.beat as number] ? [times.beats[l.beat as number]?.start ?? 0] : []));
  return beats.length ? shotAt(times.shots, Math.min(...beats)) : 0;
};

/** The lines with their slots in the clip; a line whose time cannot be told keeps none (the problems say why). */
export const timedLines = (s: DialogueSpeech, times: BeatTimes | undefined): (TimedLine | undefined)[] => {
  const shot = times ? firstShot(s, times) : undefined;
  const zero = times && shot !== undefined ? (times.shots[shot] ?? 0) : 0;
  return s.lines.map((l): TimedLine | undefined => {
    const said = { speaker: l.speaker, text: l.text };
    if (l.beat !== undefined) {
      const b = times && shot !== undefined && Number.isInteger(l.beat) ? times.beats[l.beat] : undefined;
      return b && times ? { ...said, at: r2((b.start - zero) / times.fps), to: r2((b.end - zero) / times.fps), beat: l.beat } : undefined;
    }
    return typeof l.at === 'number' && typeof l.to === 'number' ? { ...said, at: r2(l.at), to: r2(l.to) } : undefined;
  });
};

/** The dialogue of a request with every line timed, or undefined when a line has no time (dialogueProblems says which). */
export const timedDialogue = (s: DialogueSpeech, times: BeatTimes | undefined): TimedDialogue | undefined => {
  const lines = timedLines(s, times);
  return lines.every((l): l is TimedLine => l !== undefined) ? { mode: 'native', language: s.language, lines } : undefined;
};

const EXAMPLE = '{"mode": "native", "language": "en-US", "lines": [{"speaker": "host", "text": "The exact words", "beat": 3}]}';

/**
 * What is wrong with the dialogue of one request, each with its fix: the language, the lines' shape, who speaks, the
 * times (a beat of the template, never seconds by hand when the template has beats), that each line can be said in
 * its slot, and that the lines follow one another inside the clip.
 */
export const dialogueProblems = (s: DialogueSpeech, o: { at: string; cast: readonly string[]; seconds?: number; times?: BeatTimes }): Problem[] => {
  const at = o.at + '.speech';
  const out: Problem[] = [];
  if (typeof s.language !== 'string' || !TAG.test(s.language.trim()))
    out.push(error(at + '.language', 'Lines a person says need their language, so that the model speaks it and not another: a tag such as en-US, zh-CN or ja.', 'Write "language": "<the language of the lines>", for example ' + EXAMPLE + '.'));
  if (!s.lines.length) return [...out, error(at + '.lines', '"lines" is empty: a clip with speech says at least one line.', 'Write the lines, for example ' + EXAMPLE + ', or remove "speech" for a clip nobody speaks in.')];
  const times = o.times;
  const hasBeats = (times?.beats.length ?? 0) > 0;
  if (s.shot !== undefined && !(times && Number.isInteger(s.shot) && s.shot >= 1 && s.shot <= times.shots.length))
    out.push(error(at + '.shot', '"shot" is the shot of the template the clip starts at, from 1' + (times ? ' to ' + times.shots.length : ' (it needs the template: --template <dir>)') + '; it is ' + JSON.stringify(s.shot) + '.', 'Write the number of the shot this clip fills first, or remove "shot": the clip then starts with the shot its first line\'s beat begins in.'));
  s.lines.forEach((l, i) => {
    const where = at + '.lines[' + i + ']';
    if (!l || typeof l !== 'object' || typeof l.text !== 'string' || !l.text.trim() || typeof l.speaker !== 'string' || !l.speaker.trim()) {
      out.push(error(where, 'A line says who speaks and the exact words.', 'Write {"speaker": "<a role of this clip\'s cast>", "text": "The exact words", "beat": <the beat it re-makes>}.'));
      return;
    }
    if (!o.cast.includes(l.speaker)) out.push(error(where + '.speaker', 'The speaker ' + quote(l.speaker) + ' is not in this clip\'s "cast" (' + (o.cast.join(', ') || 'empty') + ').', 'Name a role of the cast, or add the role to "cast" (cast.json has the roles).'));
    if (typeof s.language === 'string' && TAG.test(s.language.trim()) && spokenChars(l.text).length && wideLanguage(s.language) !== wideText(l.text))
      out.push(error(where + '.text', 'The line ' + quote(l.text) + ' is not written in the script of its language (' + languageName(s.language) + ').', 'Write the line in ' + languageName(s.language) + ', or correct "language" to the language the line is in.'));
    const timed = l.at !== undefined || l.to !== undefined;
    if (l.beat !== undefined && timed) out.push(error(where, 'A line names its beat or, without a template\'s beats, its seconds: not both.', 'Remove "at" and "to": the program takes the times from the beat.'));
    else if (l.beat !== undefined) {
      if (!times) out.push(error(where + '.beat', 'The time of beat ' + JSON.stringify(l.beat) + ' is the template\'s, and no template was given.', 'Run the command with --template <the template directory>.'));
      else if (!Number.isInteger(l.beat) || !times.beats[l.beat]) out.push(error(where + '.beat', 'The template has no beat ' + JSON.stringify(l.beat) + ' (its beats are 0 to ' + (times.beats.length - 1) + ').', 'Write the number of the beat this line re-makes, as timeline.md and TEMPLATE.md number them.'));
      else if (times.kinds && times.beats[l.beat]?.speech !== 'on-camera') out.push(error(where + '.beat', 'Beat ' + l.beat + ' is not said on camera in the reference: no person of a clip says it.', 'Name only beats TEMPLATE.md marks "on camera"; narration is the voice-over\'s (the fill\'s "voice").'));
    } else if (hasBeats) out.push(error(where, 'A line of a video made from a template names the beat it re-makes; its time is the program\'s, not written by hand.', 'Write "beat": <the number of its beat> and remove "at" and "to".'));
    else if (!(typeof l.at === 'number' && typeof l.to === 'number' && l.at >= 0 && l.to > l.at)) out.push(error(where, 'Without a template\'s beats a line says when it is spoken in the clip: "at" and "to" in seconds, "to" after "at".', 'Write "at": 0.5, "to": 2.8.'));
  });
  if (out.length) return out;
  const lines = timedLines(s, times);
  if (o.seconds === undefined) out.push(error(o.at + '.seconds', 'A clip with timed lines says how long it is.', 'Write "seconds": the length of the clip, at least to the end of its last line.'));
  lines.forEach((l, i) => {
    if (!l) return;
    const where = at + '.lines[' + i + ']', prev = lines[i - 1];
    if (l.at < 0) { out.push(error(where, 'Line ' + i + (l.beat !== undefined ? ' (beat ' + l.beat + ')' : '') + ' begins ' + (-l.at).toFixed(2) + ' s before the clip does.', 'Start the clip at an earlier shot ("shot": the number of the shot the beat begins in), or give the line to the clip of that shot.')); return; }
    if (prev && l.at < prev.to - 0.01) out.push(error(where, 'Line ' + i + ' begins at ' + l.at.toFixed(2) + ' s, before line ' + (i - 1) + ' ends (' + prev.to.toFixed(2) + ' s): the lines of a clip follow one another.', 'Write the lines in the order they are said, each in a beat of its own.'));
    if (o.seconds !== undefined && l.to > o.seconds + 0.01) out.push(error(where, 'Line ' + i + ' ends at ' + l.to.toFixed(2) + ' s; the clip is ' + o.seconds + ' s long.', 'Ask for a clip of at least ' + Math.ceil(l.to) + ' s, or give the line to the clip of the next shot.'));
    const chars = spokenChars(l.text).length, slot = l.to - l.at, most = Math.floor(fastestPace(l.text, times?.pace) * slot);
    if (slot > 0 && chars > most) out.push(error(where + '.text', 'Line ' + i + ' has ' + chars + ' characters for a slot of ' + slot.toFixed(2) + ' s: nobody says that in the time (about ' + most + ' at most).', 'Shorten it to about ' + most + ' characters, or move words to the line of a neighbouring beat.'));
  });
  return out;
};

/** The beats the lines of a list of requests name, each with the files that name it. */
export const beatsCovered = (requests: readonly { file?: string; speech?: unknown }[]): Map<number, string[]> => {
  const out = new Map<number, string[]>();
  for (const r of requests) {
    if (!isDialogue(r.speech)) continue;
    for (const l of r.speech.lines) if (l && Number.isInteger(l.beat)) out.set(l.beat as number, [...(out.get(l.beat as number) ?? []), String(r.file)]);
  }
  return out;
};

/**
 * Every beat the reference said on camera is said by exactly one clip: a beat two clips say, and a beat no clip of
 * the list (or of the project already: covered) says. A person who speaks on camera in the reference speaks on camera
 * in the re-make; leaving the line to a voice-over is not a way to make it.
 */
export const coverageProblems = (requests: readonly { file?: string; speech?: unknown }[], times: BeatTimes, covered: ReadonlySet<number> = new Set()): Problem[] => {
  const named = beatsCovered(requests);
  const twice = [...named.entries()].filter(([beat, files]) => files.length > 1 || covered.has(beat));
  const open = times.beats.flatMap((b, i) => (b.speech === 'on-camera' && !named.has(i) && !covered.has(i) ? [i] : []));
  return [
    ...twice.map(([beat, files]) => error('speech.lines', 'Beat ' + beat + ' is said by more than one clip (' + [...new Set(files)].join(', ') + (covered.has(beat) ? ', and a clip already in the project' : '') + ').', 'Give every beat to one clip.')),
    ...(open.length ? [error('speech.lines', 'No clip says the on-camera beat' + (open.length === 1 ? ' ' : 's ') + open.join(', ') + ': in the reference a visible person says ' + (open.length === 1 ? 'it' : 'them') + ', so the person of the re-make does too.',
      'Give each of these beats to the clip of its shot: "speech": {"mode": "native", "language": "...", "lines": [{"speaker": "...", "text": "...", "beat": ' + open[0] + '}]} (video-performers.md). Never replace a speaking person with silent footage and a voice-over; when the clips cost more than is left of the budget, stop and tell the user the price.')] : []),
  ];
};

/** The sentence that keeps music out of a clip of a video whose music is one separate track. */
export const NO_MUSIC = ' No background music and no score in this clip: only the ambient sound of the scene, its sound effects and any dialogue. The music of the video is a separate track.';

const stamp = (seconds: number): string => seconds.toFixed(1);

/** The dialogue block of a prompt: the language in plain words, native lip-synced speech, each line with its time, and what must not be heard or seen. English whatever the lines' language; the lines are verbatim. */
export const dialoguePrompt = (d: TimedDialogue): string => {
  const speakers = [...new Set(d.lines.map((l) => l.speaker))];
  const lines = d.lines.map((l) => stamp(l.at) + '-' + stamp(l.to) + ' s ' + l.speaker + ' says ' + JSON.stringify(l.text)).join('; ');
  return ' Dialogue: native speech in ' + languageName(d.language) + ', recorded with the picture and lip-synced, the mouth of ' + (speakers.length === 1 ? speakers[0] : 'each speaker') + ' moving exactly with ' + (speakers.length === 1 ? 'the' : 'their own') + ' words. Timeline of the lines, in seconds from the start of the clip: ' + lines
    + '. Nobody speaks outside these times, and mouths rest closed between the lines. No other dialogue, no narrator, no captions or on-screen text, no dubbing and no translated speech. The generated speech is the final audio and is not replaced afterwards.';
};
