import { describe, expect, it } from 'vitest';
import { referenceBeats, uncoveredSpeech } from '../../src/video/describe/beats';
import { MAX_PHRASE_SECONDS, phrasesOf } from '../../src/video/speech/index';
import type { SpokenWord, Transcript } from '../../src/video/speech/types';
import { buildCues } from '../../src/video/text/cues';
import { fold } from '../../src/video/text/fold';
import { rolesWithSpeech, saidShare } from '../../src/video/text/speech';
import type { TextCue, TextRole, TextSample, TextTrack } from '../../src/video/text/types';

/** Hand-written words and lines: nothing here comes from a real video. */
const word = (text: string, start: number, end: number, confidence = 0.9): SpokenWord => ({ text, start, end, confidence });
const speech = (words: SpokenWord[], language = 'zh'): Transcript => ({ language, words, fps: 30 });
/** One CJK character a word, back to back, frames long each, from a frame on. */
const said = (text: string, from: number, frames = 5): SpokenWord[] => Array.from(text).map((ch, k) => word(ch, from + k * frames, from + (k + 1) * frames));
const cue = (text: string, start: number, end: number, role: TextRole, y = 0.86, size = 0.05): TextCue =>
  ({ text, start, end, box: [0.2, y - size / 2, 0.6, size], role, size, samples: Math.max(1, Math.round((end - start) / 6)), confidence: 0.95 });
const track = (cues: TextCue[]): TextTrack => ({ step: 6, sampled: 100, cues });

describe('phrases', () => {
  it('cuts a run of 200 words without a pause into phrases no longer than the limit, every word once', () => {
    // 200 words of 9 frames each, back to back: a minute with no pause and no punctuation.
    const words = Array.from({ length: 200 }, (_x, k) => word('word' + k, k * 9, k * 9 + 9));
    const max = Math.round(MAX_PHRASE_SECONDS * 30);
    const phrases = phrasesOf(speech(words, 'en'));
    expect(phrases.every((p) => p.end - p.start <= max)).toBe(true);
    expect(phrases.flatMap((p) => p.words)).toEqual(words);
    expect(phrases.length).toBeGreaterThanOrEqual(Math.ceil(1800 / max));
    expect(phrasesOf(speech(words, 'en'), { maxFrames: 60 }).every((p) => p.end - p.start <= 60)).toBe(true);
  });

  it('cuts where a pause is, counting one the recogniser hid inside the next word', () => {
    // Twelve characters of 5 frames each, back to back; the seventh lasts 17 frames: a pause hidden at its start.
    const words = said('今天我们来看一个新的工具', 0).map((w, k) => (k < 6 ? w : k === 6 ? { ...w, end: w.start + 17 } : { ...w, start: w.start + 12, end: w.end + 12 }));
    expect(phrasesOf(speech(words)).map((p) => p.text)).toEqual(['今天我们来看', '一个新的工具']);
    // Without the stretch it is one phrase of two seconds.
    expect(phrasesOf(speech(said('今天我们来看一个新的工具', 0))).map((p) => p.text)).toEqual(['今天我们来看一个新的工具']);
  });

  it('splits at a shot boundary between two words, unless a part would last under half a second', () => {
    const words = said('这一句话会跨过两个镜头', 0, 6);
    expect(phrasesOf(speech(words), { boundaries: [30] }).map((p) => [p.text, p.start, p.end])).toEqual([['这一句话会', 0, 30], ['跨过两个镜头', 30, 66]]);
    // A cut 9 frames in is the editor cutting on the phrase: it stays whole.
    expect(phrasesOf(speech(words), { boundaries: [9] }).map((p) => p.text)).toEqual(['这一句话会跨过两个镜头']);
  });

  it('joins CJK without spaces and Latin words with them, and still cuts at the recogniser\'s clause punctuation', () => {
    const words = [...said('先看结论，', 0), word('Hello', 25, 33), word('world', 33, 41)];
    expect(phrasesOf(speech(words)).map((p) => p.text)).toEqual(['先看结论，', 'Hello world']);
  });
});

