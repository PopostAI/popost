/**
 * Lines a person says in a generated clip (generate/dialogue.ts): the times come from the template's beats, the
 * program writes the dialogue block of the prompt, and everything is checked before a clip is paid for. The generator
 * is a stand-in that keeps the prompts it was sent; with ffmpeg it writes a real clip with sound, so that the speech
 * receipt is written as for a generated clip.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDiskRuntime } from '../../src/testing/disk';
import { coverageProblems, dialogueProblems, dialoguePrompt, fastestPace, languageName, NO_MUSIC, timedDialogue, type BeatTimes, type DialogueSpeech } from '../../src/video/generate/dialogue';
import { beatsSaid, checkRequests, makeMaterials, type Generator, type GenerateRequest, type MaterialRequest } from '../../src/video/generate/index';
import { isVisibleSpeech, speechPrompt } from '../../src/video/generate/speech';
import { speechSpans } from '../../src/video/media/footage';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { registerVoice } from '../../src/video/voice/profile';

const rt = await createDiskRuntime();
afterAll(async () => { await rt.cleanup(); });
const ffmpeg = await hasFfmpeg(rt);

/** Three shots from 0, 4 and 9 s at 30 fps; beats 0 and 1 are narration, beats 2 to 4 are said on camera in shots 2 and 3. */
const times: BeatTimes = {
  fps: 30, shots: [0, 120, 270], kinds: true,
  beats: [{ start: 10, end: 60 }, { start: 70, end: 110 }, { start: 135, end: 204, speech: 'on-camera' }, { start: 210, end: 264, speech: 'on-camera' }, { start: 285, end: 360, speech: 'on-camera' }],
};
const speech: DialogueSpeech = { mode: 'native', language: 'en-US', lines: [{ speaker: 'host', text: 'I use it every single day.', beat: 2 }, { speaker: 'guest', text: 'And I keep asking about it.', beat: 3 }] };
const request = (o: Partial<MaterialRequest> = {}): MaterialRequest => ({ file: 'assets/talk.mp4', prompt: 'Two friends at a kitchen table, medium shot.', seconds: 5, cast: ['host', 'guest'], speech, ...o });
const project = async (name: string): Promise<string> => {
  const dir = path.join(rt.dir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'cast.json'), JSON.stringify({ version: 1, roles: [{ id: 'host', description: 'A fictional woman with short dark hair' }, { id: 'guest', description: 'A fictional man in a green jumper' }, { id: 'coach', description: 'A fictional older woman in a tracksuit' }] }));
  return dir;
};
/** Keeps what it was sent; with ffmpeg it writes a clip of the asked length with a tone. */
const keeping = (): Generator & { asked: GenerateRequest[] } => {
  const asked: GenerateRequest[] = [];
  return {
    asked,
    make: async (kind, r, out) => {
      asked.push(r);
      if (kind === 'video' && ffmpeg) await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=64x36:r=30:d=' + (r.seconds ?? 2), '-f', 'lavfi', '-i', 'sine=frequency=300:duration=' + (r.seconds ?? 2), '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out]);
      else await writeFile(out, 'x');
      return { credits: 10 };
    },
  };
};

describe('the times of the lines', () => {
  it('come from the beats named, counted from the start of the shot the first one begins in', () => {
    // Beat 2 begins in shot 2 (from frame 120): 135-204 is 0.5 to 2.8 s of the clip, beat 3 is 3.0 to 4.8 s.
    expect(timedDialogue(speech, times)).toEqual({ mode: 'native', language: 'en-US', lines: [
      { speaker: 'host', text: 'I use it every single day.', at: 0.5, to: 2.8, beat: 2 },
      { speaker: 'guest', text: 'And I keep asking about it.', at: 3, to: 4.8, beat: 3 },
    ] });
    // A clip that starts at an earlier shot says so; its lines move with it.
    expect(timedDialogue({ ...speech, shot: 1 }, times)?.lines.map((l) => [l.at, l.to])).toEqual([[4.5, 6.8], [7, 8.8]]);
    // Without a template a beat has no time; seconds written by hand are for a project without beats.
    expect(timedDialogue(speech, undefined)).toBeUndefined();
    expect(timedDialogue({ mode: 'native', language: 'ja', lines: [{ speaker: 'host', text: 'こんにちは', at: 0.4, to: 1.6 }] }, undefined)?.lines[0]).toEqual({ speaker: 'host', text: 'こんにちは', at: 0.4, to: 1.6 });
  });
});

