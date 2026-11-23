/**
 * What a voice does to the time. Without a voice the reference's pace predicts it: a warning for a line with more
 * characters than the reference's speaker said in a beat that long. After speaking, the spoken lengths say it: a note
 * for every line spoken more than 25% longer than its beat, and one summary note. A note names the line, its frames and
 * one fix; a weak model reads them, so they stay short.
 */
import type { Problem } from '../types';

/** A line is reported when it is (or would be) spoken more than this many times as long as its beat. */
export const OVERRUN = 1.25;
/** A speed above this sounds hurried: a summary only suggests "speed" up to it. */
const FASTEST = 1.3;

/** Characters a speaker says a second, and the language they were counted in (src/speech paceOf). */
export interface Pace { charactersPerSecond: number; language: string }

const CJK = /[\u{3040}-\u{30ff}\u{3400}-\u{9fff}\u{ac00}-\u{d7af}]/u;
const CJK_LANGUAGES = ['zh', 'ja', 'ko', 'yue'];

/** The characters a pace counts: neither spaces nor punctuation. */
export const spokenChars = (line: string): string[] => Array.from(line).filter((c) => !/[\s\p{P}\p{S}]/u.test(c));

const pct = (v: number): string => Math.round(v * 100) + '%';
export const clip = (line: string): string => (Array.from(line).length > 14 ? Array.from(line).slice(0, 14).join('') + '…' : line);

/**
 * Lines that would take longer to say than their beat at the reference's pace (more than OVERRUN times what its speaker
 * said in that time). slots[i]: frames of beat i. A line in another script than the speech is not judged: a character
 * of Chinese and a letter of English are not said at the same rate.
 */
export const paceWarnings = (lines: string[], slots: number[], fps: number, pace: Pace | undefined): Problem[] => {
  if (!pace || pace.charactersPerSecond <= 0) return [];
  const cjkSpeech = CJK_LANGUAGES.includes(pace.language.toLowerCase().split(/[-_]/)[0] ?? '');
  return lines.flatMap((line, i): Problem[] => {
    const chars = spokenChars(line), frames = slots[i] ?? 0;
    const cjkLine = chars.filter((c) => CJK.test(c)).length * 2 >= chars.length;
    if (!chars.length || !frames || cjkLine !== cjkSpeech) return [];
    const said = Math.max(1, Math.round((pace.charactersPerSecond * frames) / fps));
    if (chars.length <= OVERRUN * said) return [];
    return [{
      level: 'warning', at: 'captions[' + i + ']',
      message: 'Beat ' + i + ' is ' + (frames / fps).toFixed(1) + ' s; the reference said about ' + said + ' characters in it, this line has ' + chars.length + '. Spoken, it makes the video longer here.',
      fix: 'Shorten it to about ' + said + ' characters.',
    }];
  });
};

export interface Overrun {
  /** The lines as written, their beats' frames and the frames each was spoken in (0: not spoken). */
  lines: string[];
  slots: number[];
  spoken: number[];
  /** Frames of the reference and of the new video, and the speed the lines were spoken at. */
  reference: number;
  total: number;
  fps: number;
  speed?: number;
}

/** After speaking: one note per line spoken more than OVERRUN times as long as its beat, and a summary of the length. */
export const overrunNotes = (o: Overrun): string[] => {
  const over = o.lines.flatMap((line, i) => {
    const slot = o.slots[i] ?? 0, spoken = o.spoken[i] ?? 0;
    if (!slot || !spoken || spoken <= OVERRUN * slot) return [];
    const fit = Math.floor((spokenChars(line).length * slot) / spoken);
    return ['captions[' + i + '] "' + clip(line) + '": spoken in ' + spoken + ' frames, its beat has ' + slot + ' (+' + pct(spoken / slot - 1) + '). Fix: ' + (fit >= 1 ? 'a line of about ' + fit + ' characters.' : 'leave it empty ("").')];
  });
  const change = o.total / Math.max(1, o.reference) - 1;
  const voiced = o.spoken.map((f, i) => (f ? [f, o.slots[i] ?? 0] : [0, 0]));
  const spokenSum = voiced.reduce((n, [f]) => n + (f ?? 0), 0), slotSum = voiced.reduce((n, [, s]) => n + (s ?? 0), 0);
  const speed = Math.round((o.speed ?? 1) * (spokenSum / Math.max(1, slotSum)) * 100) / 100;
  const hint = change > 0.1 && speed > (o.speed ?? 1) && speed <= FASTEST ? ' Or set "speed": ' + speed + '.' : '';
  const s = (f: number): string => (f / o.fps).toFixed(1) + ' s';
  return [...over, 'Length: the reference ' + o.reference + ' frames (' + s(o.reference) + '), now ' + o.total + ' (' + s(o.total) + '), ' + (change >= 0 ? '+' : '') + pct(change) + '.' + (over.length ? ' ' + over.length + ' line(s) above run long.' : '') + hint];
};
