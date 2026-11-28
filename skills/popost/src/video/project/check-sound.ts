/**
 * What the sound of a project is held to once its files are at hand (the build step, so render, preview and check all
 * ask): the voice-over never speaks while the person of a clip speaks, and in a project made from a reference every
 * audio track has a record of where its sound came from: the voice template fill --speak mixed, generated music, or a
 * file the user gave (music/provenance.ts). An audio track written into video.json by hand with a file of another
 * origin (a narration put together with other tools, the reference's own sound) is refused.
 */
import { sha256 } from '../../core/util';
import type { Runtime } from '../../runtime';
import { SOUND_FIX, soundSource } from '../music/provenance';
import { overlapOf } from '../timeline/mix';
import type { Problem, Project, Resolved } from '../types';
import { error } from './check-common';

/** The record beside the voice a spoken fill mixed (retarget/speak.ts): <voice file>.mix.json with the file's hash. */
export const VOICE_RECEIPT = '.mix.json';
/** The files that say a project was made from a reference (template fill, retarget). */
const FROM_REFERENCE = ['reference.facts.json', 'reference.measure.json'];

export const writeVoiceReceipt = async (rt: Runtime, file: string, lines: number): Promise<void> =>
  rt.fs.writeFile(file + VOICE_RECEIPT, JSON.stringify({ version: 1, tool: 'popost video --speak', lines, audioSha256: sha256(await rt.fs.readFile(file)) }, null, 2) + '\n');

const voiceMixed = async (rt: Runtime, file: string): Promise<boolean> => {
  const receipt = await rt.fs.readText(file + VOICE_RECEIPT).then((t) => JSON.parse(t) as { audioSha256?: unknown }, () => undefined);
  return receipt !== undefined && receipt.audioSha256 === (await rt.fs.readFile(file).then(sha256, () => undefined));
};

const seconds = (frame: number, fps: number): string => (frame / fps).toFixed(2) + ' s';

/** The voice-over's lines against the lines people say in clips: one speech at a time. */
export const speechOverlap = (r: Resolved): Problem[] => {
  const s = r.speech;
  if (!s?.voice.length) return [];
  return s.dialogue.flatMap((d): Problem[] => {
    const hit = overlapOf(s.voice, d.spans);
    if (!hit) return [];
    const [voice, line] = hit, fps = r.canvas.fps;
    return [error('tracks.' + d.id.replace(/\.audio$/, ''), 'The voice-over speaks from ' + seconds(voice[0], fps) + ' to ' + seconds(voice[1], fps) + ' while the person of the clip speaks (' + seconds(line[0], fps) + ' to ' + seconds(line[1], fps) + '): two speeches are heard at once.',
      'Leave the voice-over\'s line of that beat empty, or move it to a beat in which nobody speaks; a line a person says on camera belongs to the clip alone.')];
  });
};

/** Every audio track of a project made from a reference names a sound with a record; dir: the project directory. */
export const soundRecords = async (rt: Runtime, dir: string, project: Project): Promise<Problem[]> => {
  const made = await Promise.all(FROM_REFERENCE.map((f) => rt.fs.stat(rt.path.join(dir, f))));
  if (!made.some(Boolean)) return [];
  const out: Problem[] = [];
  for (const t of project.tracks) {
    if (t.type !== 'audio' || t.bed) continue;
    const file = project.materials.find((m) => m.id === t.material)?.file;
    if (!file) continue;
    const full = rt.path.resolve(dir, file);
    // A missing file is the project check's to report.
    if (!(await rt.fs.stat(full)) || (await voiceMixed(rt, full)) || (await soundSource(rt, full))) continue;
    out.push(error('tracks.' + t.id, 'The audio track "' + t.id + '" plays "' + file + '", which has no record of where it came from: it is neither the voice template fill --speak mixed, nor generated music, nor a sound file the user gave.', SOUND_FIX));
  }
  return out;
};
