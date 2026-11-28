/**
 * The kind of a reference's speech (describe/speech-kind.ts): what a program decides (none, fragments, unknown, with
 * the reason a transcript is missing said as it is), what a reader confirms per range of phrases, how the beats follow
 * the kinds, and that a template keeps them. Hand-written words and measurements only; the commands run through the CLI.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDiskRuntime } from '../../src/testing/disk';
import { runCli } from '../../src/testing/memory';
import { referenceBeats } from '../../src/video/describe/beats';
import { describeReference } from '../../src/video/describe/index';
import { confirmSpeech, keepConfirmed, FRAGMENT_SHARE, FRAGMENT_SYLLABLES, hasNarration, isFragments, kindLine, kindRanges, middleOf, speechOf, withPictures, type SpeechFile } from '../../src/video/describe/speech-kind';
import { unrecoveredOf } from '../../src/video/describe/unrecovered';
import { phrasesOf } from '../../src/video/speech/index';
import type { SpokenWord, Transcript } from '../../src/video/speech/types';
import { loadTemplate } from '../../src/video/template/save';
import type { TextCue, TextTrack } from '../../src/video/text/types';
import type { Measure, ShotMeasure } from '../../src/video/types';

const rt = await createDiskRuntime();
afterAll(async () => { await rt.cleanup(); });
const at = (...parts: string[]): string => path.join(rt.dir, ...parts);
const put = async (file: string, value: unknown): Promise<void> => { await mkdir(path.dirname(at(file)), { recursive: true }); await writeFile(at(file), JSON.stringify(value)); };

const word = (text: string, start: number, end: number): SpokenWord => ({ text, start, end, confidence: 0.9 });
/** Words of 6 frames each, back to back, from a frame on. */
const said = (text: string, from: number): SpokenWord[] => text.split(' ').map((w, k) => word(w, from + k * 6, from + (k + 1) * 6));
const speech = (words: SpokenWord[]): Transcript => ({ language: 'en', words, fps: 30 });
const shot = (index: number, start: number, end: number): ShotMeasure =>
  ({ index, start, end, camera: { kind: 'static', zoomPerS: 0, panPerS: [0, 0], confidence: 0.8 }, background: '#101820', palette: [{ hex: '#101820', share: 0.7 }], events: [] });
/** Thirty seconds in two shots, with sound. */
const measure: Measure = {
  version: 1, source: { width: 720, height: 1280, fps: 30, frames: 900, duration: 30, hasAudio: true },
  boundaries: [{ frame: 450, kind: 'cut', start: 449, end: 450, confidence: 0.9 }], shots: [shot(0, 0, 450), shot(1, 450, 900)],
  rhythm: { step: 3, change: [] }, signature: { every: 3, width: 16, height: 16, count: 0, data: '' },
};
/** A narrated half and a half a person says on camera: two phrases each. */
const talk = speech([...said('this little grinder changed my mornings', 30), ...said('it takes ten seconds to set up', 150), ...said('I use it every single day now', 480), ...said('and my friends keep asking about it', 620)]);
const record = (t: Transcript | undefined, status: SpeechFile['status'] = 'transcribed', why?: string): SpeechFile =>
  speechOf({ status, ...(why ? { why } : {}), ...(t ? { transcript: t, phrases: phrasesOf(t, { boundaries: [450] }) } : {}), fps: 30, duration: 30 });