describe('roles that agree with the speech', () => {
  // A page whose own text changes in a band (as a README scrolls by), real captions that the picture rules took for the
  // page's text, a watermark that also blinks in the caption band, a said title, a paragraph nobody reads out, and a
  // last line shown in silence.
  const words = [...said('今天介绍一个好用的工具', 0), ...said('它可以帮你整理笔记', 90), ...said('也能自动生成摘要', 180)];
  const t = speech(words);
  const before = track([
    cue('今天介绍一个好用的工具', 0, 60, 'in-picture'),
    cue('它可以帮你整理笔记', 90, 140, 'in-picture'),
    cue('也能自动生成摘要', 180, 225, 'caption'),
    cue('Install it with one command', 10, 60, 'caption', 0.56, 0.04),
    cue('and read the guide first', 60, 120, 'caption', 0.56, 0.04),
    cue('Works on every platform', 120, 170, 'caption', 0.56, 0.04),
    { ...cue('mark', 0, 300, 'watermark', 0.05, 0.04) },
    cue('mark', 140, 150, 'caption', 0.84, 0.05),
    cue('今天介绍', 0, 40, 'title', 0.4, 0.2),
    ...Array.from({ length: 4 }, (_x, k) => cue('页面上的一段说明文字第' + (k + 1) + '行', 90, 170, 'in-picture', 0.3 + k * 0.03, 0.02)),
    cue('关注我们', 270, 300, 'caption'),
  ]);
  const after = rolesWithSpeech(before, t);
  const role = (text: string, y?: number): TextRole | undefined => after.cues.find((c) => c.text === text && (y === undefined || Math.abs(c.box[1] + c.box[3] / 2 - y) < 0.01))?.role;

  it('makes a caption of a line that is said in the band, and of nothing that is not', () => {
    expect(role('今天介绍一个好用的工具')).toBe('caption');
    expect(role('它可以帮你整理笔记')).toBe('caption');
    expect(role('也能自动生成摘要')).toBe('caption');
    expect(role('Install it with one command')).toBe('label');
    expect(role('Works on every platform')).toBe('label');
    expect(role('mark', 0.84)).toBe('watermark');
    expect(role('今天介绍')).toBe('title');
    expect(after.cues.filter((c) => c.text.startsWith('页面上的')).every((c) => c.role === 'in-picture')).toBe(true);
    // Nothing is said within a second of the last line: the picture rules keep it, and it sits in the said captions' band.
    expect(role('关注我们')).toBe('caption');
  });

  it('says why each line has its role, with the share of its words heard', () => {
    const why = (text: string): string => after.cues.find((c) => c.text === text)?.why ?? '';
    expect(why('它可以帮你整理笔记')).toBe('said (100% of its words heard), in the caption band at 86%');
    expect(why('Install it with one command')).toBe('not said: 0% of its words heard');
    expect(why('今天介绍')).toContain('said, but not set like the captions');
    expect(why('关注我们')).toBe('shown while nothing is said, in the band of the said captions');
    expect(after.cues.find((c) => c.text === '它可以帮你整理笔记')?.said).toBe(1);
  });

  it('keeps the picture rules without speech, and changes nothing when applied twice', () => {
    expect(rolesWithSpeech(before, undefined)).toBe(before);
    expect(rolesWithSpeech(before, speech([]))).toBe(before);
    expect(JSON.stringify(rolesWithSpeech(after, t))).toBe(JSON.stringify(after));
  });

  it('hears a line written in simplified characters in speech written in traditional ones, and a name heard in pieces', () => {
    expect(fold('這個網頁還在')).toBe('这个网页还在');
    expect(saidShare('这个网页还在', said('這個網頁還在', 0))).toBe(1);
    expect(saidShare('anime.js', [word('An', 0, 5), word('ime', 5, 9), word('J', 9, 12), word('ace', 12, 18)])).toBeGreaterThanOrEqual(0.8);
    expect(saidShare('Install it with one command', said('今天介绍一个好用的工具', 0))).toBe(0);
  });

  it('gives every role a reason under the picture rules too', () => {
    const line = (text: string, y: number, h: number) => ({ text, confidence: 0.95, box: [0.3, y, 0.4, h] as [number, number, number, number] });
    const samples: TextSample[] = Array.from({ length: 40 }, (_x, k) => ({ frame: k * 6, lines: [line(['先看这个', '然后点击右上角', '复制提示词', '最后发送'][Math.floor(k / 10)] ?? '', 0.9, 0.06), line('small print', 0.1, 0.02)] }));
    const cues = buildCues(samples, { step: 6, total: 240, fps: 30 }).cues;
    expect(cues.find((c) => c.text === '复制提示词')?.why).toBe('one of 4 lines that follow one another in the band at 93%');
    expect(cues.find((c) => c.text === 'small print')?.why).toBe('small: 2% of the height');
  });
});

