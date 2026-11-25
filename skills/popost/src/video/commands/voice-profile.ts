import { printJson } from '../../core/util';
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
  {flag:'--out',required:true,metavar:'WAV',help:'final audio output; uses POPOST_VOICE_CMD'},
 ]},async(args,rt)=>{
 try{await speakProfile(rt,userPath(rt,args.req('project')),args.req('speaker'),args.req('text'),userPath(rt,args.req('out')));printJson(rt,{ok:true,audio:args.req('out'),receipt:args.req('out')+'.voice.json'});}
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
export const voiceProfileCommands:Commands={add,speak,complete};