describe('what a program decides', () => {
  it('calls a few exclamations fragments, by the share of the length that is spoken and the length of the phrases', () => {
    expect([FRAGMENT_SHARE, FRAGMENT_SYLLABLES]).toEqual([0.15, 4]);
    // Three exclamations, 1.4 s of 30 s: fragments, decided, nothing to confirm.
    const shouts = speech([word('wow', 60, 72), word('oh', 300, 310), ...said('let\'s go', 700)]);
    const r = record(shouts);
    expect(r).toMatchObject({ status: 'transcribed', confirmed: true, kinds: ['fragments'] });
    expect(r.phrases.every((p) => p.kind === 'fragments')).toBe(true);
    expect(kindLine(r)).toContain('Speech kind: fragments');
    expect(kindLine(r)).toContain('no voice');
    expect(hasNarration(r)).toBe(false);
    // One sentence in a video of music is short of the share but too long a phrase: not decided here.
    const hook = record(speech(said('this changed my skin in a single week', 60)));
    expect(hook).toMatchObject({ confirmed: false, kinds: [] });
    // Short phrases that fill the video are a dialogue, not fragments.
    const phrases = phrasesOf(speech([word('yes', 0, 10)]));
    expect(isFragments(phrases, 1, 30)).toBe(true);
    expect(isFragments(phrases, 6, 30)).toBe(false);
  });

  it('says none, and unknown with the reason as it is: skipped, failed and no transcriber are three things', () => {
    expect(record(speech([]))).toMatchObject({ confirmed: true, kinds: ['none'] });
    expect(kindLine(record(speech([])))).toBe('- Speech: none recognised: no voice-over');
    expect(kindLine(record(undefined, 'silent'))).toContain('the video has no sound');
    const skipped = record(undefined, 'skipped'), failed = record(undefined, 'failed', 'The transcription failed; run the same command again.'), none = record(undefined, 'no-tool');
    for (const r of [skipped, failed, none]) expect(r).toMatchObject({ confirmed: true, kinds: ['unknown'], phrases: [] });
    expect(kindLine(skipped)).toContain('the transcription was skipped (--no-speech)');
    expect(kindLine(failed)).toContain('the transcription failed (The transcription failed; run the same command again.)');
    expect(kindLine(failed)).toContain('Run describe again');
    expect(kindLine(failed)).not.toContain('no transcriber');
    expect(kindLine(none)).toContain('no transcriber was available');
    for (const r of [skipped, failed, none]) expect(kindLine(r)).toContain('Speech kind: unknown, treated as no narration');
    // The list of what was not recovered says the same.
    const why = (r: SpeechFile): string => unrecoveredOf(measure, { speech: r }).find((u) => u.what === 'what is said')?.why ?? '';
    expect([why(skipped), why(failed), why(none)]).toEqual(['the transcription was skipped (--no-speech)', 'the transcription failed (The transcription failed; run the same command again.)', 'no transcriber was available']);
    // REFERENCE.md carries the line.
    expect(describeReference(measure, undefined, 'reference', undefined, undefined, { speech: failed }).files['REFERENCE.md']).toContain('- Speech was not transcribed: the transcription failed');
  });
});

