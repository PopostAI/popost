import type { Runtime } from '../../runtime';
import { sha256 } from '../../core/util';
import { programsOf, toolCommand, withTempDir } from '../host';
import { toolEnv } from '../tool';
import { probe, runFfmpegOk } from '../media/ffmpeg';
import { audioSeconds } from '../voice/index';
import { dialoguePrompt, isDialogue, type DialogueSpeech, type TimedDialogue } from './dialogue';

/** Native speech keeps the model's own sound. A replacement voice must pass through an actual lip-sync tool. */
export interface PlainSpeech { mode: 'native' | 'lip-sync'; text: string; speaker: string; audio?: string }
/** What a request says of visible speech: one speaker's words (the first form), or timed lines with their language (dialogue.ts). */
export type VisibleSpeech = PlainSpeech | DialogueSpeech;
/** Speech as it is sent and recorded: the first form as written, or the lines with the times the program gave them. */
export type SentSpeech = PlainSpeech | TimedDialogue;
const isPlain = (value: unknown): value is PlainSpeech => {
  if(!value || typeof value!=='object')return false;
  const v=value as Partial<PlainSpeech>;
  return (v.mode==='native'||v.mode==='lip-sync') && typeof v.text==='string' && !!v.text.trim() && typeof v.speaker==='string' && !!v.speaker.trim() && (v.audio===undefined || typeof v.audio==='string');
};
export const isVisibleSpeech = (value: unknown): value is VisibleSpeech => isDialogue(value) || isPlain(value);
/** Who speaks in a clip, each once. */
export const speakersOf = (speech: VisibleSpeech | SentSpeech): string[] => 'lines' in speech ? [...new Set(speech.lines.map((l) => l.speaker))] : [speech.speaker];
/** The final audio a lip-synced clip is made to (the first form only). */
export const speechAudio = (speech: VisibleSpeech | SentSpeech | undefined): string | undefined => (speech && !('lines' in speech) ? speech.audio : undefined);
export const speechPrompt = (speech: SentSpeech): string => 'lines' in speech ? dialoguePrompt(speech) : speech.mode === 'native'
  ? ' Visible speaker ' + speech.speaker + ' says exactly: ' + JSON.stringify(speech.text) + '. Generate synchronized visible articulation and native speech audio together, with natural pauses; no other dialogue, music, captions, translated dubbing or silent mouth motion. The generated speech audio is authoritative and will not be replaced afterwards.'
  : ' Visible speaker ' + speech.speaker + ' performs the supplied dialogue. The final voice is fixed separately and the result will pass through lip synchronization to that exact audio.';

export const finalizeSpeech = async (rt: Runtime, clip: string, speech: SentSpeech, dir: string, destination = clip): Promise<void> => {
  const said = 'lines' in speech ? { text: speech.lines.map((l) => l.text).join(' '), speaker: speakersOf(speech).join(', ') } : { text: speech.text, speaker: speech.speaker };
  if (!said.text?.trim() || !said.speaker?.trim()) throw new Error('Visible speech needs the final text and the visible speaker id.');
  if (!('lines' in speech) && speech.mode === 'lip-sync') {
    const words = toolCommand(rt, 'POPOST_LIPSYNC_CMD');
    if (!words || !speech.audio) throw new Error('Visible replacement speech requires POPOST_LIPSYNC_CMD and speech.audio. Audio references to a general video model are not proof of lip synchronization. Keep native speech instead, or configure a real lip-sync tool.');
    const audio = rt.path.resolve(dir, speech.audio);
    await withTempDir(rt, 'popost-lipsync-', async temp => {
      const request = rt.path.join(temp, 'request.json'), output = rt.path.join(temp, 'synced.mp4');
      await rt.fs.writeFile(request, JSON.stringify({ video: clip, audio, text: speech.text, speaker: speech.speaker }));
      const result = await programsOf(rt).run([...words, request, output], { env: toolEnv(rt), lowPriority: true });
      if (result.code !== 0 || !(await rt.fs.stat(output))?.isFile) throw new Error('Lip synchronization failed. The original clip and final voice were kept; no replacement dubbing was published.');
      const synced = await probe(rt, output), seconds = await audioSeconds(rt, audio);
      if (synced.frames / synced.fps + 1 / synced.fps < seconds) throw new Error('The lip-sync result is shorter than the final voice. Generate enough performance; do not stretch the mouth independently.');
      const muxed = rt.path.join(temp, 'final.mp4');
      await runFfmpegOk(rt, ['-y','-loglevel','error','-i',output,'-i',audio,'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-t',String(seconds),'-movflags','+faststart',muxed]);
      await rt.fs.writeFile(clip, await rt.fs.readFile(muxed));
    });
  } else if (speech.mode !== 'native') throw new Error('Visible speech mode must be native or lip-sync.');
  const p = await probe(rt, clip);
  const audioFile = clip + '.speech.wav';
  // Also fails for a model that silently ignored the request for native spoken audio.
  await runFfmpegOk(rt, ['-y','-loglevel','error','-i',clip,'-map','0:a:0','-vn','-ac','1','-ar','48000','-c:a','pcm_s16le',audioFile]);
  // With timed lines the receipt keeps the language and each line's slot in the clip (seconds): the mix reads them.
  const receipt = { version: 1, mode: speech.mode, speaker: said.speaker, text: said.text, ...('lines' in speech ? { language: speech.language, lines: speech.lines } : {}),
    videoSha256: sha256(await rt.fs.readFile(clip)), audioSha256: sha256(await rt.fs.readFile(audioFile)),
    audio: rt.path.basename(destination) + '.speech.wav', timing: 'Keep this clip and its embedded audio on the same source time, cut and playback rate. Never replace or reflow one independently.',
    review: 'Check the spoken words with readback and inspect visible articulation; this receipt proves audio provenance, not phoneme accuracy.', sourceFrames: p.frames, sourceFps: p.fps };
  await rt.fs.writeFile(clip + '.speech.json', JSON.stringify(receipt, null, 2));
};
