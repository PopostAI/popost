/**
 * What the sound of a project is held to once its files are at hand (the build step, so render, preview and check all
 * ask): the voice-over never speaks while the person of a clip speaks, and in a project made from a reference every
 * audio track has a record of where its sound came from: the voice template fill --speak mixed, generated music, or a
 * file the user gave (music/provenance.ts). An audio track written into video.json by hand with a file of another
 * origin (a narration put together with other tools, the reference's own sound) is refused.
 */
import { sha256 } from '../../core/util';
import type { Runtime } from '../../runtime';
import { clipMusicBases, SOUND_FIX, soundSource } from '../music/provenance';
import type { ClipMusicBasis } from '../sound/modes';
import { overlapOf } from '../timeline/mix';
import type { Problem, Project, Resolved } from '../types';
import { error } from './check-common';
import { replicationSoundSource } from '../replication/audio-provenance';

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

const overlap = (a: readonly [number, number], b: readonly [number, number]): [number, number] | undefined => {
  const span: [number, number] = [Math.max(a[0], b[0]), Math.min(a[1], b[1])];
  return span[1] > span[0] ? span : undefined;
};

/**
 * One music source at any moment (video-sound.md, R2 and R4). The video's music track gives way by itself to a clip
 * that brings music (timeline/mix.ts), so what is refused is what the mix cannot settle: two music tracks at once, a
 * music track whose "gain" keeps it up under such a clip, and two clips with music heard together.
 */
export const musicOverlap = (r: Resolved): Problem[] => {
  const m = r.music;
  if (!m) return [];
  const fps = r.canvas.fps, out: Problem[] = [];
  const said = (s: readonly [number, number]): string => seconds(s[0], fps) + ' to ' + seconds(s[1], fps);
  m.tracks.forEach((a, i) => m.tracks.slice(i + 1).forEach((b) => {
    const hit = overlap(a.span, b.span);
    if (hit) out.push(error('tracks.' + b.id, 'Two music tracks are heard at once from ' + said(hit) + ' ("' + a.id + '" and "' + b.id + '"): a video has one music source at any moment.', 'Keep one bed for the whole video; when the music changes on purpose, end one track ("during") where the next begins.'));
  }));
  for (const c of m.clips) {
    const id = c.id.replace(/\.audio$/, '');
    for (const t of m.tracks.filter((x) => x.fixed)) {
      const hit = overlap(c.span, t.span);
      if (hit) out.push(error('tracks.' + t.id, 'The music track "' + t.id + '" keeps its level ("gain") from ' + said(hit) + ' while "' + id + '" brings ' + (c.exhibit ? 'its own sound as an exhibit' : 'music of its own') + ': two musics are heard at once.', 'Remove "gain" from the music track: it then gives way for the clip and comes back after it. Or make the clip\'s sound "ambience" or "silent" where it should not bring its own.'));
    }
  }
  m.clips.forEach((a, i) => m.clips.slice(i + 1).forEach((b) => {
    const hit = overlap(a.span, b.span);
    if (hit) out.push(error('tracks.' + b.id.replace(/\.audio$/, ''), 'Two clips that bring music of their own are heard at once from ' + said(hit) + ' ("' + a.id.replace(/\.audio$/, '') + '" and "' + b.id.replace(/\.audio$/, '') + '").', 'Give one of them "sound": "silent" (or "audio": false) for that stretch.'));
  }));
  return out;
};

/**
 * Music inside a clip rests on a recorded basis (R4): every clip made with music names an exception the project's
 * music plan records, and the exception "per-segment" (each segment its own music) goes with no music track at all.
 */
export const clipMusicRecords = async (rt: Runtime, dir: string, r: Resolved): Promise<Problem[]> => {
  const carrying = (r.music?.clips ?? []).filter((c) => !c.exhibit && c.basis);
  if (!carrying.length) return [];
  const recorded = await clipMusicBases(rt, dir);
  const out = carrying.filter((c) => !recorded.includes(c.basis as ClipMusicBasis)).map((c) =>
    error('tracks.' + c.id.replace(/\.audio$/, ''), 'The clip of "' + c.id.replace(/\.audio$/, '') + '" was made with music of its own ("' + c.basis + '"), and the project\'s music plan records no such exception.',
      'Record what it rests on and show it to the user with the plan: popost video music plan --project <dir> --clip-music ' + c.basis + ' --basis "<the reference reading, or the user\'s words>". Or use the clip without its sound ("sound": "silent").'));
  if (carrying.some((c) => c.basis === 'per-segment') && r.music?.tracks.length)
    out.push(error('tracks.' + (r.music.tracks[0]?.id ?? 'music'), 'The clips bring their own music segment by segment ("per-segment"), and the video has a music track as well.', 'Remove the music track: a video whose music changes with its segments has no bed.'));
  return out;
};

/**
 * Speaking clips join by hard cuts. A transition mixes two pictures and takes time; over a spoken word it shows a
 * mouth that is half another picture. Refused: a transition whose frames lie on a line a person says on camera.
 */
export const speakingCuts = (r: Resolved): Problem[] => {
  const dialogue = r.speech?.dialogue ?? [];
  if (!dialogue.length) return [];
  return r.segments.flatMap((s): Problem[] => {
    const t = s.transition;
    if (!t) return [];
    const during: [number, number] = [t.a, t.a + t.frames];
    const hit = dialogue.flatMap((d) => d.spans.map((span) => overlap(span, during))).find((x) => x !== undefined);
    return hit ? [error('segments.' + s.id + '.in', 'The ' + t.kind + ' into "' + s.id + '" (' + seconds(during[0], r.canvas.fps) + ' to ' + seconds(during[1], r.canvas.fps) + ') lies over words a person says on camera.', 'Join speaking clips by a hard cut ("transition": "cut"), or cut where nobody speaks. The sound of a line may run on under the next picture instead: an audio track with "bed": true over that span (video-sound.md, "Sound that runs past its picture").')] : [];
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
    if (!(await rt.fs.stat(full)) || (await voiceMixed(rt, full)) || (await soundSource(rt, full, dir))) continue;
    if (t.role === 'voice' && t.lines?.length && await replicationSoundSource(rt, dir, file) === 'registered-voice') continue;
    out.push(error('tracks.' + t.id, 'The audio track "' + t.id + '" plays "' + file + '", which has no record of where it came from: it is neither the voice template fill --speak mixed, nor generated music, nor a sound file the user gave.', SOUND_FIX));
  }
  return out;
};
