import { printJson } from '../../core/util';
import { downloadVoiceAudio, hostedVoicePage, quoteHostedVoice, selectHostedVoice, speechPrice } from '../voice/hosted';
import { PriceNotAgreed } from '../wallet';
import { CREDIT_OPTIONS, walletFor } from './credits';
import { withTempDir } from '../host';
import { voiceProfile } from '../voice/profile';
import { completeVoice, registerVoice, speakProfile } from '../voice/profile';
import { CONSENT, createHostedVoice } from '../voice/create';
import { PopostApiError } from '../../providers/errors';
import { command, PROJECT_OPTION, userPath, VideoCommandError, type Commands } from './shared';

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
  ...CREDIT_OPTIONS,
 ]},async(args,rt)=>{
 try{
 const project=userPath(rt,args.req('project'));const profile=await voiceProfile(rt,project,args.req('speaker'));
 const hosted=profile?.providerVoice?.startsWith('popost:');
 // A popost.ai voice is priced first: without --confirm the price is printed with exit code 3 and nothing is charged.
 const wallet=hosted?await walletFor(rt,args,await speechPrice(rt,[args.req('text')],profile!.providerVoice)):undefined;
 const said=await speakProfile(rt,project,args.req('speaker'),args.req('text'),userPath(rt,args.req('out')),wallet);printJson(rt,{ok:true,audio:args.req('out'),receipt:args.req('out')+'.voice.json',...(said.words?{words:args.req('out')+'.words.json'}:{}),chargedCredits:wallet?.spent??0});}
 catch(e){if(e instanceof PriceNotAgreed||e instanceof VideoCommandError)throw e;throw new VideoCommandError(String(e));}
},(args)=>args.string('project'));
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
const create=command('create a personal voice on the connected popost.ai account from a recording of one person (an audio or a video file): 10 to 60 s of its sound become the sample. --consent is required: '+CONSENT+'. The new voice is listed by voice list and used like an official one',{
 options:[
  {flag:'--file',required:true,metavar:'AUDIO_OR_VIDEO',help:'the recording: an audio or a video file ffmpeg can read, one person speaking clearly'},
  {flag:'--name',required:true,help:'the name of the voice in the catalog, 1 to 100 characters'},
  {flag:'--language',choices:['zh','en'],help:'what the voice speaks: zh or en'},
  {flag:'--description',help:'a note on the voice, at most 500 characters'},
  {flag:'--start',kind:'number',metavar:'SECONDS',help:'where in the recording the sample starts (default 0); at most 60 s from there are used'},
  {flag:'--consent',kind:'flag',help:'required: '+CONSENT},
  PROJECT_OPTION,
 ]},async(args,rt)=>{
 try{
  const language=args.string('language') as 'zh'|'en'|undefined, description=args.string('description'), start=args.number('start');
  const made=await createHostedVoice(rt,{file:userPath(rt,args.req('file')),name:args.req('name'),consent:args.flag('consent'),...(language?{language}:{}),...(description!==undefined?{description}:{}),...(start!==undefined?{start}:{})});
  const id=String(made.voice.id);
  printJson(rt,{ok:true,voice:made.voice,sample:made.sample,...(made.again?{note:'This voice was already made from the same sample and name; nothing new was created.'}:{}),next:'popost video voice use <project> --speaker <speaker> --voice '+id+' (or popost:'+id+' for plan --voice and template fill --speak)'});
 }catch(e){if(e instanceof PopostApiError)throw e;throw new VideoCommandError(e instanceof Error?e.message:String(e));}
},(args)=>args.string('project'));
const list=command('read the current published official and personal voice catalog (--scope all, mine or official); never charges',{
 options:[{flag:'--scope',help:'all, mine or official (default all)'},{flag:'--page',kind:'number',help:'page number'}],
},async(args,rt)=>{ printJson(rt,{ok:true,...await hostedVoicePage(rt,args.string('scope')??'all',args.number('page')??1)}); });
const quote=command('quote speech for a selected platform voice without charging',{
 options:[{flag:'--voice',required:true,help:'platform voice id, default-male or default-female'},{flag:'--text',required:true,help:'final spoken words'}],
},async(args,rt)=>{const voice=await selectHostedVoice(rt,args.req('voice'));printJson(rt,{ok:true,voice:voice.id,name:voice.name,credits:await quoteHostedVoice(rt,voice.id,args.req('text'))});});
const use=command('select a platform voice for a project speaker and download its real preview; never clones it again',{
 positionals:[{name:'project',help:'project directory'}],options:[{flag:'--speaker',required:true,help:'stable project speaker id'},{flag:'--voice',required:true,help:'platform voice id, default-male or default-female'}],
},async(args,rt)=>{const voice=await selectHostedVoice(rt,args.req('voice'));await withTempDir(rt,'popost-selected-voice-',async dir=>{const sample=rt.path.join(dir,'sample.wav');await downloadVoiceAudio(rt,voice.sampleUrl,sample);const profile=await registerVoice(rt,userPath(rt,args.req('project')),args.req('speaker'),sample,'audio-first','popost:'+voice.id);printJson(rt,{ok:true,voice:voice.id,name:voice.name,profile});});},(args)=>args.string('project'));
export const voiceProfileCommands:Commands={list,create,use,quote,add,speak,complete};
