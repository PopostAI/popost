import { printJson } from '../../core/util';
import { castPrompt, castVisualInstruction, completeCast, readCast } from '../generate/cast';
import { finalizeSpeech } from '../generate/speech';
import { command, userPath, VideoCommandError, type Commands } from './shared';

const prepare = command('prepare optional identity image jobs from cast.json; multiple generated clips reuse a locked image, one generated clip may define its new person directly', {
  positionals: [{ name: 'project', help: 'project directory containing cast.json' }],
  options: [{flag:'--requests',metavar:'FILE',help:'material request list; count each role’s appearances before deciding which images are needed'}],
}, async (args, rt) => {
  try {
    const dir = userPath(rt, args.req('project')), cast = await readCast(rt, dir);
    const file=args.string('requests');
    const requests=file ? JSON.parse(await rt.fs.readText(userPath(rt,file))) as {cast?:string[]}[] : [];
    if(!Array.isArray(requests))throw new Error('Requests must be a JSON list.');
    const required=(id:string,shots?:string[]):boolean=>file ? requests.filter(r=>r.cast?.includes(id)).length>1 : (shots?.length??0)>1;
    printJson(rt, { ok: true, channel: 'host', direct:cast.roles.filter(role=>!required(role.id,role.shots)&&(!role.identity||role.identity==='new')&&!role.image).map(role=>({id:role.id,description:role.description,...(role.visual?{visual:role.visual,instruction:castVisualInstruction(role)}:{}),method:'Define this new single-appearance '+(role.visual?'character':'person')+' directly in the video prompt.'})),
      jobs: cast.roles.filter(role=>required(role.id,role.shots)&&(!role.identity||role.identity==='new')&&!role.image).map(role => ({ id: role.id, identity: role.identity ?? 'new', ...(role.visual?{visual:role.visual}:{}), prompt: castPrompt(role), completed: !!role.image,
      references: role.identity === 'new' ? [] : role.image ? [role.image] : [], next: 'Generate with the host image tool, inspect the real output, then video cast complete.' })) });
  } catch (e) { throw new VideoCommandError(String(e)); }
});
const complete = command('import a real generated identity image and record its hash and actual tool provenance', {
  positionals: [{ name: 'project', help: 'project directory' }],
  options: [{ flag: '--role', required: true, metavar: 'ID', help: 'cast role id' }, { flag: '--file', required: true, metavar: 'FILE', help: 'actual generated image' }, { flag: '--tool', required: true, metavar: 'NAME', help: 'actual tool provenance, e.g. image_gen' }],
}, async (args, rt) => {
  try { printJson(rt, { ok: true, role: await completeCast(rt, userPath(rt, args.req('project')), args.req('role'), userPath(rt, args.req('file')), args.req('tool')) }); }
  catch (e) { throw new VideoCommandError(String(e)); }
});
const speech = command('lock visible speech to native audio, or synchronize a clip to an exact replacement voice using POPOST_LIPSYNC_CMD', {
  positionals: [{ name: 'clip', help: 'clip to finalize (kept in place)' }],
  options: [{ flag: '--text', required: true, metavar: 'TEXT', help: 'exact final spoken text' }, { flag: '--speaker', required: true, metavar: 'ID', help: 'visible cast role' }, { flag: '--audio', metavar: 'FILE', help: 'final voice; requires a real lip-sync tool' }],
}, async (args, rt) => {
  try { const audio = args.string('audio'); await finalizeSpeech(rt, userPath(rt, args.req('clip')), { mode: audio ? 'lip-sync' : 'native', text: args.req('text'), speaker: args.req('speaker'), ...(audio ? { audio: userPath(rt, audio) } : {}) }, rt.cwd); printJson(rt, { ok: true, receipt: args.req('clip') + '.speech.json' }); }
  catch (e) { throw new VideoCommandError(String(e)); }
});
export const castCommands: Commands = { prepare, complete };
export const speechCommands: Commands = { speech };