describe('the dialogue block of a prompt', () => {
  it('names the language in plain words, native lip-synced speech, each line with its time, and what must not be heard', () => {
    const one = dialoguePrompt({ mode: 'native', language: 'zh-CN', lines: [{ speaker: 'host', text: '这个小工具改变了我的早晨。', at: 0.5, to: 2.8 }] });
    expect(one).toBe(' Dialogue: native speech in Mandarin Chinese, recorded with the picture and lip-synced, the mouth of host moving exactly with the words. Timeline of the lines, in seconds from the start of the clip: 0.5-2.8 s host says "这个小工具改变了我的早晨。". Nobody speaks outside these times, and mouths rest closed between the lines. No other dialogue, no narrator, no captions or on-screen text, no dubbing and no translated speech. The generated speech is the final audio and is not replaced afterwards.');
    const two = speechPrompt(timedDialogue(speech, times) ?? speech as never);
    expect(two).toContain('native speech in American English');
    expect(two).toContain('the mouth of each speaker moving exactly with their own words');
    expect(two).toContain('0.5-2.8 s host says "I use it every single day."; 3.0-4.8 s guest says "And I keep asking about it."');
  });

  it('maps common language tags to names and falls back to the tag', () => {
    expect(['en-US', 'en-GB', 'zh-CN', 'zh', 'ja', 'ko-KR', 'pt-BR', 'yue', 'sw-KE'].map(languageName)).toEqual(['American English', 'British English', 'Mandarin Chinese', 'Mandarin Chinese', 'Japanese', 'Korean', 'Brazilian Portuguese', 'Cantonese', 'sw-KE']);
  });

  it('keeps the first form of speech as it was', () => {
    const old = { mode: 'native' as const, speaker: 'host', text: 'Exact words' };
    expect(isVisibleSpeech(old)).toBe(true);
    expect(isVisibleSpeech(speech)).toBe(true);
    expect(isVisibleSpeech({ mode: 'native', speaker: 'host' })).toBe(false);
    expect(speechPrompt(old)).toContain(' Visible speaker host says exactly: "Exact words".');
  });
});

