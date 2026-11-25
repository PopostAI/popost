import { afterAll, describe, expect, it } from 'vitest';
import { createDiskRuntime } from '../../src/testing/disk';
import { completeVoice, registerVoice, speakProfile, voiceProfile } from '../../src/video/voice/profile';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { makeMaterials } from '../../src/video/generate/index';
const rt=await createDiskRuntime();afterAll(()=>rt.cleanup());
const available=await hasFfmpeg(rt);
describe.skipIf(!available)('project-wide voice identity',()=>{
 it('normalizes an uploaded sample, imports actual host speech and binds its receipt to the speaker',async()=>{
  const dir=rt.path.join(rt.cwd,'voice-profile'),sample=rt.path.join(dir,'sample.wav');await rt.fs.mkdir(dir);
  await runFfmpegOk(rt,['-y','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=0.3',sample]);
  const profile=await registerVoice(rt,dir,'host',sample,'audio-first','chosen-clone-id');
  expect(profile.reference).toBe('assets/voices/host.wav');expect((await voiceProfile(rt,dir,'host'))?.providerVoice).toBe('chosen-clone-id');
  const out=rt.path.join(dir,'dialogue.wav');await completeVoice(rt,dir,'host','Example',sample,out,'actual-host-tool');
  const receipt=JSON.parse(await rt.fs.readText(out+'.voice.json')) as {voiceReferenceHash:string;speaker:string;tool:string};
  expect(receipt.voiceReferenceHash).toBe(profile.sha256);expect(receipt.speaker).toBe('host');expect(receipt.tool).toBe('actual-host-tool');
  await expect(speakProfile(rt,dir,'host','Example',rt.path.join(dir,'missing.wav'))).rejects.toThrow('POPOST_VOICE_CMD');
  expect(await rt.fs.stat(rt.path.join(dir,'missing.wav'))).toBeNull();
  await rt.fs.writeFile(rt.path.join(dir,profile.reference),new Uint8Array([9]));
  await expect(voiceProfile(rt,dir,'host')).rejects.toThrow('changed');
 });
 it('does not silently switch a shared audio-first voice to unconstrained native speech',async()=>{
  const dir=rt.path.join(rt.cwd,'shared-native'),sample=rt.path.join(dir,'voice.wav');await rt.fs.mkdir(dir);
  await runFfmpegOk(rt,['-y','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=0.3',sample]);
  await registerVoice(rt,dir,'host',sample,'audio-first');
  await rt.fs.writeFile(rt.path.join(dir,'cast.json'),JSON.stringify({version:1,roles:[{id:'host',description:'A fictional presenter'}]}));
  let sent=0;
  const result=await makeMaterials(rt,{dir,requests:[{file:'assets/host.mp4',prompt:'A presenter',cast:['host'],speech:{mode:'native',speaker:'host',text:'Example'}}],generator:{make:async()=>{sent++;return{};}}});
  expect(sent).toBe(0);expect(result.problems.some(p=>p.at.endsWith('.speech.voice'))).toBe(true);
 });
});