describe('what a reader confirms', () => {
  const open = withPictures(record(talk));

  it('leaves heard words unconfirmed, each phrase with the picture of the frame at its middle', () => {
    expect(open).toMatchObject({ confirmed: false, kinds: [] });
    expect(open.phrases.map((p) => p.text)).toEqual(['this little grinder changed my mornings', 'it takes ten seconds to set up', 'I use it every single day now', 'and my friends keep asking about it']);
    expect(open.phrases[0]?.picture).toEqual({ file: 'speech/phrases-01.jpg', seconds: Number((middleOf(open.phrases[0] ?? { start: 0, end: 0 }) / 30).toFixed(2)) });
    expect(kindLine(open)).toContain('Speech kind: unconfirmed');
    expect(kindRanges(open)).toBeUndefined();
  });

  it('records a kind per range of phrases, so that a video can be part narration, part on camera', () => {
    const r = confirmSpeech(open, { narration: ['0-1'], 'on-camera': ['2', '3'] });
    expect(r.problems).toEqual([]);
    expect(r.file).toMatchObject({ confirmed: true, kinds: ['narration', 'on-camera'] });
    expect(r.file?.phrases.map((p) => p.kind)).toEqual(['narration', 'narration', 'on-camera', 'on-camera']);
    expect(kindLine(r.file as SpeechFile)).toContain('narration (phrases 0-1): re-made as a voice-over; on-camera (phrases 2-3)');
    expect(hasNarration(r.file as SpeechFile)).toBe(true);
    expect(hasNarration(confirmSpeech(open, { sung: ['0-3'] }).file as SpeechFile)).toBe(false);
    // The same video described again keeps what was confirmed; other phrases are asked about anew.
    expect(keepConfirmed(record(talk), r.file)).toMatchObject({ confirmed: true, kinds: ['narration', 'on-camera'] });
    expect(keepConfirmed(record(speech(said('one whole other sentence was said here instead', 60))), r.file).confirmed).toBe(false);
  });

  it('refuses a phrase left open, a phrase named twice and a range outside the phrases, each with what to do', () => {
    const left = confirmSpeech(open, { narration: ['0-1'] });
    expect(left.file).toBeUndefined();
    expect(left.problems[0]?.message).toContain('2 phrase(s) have no kind yet: 2-3');
    expect(left.problems[0]?.fix).toContain('--narration, --on-camera, --sung or --fragments');
    expect(confirmSpeech(open, { narration: ['0-3'], sung: ['1'] }).problems[0]?.message).toBe('Phrase 1 is named as narration and as sung.');
    expect(confirmSpeech(open, { narration: ['0-9'] }).problems[0]?.message).toContain('numbered 0 to 3');
  });
});

describe('the beats follow the kinds', () => {
  const kinds = kindRanges(confirmSpeech(record(talk), { narration: ['0-1'], 'on-camera': ['2-3'] }).file);
  const total = 900, boundaries = [450];

  it('marks the beats a visible person says, and reads them as before without kinds', () => {
    const plain = referenceBeats({ transcript: talk, total, boundaries });
    expect(plain.beats).toHaveLength(4);
    expect(plain.beats.some((b) => b.speech)).toBe(false);
    const read = referenceBeats({ transcript: talk, total, boundaries, ...(kinds ? { kinds } : {}) });
    expect(read.beats.map((b) => b.speech)).toEqual([undefined, undefined, 'on-camera', 'on-camera']);
    const lines = describeReference(measure, undefined, 'reference', talk, undefined, { speech: confirmSpeech(record(talk), { narration: ['0-1'], 'on-camera': ['2-3'] }).file as SpeechFile }).files;
    expect(lines['timeline.md']).toContain('spoken only on camera "I use it every single day now"');
    expect(lines['REFERENCE.md']).toContain('- Dialogue beats (a visible person says them; timeline.md marks them "on camera"): 2, 3');
  });

  it('makes no beat of sung words or fragments, and keeps a caption shown over them as a shown beat', () => {
    const sung = kindRanges(confirmSpeech(record(talk), { narration: ['0-1'], sung: ['2'], fragments: ['3'] }).file);
    expect(referenceBeats({ transcript: talk, total, boundaries, ...(sung ? { kinds: sung } : {}) }).beats.map((b) => b.text)).toEqual(['this little grinder changed my mornings', 'it takes ten seconds to set up']);
    const lyric: TextCue = { text: 'I use it every single day now', start: 478, end: 525, box: [0.2, 0.83, 0.6, 0.05], role: 'caption', size: 0.05, samples: 8, confidence: 0.95 };
    const text: TextTrack = { step: 6, sampled: 100, cues: [lyric] };
    const shown = referenceBeats({ text, transcript: talk, total, boundaries, ...(sung ? { kinds: sung } : {}) }).beats;
    expect(shown.map((b) => [b.shown, b.text])).toEqual([[false, 'this little grinder changed my mornings'], [false, 'it takes ten seconds to set up'], [true, 'I use it every single day now']]);
  });
});