describe('what is refused before a clip is paid for', () => {
  const problemsOf = (s: Partial<DialogueSpeech> & Pick<DialogueSpeech, 'lines'>, o: { seconds?: number; times?: BeatTimes | undefined; cast?: string[] } = {}) =>
    dialogueProblems({ mode: 'native', language: 'en-US', ...s } as DialogueSpeech, { at: '[0]', cast: o.cast ?? ['host', 'guest'], seconds: o.seconds ?? 5, ...('times' in o ? (o.times ? { times: o.times } : {}) : { times }) });

  it('accepts lines that name on-camera beats, in order, inside the clip', () => {
    expect(problemsOf(speech)).toEqual([]);
  });

  it('asks for the language, and for lines written in its script', () => {
    const none = problemsOf({ language: undefined as unknown as string, lines: speech.lines });
    expect(none[0]).toMatchObject({ level: 'error', at: '[0].speech.language' });
    expect(none[0]?.fix).toContain('"language"');
    const wrong = problemsOf({ language: 'zh-CN', lines: speech.lines });
    expect(wrong.map((p) => p.at)).toEqual(['[0].speech.lines[0].text', '[0].speech.lines[1].text']);
    expect(wrong[0]?.message).toContain('not written in the script of its language (Mandarin Chinese)');
    expect(wrong[0]?.fix).toContain('or correct "language"');
  });

  it('holds a line to a beat of the template, never to seconds written by hand', () => {
    const byHand = problemsOf({ lines: [{ speaker: 'host', text: 'Hello there.', at: 0.5, to: 2 }] });
    expect(byHand[0]?.message).toContain('names the beat it re-makes');
    expect(byHand[0]?.fix).toBe('Write "beat": <the number of its beat> and remove "at" and "to".');
    expect(problemsOf({ lines: [{ speaker: 'host', text: 'Hello there.', beat: 2, at: 1, to: 2 }] })[0]?.fix).toContain('Remove "at" and "to"');
    expect(problemsOf({ lines: [{ speaker: 'host', text: 'Hello there.', beat: 9 }] })[0]?.message).toContain('The template has no beat 9');
    const narrated = problemsOf({ lines: [{ speaker: 'host', text: 'Hello there.', beat: 0 }] });
    expect(narrated[0]?.message).toContain('Beat 0 is not said on camera');
    expect(narrated[0]?.fix).toContain('narration is the voice-over\'s');
    expect(problemsOf(speech, { times: undefined })[0]?.fix).toBe('Run the command with --template <the template directory>.');
    // Seconds by hand are right, and checked, where there is no template's beat to point at.
    expect(problemsOf({ lines: [{ speaker: 'host', text: 'Hello there.', at: 0.5, to: 2 }] }, { times: undefined })).toEqual([]);
    expect(problemsOf({ lines: [{ speaker: 'host', text: 'Hello there.', at: 2, to: 1 }] }, { times: undefined })[0]?.message).toContain('"to" after "at"');
  });

  it('wants every speaker in the cast, the lines in order, inside the clip, and sayable in their slots', () => {
    expect(problemsOf(speech, { cast: ['host'] })[0]).toMatchObject({ at: '[0].speech.lines[1].speaker' });
    const swapped = problemsOf({ lines: [speech.lines[1] as never, speech.lines[0] as never] });
    expect(swapped[0]?.message).toContain('the lines of a clip follow one another');
    const short = problemsOf(speech, { seconds: 4 });
    expect(short[0]?.message).toBe('Line 1 ends at 4.80 s; the clip is 4 s long.');
    expect(short[0]?.fix).toContain('Ask for a clip of at least 5 s');
    // Beat 3 lasts 1.8 s: at an ordinary pace times 1.25 that is about 33 letters.
    expect(Math.floor(fastestPace('abc') * 1.8)).toBe(33);
    const long = problemsOf({ lines: [speech.lines[0] as never, { speaker: 'guest', text: 'And honestly I keep asking everybody about it all the time.', beat: 3 }] });
    expect(long[0]).toMatchObject({ at: '[0].speech.lines[1].text' });
    expect(long[0]?.fix).toContain('Shorten it to about 33 characters');
    // The reference speaker's pace counts when it was measured in the line's script.
    expect(fastestPace('abc', { charactersPerSecond: 20, language: 'en' })).toBe(25);
    expect(fastestPace('你好', { charactersPerSecond: 20, language: 'en' })).toBe(6.25);
    // A line whose beat begins before the clip's first shot.
    expect(problemsOf({ shot: 3, lines: speech.lines })[0]?.fix).toContain('Start the clip at an earlier shot');
  });

  it('wants every on-camera beat said by exactly one clip', () => {
    const open = coverageProblems([request()], times);
    expect(open).toHaveLength(1);
    expect(open[0]?.message).toContain('No clip says the on-camera beat 4');
    expect(open[0]?.fix).toContain('Never replace a speaking person with silent footage and a voice-over');
    expect(open[0]?.fix).toContain('stop and tell the user the price');
    const all = [request(), request({ file: 'assets/talk-2.mp4', speech: { mode: 'native', language: 'en-US', lines: [{ speaker: 'host', text: 'Try it.', beat: 4 }] } })];
    expect(coverageProblems(all, times)).toEqual([]);
    // A clip the project has already says beat 4.
    expect(coverageProblems([request()], times, new Set([4]))).toEqual([]);
    const twice = coverageProblems([...all, request({ file: 'assets/again.mp4', speech: { mode: 'native', language: 'en-US', lines: [{ speaker: 'host', text: 'Try it.', beat: 4 }] } })], times);
    expect(twice[0]?.message).toBe('Beat 4 is said by more than one clip (assets/talk-2.mp4, assets/again.mp4).');
  });

  it('is asked through the request list, and nothing is sent while a problem stands', async () => {
    const dir = await project('refused');
    const generator = keeping();
    const r = await makeMaterials(rt, { requests: [request()], dir, generator, times });
    expect(generator.asked).toEqual([]);
    expect(r.problems.map((p) => p.message).join(' ')).toContain('No clip says the on-camera beat 4');
    expect((await checkRequests(rt, [request({ speech: { ...speech, language: '' } })], dir))[0]).toMatchObject({ at: '[0].speech.language' });
    // The first form still passes the list's check.
    expect(await checkRequests(rt, [request({ cast: ['host'], speech: { mode: 'native', speaker: 'host', text: 'Exact words' } })], dir)).toEqual([]);
  });
});

