import { printJson } from '../../core/util';
import { downloadVoiceAudio, hostedVoicePage, quoteHostedVoice, selectHostedVoice } from '../voice/hosted';
import { withTempDir } from '../host';
import { voiceProfile } from '../voice/profile';
import { completeVoice, registerVoice, speakProfile } from '../voice/profile';
import { command, userPath, VideoCommandError, type Commands } from './shared';

const add=command('register an uploaded voice reference shared by every spoken shot and voice-over in a project',{
 positionals:[{name:'project',help:'project directory'}],options:[
  {flag:'--speaker',required:true,metavar:'ID',help:'stable speaker id'},
  {flag:'--file',required:true,metavar:'AUDIO',help:'user-supplied voice reference'},
  {flag:'--mode',metavar:'MODE',help:'audio-first (default), or native-reference for a video model with timbre conditioning'},
  {flag:'--provider-voice',metavar:'ID',help:'optional existing cloned/preset voice id used by the configured synthesizer'},
 ]},async(args,rt)=>{
 try{
  const mode=args.string('mode')??'audio-first';
  if(mode!=='audio-first'&&mode!=='native-reference')throw new Error('Choose audio-first or native-reference.');
  printJson(rt,{ok:true,profile:await registerVoice(rt,userPath(rt,args.req('project')),args.req('speaker'),userPath(rt,args.req('file')),mode,args.string('provider-voice'))});
 }catch(e){throw new VideoCommandError(String(e));}
});
const speak=command('generate final dialogue or voice-over from the same registered voice; visible speaking footage must lip-sync to this exact result',{
 positionals:[{name:'project',help:'project directory'}],options:[
  {flag:'--speaker',required:true,metavar:'ID',help:'registered speaker id'},
  {flag:'--text',required:true,metavar:'TEXT',help:'final spoken words'},
  {flag:'--out',required:true,metavar:'WAV',help:'final audio output'},
  {flag:'--confirm',kind:'flag',help:'confirm the quoted hosted speech charge'},
  {flag:'--max-credits',kind:'number',help:'confirmed hosted speech credit ceiling'},
 ]},async(args,rt)=>{
 try{
 const project=userPath(rt,args.req('project'));const profile=await voiceProfile(rt,project,args.req('speaker'));
 const hosted=profile?.providerVoice?.startsWith('popost:');
 if(hosted && (!args.flag('confirm') || args.number('max-credits')===undefined)) throw new Error('Run voice quote, then pass --confirm --max-credits N.');
 const runtime=hosted?{...rt,env:{...rt.env,POPOST_VOICE_MAX_CREDITS:String(args.number('max-credits'))}}:rt;
 await speakProfile(runtime,project,args.req('speaker'),args.req('text'),userPath(rt,args.req('out')));printJson(rt,{ok:true,audio:args.req('out'),receipt:args.req('out')+'.voice.json'});}
 catch(e){throw new VideoCommandError(String(e));}
});
const complete=command('import real speech from the host voice service and bind it to the shared speaker profile',{
 positionals:[{name:'project',help:'project directory'}],options:[
  {flag:'--speaker',required:true,metavar:'ID',help:'registered speaker id'},
  {flag:'--text',required:true,metavar:'TEXT',help:'actual final spoken words'},
  {flag:'--file',required:true,metavar:'AUDIO',help:'actual result of the selected voice service'},
  {flag:'--out',required:true,metavar:'AUDIO',help:'audio destination with the matching file extension'},
  {flag:'--tool',required:true,metavar:'NAME',help:'actual host tool provenance'},
 ]},async(args,rt)=>{
 try{await completeVoice(rt,userPath(rt,args.req('project')),args.req('speaker'),args.req('text'),userPath(rt,args.req('file')),userPath(rt,args.req('out')),args.req('tool'));printJson(rt,{ok:true,audio:args.req('out'),receipt:args.req('out')+'.voice.json'});}
 catch(e){throw new VideoCommandError(String(e));}
});
const list=command('read the current published official and personal voice catalog; never charges',{
 options:[{flag:'--scope',help:'all, mine or official (default all)'},{flag:'--page',kind:'number',help:'page number'}],
},async(args,rt)=>{ printJson(rt,{ok:true,...await hostedVoicePage(rt,args.string('scope')??'all',args.number('page')??1)}); });
const quote=command('quote speech for a selected platform voice without charging',{
 options:[{flag:'--voice',required:true,help:'platform voice id, default-male or default-female'},{flag:'--text',required:true,help:'final spoken words'}],
},async(args,rt)=>{const voice=await selectHostedVoice(rt,args.req('voice'));printJson(rt,{ok:true,voice:voice.id,name:voice.name,credits:await quoteHostedVoice(rt,voice.id,args.req('text'))});});
const use=command('select a platform voice for a project speaker and download its real preview; never clones it again',{
 positionals:[{name:'project',help:'project directory'}],options:[{flag:'--speaker',required:true,help:'stable project speaker id'},{flag:'--voice',required:true,help:'platform voice id, default-male or default-female'}],
},async(args,rt)=>{const voice=await selectHostedVoice(rt,args.req('voice'));await withTempDir(rt,'popost-selected-voice-',async dir=>{const sample=rt.path.join(dir,'sample.wav');await downloadVoiceAudio(rt,voice.sampleUrl,sample);const profile=await registerVoice(rt,userPath(rt,args.req('project')),args.req('speaker'),sample,'audio-first','popost:'+voice.id);printJson(rt,{ok:true,voice:voice.id,name:voice.name,profile});});});
export const voiceProfileCommands:Commands={list,use,quote,add,speak,complete};