describe('the commands', () => {
  const describeDir = async (name: string, speechFile: SpeechFile): Promise<string> => {
    await put(name + '/measure.json', measure);
    await put(name + '/transcript.json', talk);
    await put(name + '/speech.json', speechFile);
    await writeFile(at(name, 'REFERENCE.md'), '# Reference: grinder\n');
    return name;
  };

  it('show lists the phrases and the question; confirm stores the kinds, writes the beats again, and template save keeps them', async () => {
    const ref = await describeDir('ref', withPictures(record(talk)));
    expect((await runCli(rt, ['video', 'speech-kind', 'show', ref])).code).toBe(0);
    const shown = rt.json() as { kinds: string; phrases: { phrase: number; picture: string; frameAt: number }[]; question: string; next: string };
    expect(shown.kinds).toBe('unconfirmed');
    expect(shown.phrases).toHaveLength(4);
    expect(shown.phrases[0]?.picture).toBe(at('ref', 'speech/phrases-01.jpg'));
    expect(shown.question).toContain('is a person visible who is saying these words');
    // A template is not saved from an unconfirmed reading.
    expect((await runCli(rt, ['video', 'template', 'save', ref, '--out', 'tpl', '--name', 'grinder'])).code).toBe(2);
    expect((rt.json() as { problems: { fix: string }[] }).problems[0]?.fix).toContain('popost video speech-kind confirm ref');
    // A confirmation that leaves phrases open changes nothing.
    expect((await runCli(rt, ['video', 'speech-kind', 'confirm', ref, '--narration', '0-1'])).code).toBe(2);
    expect((JSON.parse(await readFile(at('ref', 'speech.json'), 'utf8')) as SpeechFile).confirmed).toBe(false);
    expect((await runCli(rt, ['video', 'speech-kind', 'confirm', ref, '--narration', '0-1', '--on-camera', '2', '3'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, confirmed: true, kinds: ['narration', 'on-camera'], phrases: { narration: 2, 'on-camera': 2 } });
    const stored = JSON.parse(await readFile(at('ref', 'speech.json'), 'utf8')) as SpeechFile;
    expect(stored.phrases.map((p) => p.kind)).toEqual(['narration', 'narration', 'on-camera', 'on-camera']);
    expect(await readFile(at('ref', 'timeline.md'), 'utf8')).toContain('on camera "and my friends keep asking about it"');
    expect(await readFile(at('ref', 'REFERENCE.md'), 'utf8')).toContain('# Reference: grinder');
    expect((await runCli(rt, ['video', 'template', 'save', ref, '--out', 'tpl', '--name', 'grinder'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, beats: 4, speech: { status: 'transcribed', kinds: ['narration', 'on-camera'], voiceOver: true, onCameraBeats: [2, 3] } });
    const pkg = await loadTemplate(rt, at('tpl'));
    expect(pkg.template.speech).toEqual({ status: 'transcribed', kinds: ['narration', 'on-camera'] });
    expect(pkg.template.captions?.beats.map((b) => b.speech)).toEqual([undefined, undefined, 'on-camera', 'on-camera']);
    expect(pkg.slots.captions?.lines.map((l) => l.speech)).toEqual([undefined, undefined, 'on-camera', 'on-camera']);
    expect(await readFile(at('tpl', 'TEMPLATE.md'), 'utf8')).toContain('Beats 2-3 are said on camera');
  });

  it('--all names every phrase at once, and a reference without phrases has nothing to confirm', async () => {
    const ref = await describeDir('ref-all', withPictures(record(talk)));
    expect((await runCli(rt, ['video', 'speech-kind', 'confirm', ref, '--all', 'sung'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ kinds: ['sung'] });
    const none = await describeDir('ref-none', record(undefined, 'skipped'));
    expect((await runCli(rt, ['video', 'speech-kind', 'confirm', none])).code).toBe(0);
    expect((rt.json() as { note: string }).note).toContain('the transcription was skipped');
  });
});