describe.skipIf(!ffmpeg)('a clip made with lines', () => {
  // Each role appears in one clip: a role of several clips needs its identity image first (generate/cast.ts).
  const both = (): MaterialRequest[] => [request(), request({ file: 'assets/talk-2.mp4', seconds: 4, cast: ['coach'], speech: { mode: 'native', language: 'en-US', lines: [{ speaker: 'coach', text: 'Try it.', beat: 4 }] } })];

  it('gets the dialogue block spliced into its prompt by the program, and a receipt with the lines, the language and the times', async () => {
    const dir = await project('made');
    const generator = keeping();
    const r = await makeMaterials(rt, { requests: both(), dir, generator, times });
    expect(r.problems).toEqual([]);
    const sent = generator.asked.find((a) => a.prompt.includes('kitchen table') && a.prompt.includes('guest says'));
    expect(sent?.prompt).toContain('Two friends at a kitchen table, medium shot.');
    expect(sent?.prompt).toContain('native speech in American English');
    expect(sent?.prompt).toContain('0.5-2.8 s host says "I use it every single day."; 3.0-4.8 s guest says "And I keep asking about it."');
    expect(sent?.prompt).not.toContain('No background music');
    const receipt = JSON.parse(await readFile(path.join(dir, 'assets/talk.mp4.speech.json'), 'utf8')) as { mode: string; language: string; speaker: string; text: string; lines: unknown[] };
    expect(receipt).toMatchObject({ mode: 'native', language: 'en-US', speaker: 'host, guest', text: 'I use it every single day. And I keep asking about it.' });
    expect(receipt.lines).toEqual([{ speaker: 'host', text: 'I use it every single day.', at: 0.5, to: 2.8, beat: 2 }, { speaker: 'guest', text: 'And I keep asking about it.', at: 3, to: 4.8, beat: 3 }]);
    // What the mix and the fill's check read back from the receipt.
    expect(await speechSpans(rt, path.join(dir, 'assets/talk.mp4'), 5)).toEqual([[0.5, 2.8], [3, 4.8]]);
    expect([...(await beatsSaid(rt, dir, ['assets/talk.mp4', 'assets/talk-2.mp4'])).keys()].sort()).toEqual([2, 3, 4]);
    // The same list again makes nothing new.
    const again = keeping();
    expect((await makeMaterials(rt, { requests: both(), dir, generator: again, times })).problems).toEqual([]);
    expect(again.asked).toEqual([]);
  }, 60_000);

  it('asks for every clip of a video with a music track of its own without background music, and says so', async () => {
    const dir = await project('music');
    const generator = keeping();
    const scenery: MaterialRequest = { file: 'assets/street.mp4', prompt: 'A rainy street at night, neon signs.', seconds: 2, cast: [] };
    const r = await makeMaterials(rt, { requests: [...both(), scenery], dir, generator, times, music: true, anchor: false });
    expect(r.problems).toEqual([]);
    expect(generator.asked).toHaveLength(3);
    for (const a of generator.asked) expect(a.prompt.endsWith(NO_MUSIC)).toBe(true);
    expect(NO_MUSIC).toContain('No background music');
    expect(r.notes?.join(' ')).toContain('every clip was asked for without background music');
    // A video of one generated clip keeps that clip's own soundtrack.
    const single = await project('single');
    const one = keeping();
    const alone = await makeMaterials(rt, { requests: [scenery], dir: single, generator: one, music: true });
    expect(one.asked[0]?.prompt).toBe('A rainy street at night, neon signs.');
    expect(alone.notes?.join(' ')).toContain('one generated clip: it keeps its own continuous soundtrack');
  }, 60_000);

  it('lets the person speak natively in a project with a registered voice, which is the timbre reference where it can be', async () => {
    const dir = await project('voiced');
    const sample = path.join(dir, 'sample.wav');
    await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4', sample]);
    await registerVoice(rt, dir, 'host', sample, 'native-reference');
    const generator = keeping();
    const solo = request({ file: 'assets/solo.mp4', cast: ['host'], speech: { mode: 'native', language: 'en-US', lines: [{ speaker: 'host', text: 'I use it every single day.', beat: 2 }, { speaker: 'host', text: 'Really every day.', beat: 3 }] } });
    const last = request({ file: 'assets/last.mp4', seconds: 4, cast: ['guest'], speech: { mode: 'native', language: 'en-US', lines: [{ speaker: 'guest', text: 'Try it.', beat: 4 }] } });
    const r = await makeMaterials(rt, { requests: [solo, last], dir, generator, times });
    expect(r.problems).toEqual([]);
    expect(generator.asked[0]?.audios).toHaveLength(1);
    expect(generator.asked[0]?.prompt).toContain('defines the voice identity and timbre only');
    expect(generator.asked[0]?.prompt).toContain('0.5-2.8 s host says');
  }, 60_000);
});
