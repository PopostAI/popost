import type { Runtime } from '../../runtime';
import { sha256 } from '../../core/util';
import { withTempDir } from '../host';
import { audioSeconds } from './index';
import { runTool } from '../tool';
import { runFfmpegOk } from '../media/ffmpeg';
import { hostedSpeech, selectHostedVoice } from './hosted';

export interface VoiceProfile { id: string; reference: string; sha256: string; mode: 'audio-first' | 'native-reference'; providerVoice?: string }
interface Voices { version: 1; speakers: VoiceProfile[] }
export const readVoices = async (rt: Runtime, dir: string): Promise<Voices> => {
  const path = rt.path.join(dir,'voices.json');
  if (!(await rt.fs.stat(path))) return {version:1,speakers:[]};
  const data = JSON.parse(await rt.fs.readText(path)) as Voices;
  if (data.version!==1 || !Array.isArray(data.speakers)) throw new Error('voices.json must contain version 1 and a speakers list.');
  return data;
};
export const voiceProfile = async (rt: Runtime, dir: string, id: string): Promise<VoiceProfile | undefined> => {
  const voices=await readVoices(rt,dir), profile=voices.speakers.find(v=>v.id===id);
  if (!profile && voices.speakers.length) throw new Error('No shared voice profile for speaker "'+id+'". Register it before generating dialogue.');
  if (profile) {
    const rel=rt.path.relative(rt.path.resolve(dir),rt.path.resolve(dir,profile.reference));
    if (!rel || rel.startsWith('..') || rt.path.isAbsolute(profile.reference)) throw new Error('Voice reference must be inside the project.');
    if (sha256(await rt.fs.readFile(rt.path.resolve(dir,profile.reference)))!==profile.sha256) throw new Error('The voice reference changed. Register the new voice before generating dialogue.');
  }
  return profile;
};
export const registerVoice = async (rt: Runtime, dir: string, id: string, file: string, mode: VoiceProfile['mode'], providerVoice?: string): Promise<VoiceProfile> => {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Speaker id uses letters, numbers, _ and -.');
  if (!['audio-first','native-reference'].includes(mode)) throw new Error('Voice mode is audio-first or native-reference.');
  const duration=await audioSeconds(rt,file);
  if (!(duration>0 && duration<=300)) throw new Error('Supply a voice reference with 0 to 300 seconds of readable audio.');
  const reference='assets/voices/'+id+'.wav';
  const normalized=await withTempDir(rt,'popost-voice-reference-',async temp=>{
    const wav=rt.path.join(temp,'reference.wav');
    await runFfmpegOk(rt,['-y','-loglevel','error','-i',file,'-vn','-ac','1','-ar','48000','-c:a','pcm_s16le',wav]);
    return rt.fs.readFile(wav);
  });
  const bytes=normalized;await rt.fs.writeFile(rt.path.join(dir,reference),bytes);
  const profile:VoiceProfile={id,reference,sha256:sha256(bytes),mode,...(providerVoice?{providerVoice}:{})};
  const voices=await readVoices(rt,dir);voices.speakers=[...voices.speakers.filter(v=>v.id!==id),profile];
  await rt.fs.writeFile(rt.path.join(dir,'voices.json'),JSON.stringify(voices,null,2));return profile;
};
/**
 * One shared cloned/preset voice for visible speakers and voice-over; never substitute an unrelated system voice.
 * Word times the synthesizer gave (hosted speech does) are kept beside out as <out>.words.json; returns that path.
 */
export const speakProfile = async (rt: Runtime, dir: string, id: string, text: string, out: string): Promise<{ words?: string }> => {
  const profile=await voiceProfile(rt,dir,id);
  if (!profile || !text.trim()) throw new Error('Register the speaker and supply the final spoken text.');
  return withTempDir(rt,'popost-shared-voice-',async temp=>{
    const request=rt.path.join(temp,'request.json'), audio=rt.path.join(temp,'voice.wav');
    await rt.fs.writeFile(request,JSON.stringify({text,speaker:id,referenceAudio:rt.path.resolve(dir,profile.reference),voice:profile.providerVoice}));
    const hosted = profile.providerVoice?.startsWith('popost:');
    if (hosted) await hostedSpeech(rt, await selectHostedVoice(rt, profile.providerVoice!), text, audio, Number(rt.env.POPOST_VOICE_MAX_CREDITS ?? NaN), 1, out);
    else await runTool(rt,'POPOST_VOICE_CMD','The shared-voice synthesizer',[request,audio]);
    const seconds=await audioSeconds(rt,audio);
    const bytes=await rt.fs.readFile(audio);await rt.fs.writeFile(out,bytes);
    const provenance = hosted ? JSON.parse(await rt.fs.readText(audio+'.voice.json')) as Record<string,unknown> : {};
    await rt.fs.writeFile(out+'.voice.json',JSON.stringify({...provenance,version:1,speaker:id,text,seconds,voiceReferenceHash:profile.sha256,audioSha256:sha256(bytes),tool: hosted ? 'popost-hosted-voice' : 'POPOST_VOICE_CMD'},null,2));
    const words=await rt.fs.readFile(audio+'.words.json').catch(()=>undefined);
    if (!words) { await rt.fs.rm(out+'.words.json'); return {}; }
    await rt.fs.writeFile(out+'.words.json',words);
    return { words: out+'.words.json' };
  });
};

/** Import speech actually produced by the host's selected voice service, preserving its real provenance. */
export const completeVoice = async (rt: Runtime, dir: string, id: string, text: string, file: string, out: string, tool: string): Promise<void> => {
  const profile=await voiceProfile(rt,dir,id);
  if(!profile || !text.trim() || !tool.trim())throw new Error('Register the speaker and supply the exact spoken text and actual tool provenance.');
  const seconds=await audioSeconds(rt,file);
  const bytes=await rt.fs.readFile(file);await rt.fs.writeFile(out,bytes);
  await rt.fs.writeFile(out+'.voice.json',JSON.stringify({version:1,speaker:id,text,seconds,voiceReferenceHash:profile.sha256,audioSha256:sha256(bytes),tool},null,2));
};