describe('phrases too short to be lines', () => {
  it('join the phrase next to them when no pause or shot lies between, and only when asked', () => {
    // "好，" lasts 0.2 s and runs straight into the next clause; "对。" comes after a pause of a second.
    const words = [word('好，', 0, 6), ...said('这个方法真的有用', 6), word('对。', 76, 82), ...said('再看一个例子吧', 82)];
    expect(phrasesOf(speech(words)).map((p) => p.text)).toEqual(['好，', '这个方法真的有用', '对。', '再看一个例子吧']);
    expect(phrasesOf(speech(words), { minFrames: 30 }).map((p) => p.text)).toEqual(['好，这个方法真的有用', '对。再看一个例子吧']);
    // A shot that begins between them keeps them apart.
    expect(phrasesOf(speech(words), { minFrames: 30, boundaries: [6] }).map((p) => p.text)[0]).toBe('好，');
  });
});

describe('beats', () => {
  const total = 300;
  it('are the caption lines when there is no speech, shown and not said', () => {
    const r = referenceBeats({ text: track([cue('第一句', 0, 60, 'caption'), cue('第二句', 60, 150, 'caption'), cue('第三句', 150, 280, 'caption')]), total });
    expect(r.beats.map((b) => [b.start, b.end, b.text, b.shown, b.said])).toEqual([[0, 60, '第一句', true, false], [60, 150, '第二句', true, false], [150, 280, '第三句', true, false]]);
  });

  it('are the phrases when there are no captions, said and not shown', () => {
    const r = referenceBeats({ transcript: speech([...said('先说结论', 0), ...said('再讲方法', 60)]), total });
    expect(r.beats.map((b) => [b.start, b.end, b.text, b.shown])).toEqual([[0, 20, '先说结论', false], [60, 80, '再讲方法', false]]);
    expect(r.captions).toEqual([]);
  });

  it('fill a gap the captions leave with the speech in it, and leave no speech outside', () => {
    const t = speech([...said('先说结论', 2), ...said('中间这段没有字幕', 70), ...said('最后一句', 160), word('嗯', 216, 219)]);
    const r = referenceBeats({ text: track([cue('先说结论', 0, 60, 'caption'), cue('最后一句', 150, 210, 'caption')]), transcript: t, total });
    expect(r.beats.map((b) => [b.start, b.end, b.text, b.shown, b.said])).toEqual([[0, 60, '先说结论', true, true], [70, 110, '中间这段没有字幕', false, true], [150, 210, '最后一句', true, true]]);
    // The filler just after the last caption is that caption's, not a line of its own.
    expect(uncoveredSpeech(r.beats, t, { tolerance: 3, strays: true })).toEqual({ seconds: 0, words: 0 });
    expect(uncoveredSpeech(r.beats, t).words).toBe(1);
  });

  it('make one beat of the two lines of one caption, read top to bottom', () => {
    const r = referenceBeats({ text: track([cue('第二行', 0, 60, 'caption', 0.9), cue('第一行', 2, 60, 'caption', 0.84), cue('下一句', 60, 120, 'caption')]), total });
    expect(r.beats.map((b) => [b.start, b.end, b.text])).toEqual([[0, 60, '第一行第二行'], [60, 120, '下一句']]);
    expect(r.captions).toHaveLength(3);
  });
});
