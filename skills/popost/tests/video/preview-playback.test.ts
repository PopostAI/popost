import { afterAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import { createDiskRuntime } from '../../src/testing/disk';
import { findChromium } from '../../src/render/browser';
import { startPreview } from '../../src/video/preview/index';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { serverProcesses } from './make-fixtures';

const rt=await createDiskRuntime({processes:serverProcesses});afterAll(()=>rt.cleanup());
const chrome=findChromium(process.env), ffmpeg=await hasFfmpeg(rt);
describe.skipIf(!chrome||!ffmpeg)('native preview transport',()=>{
 it('decodes video continuously while playing, avoids per-frame PNG requests and restores exact paused frames',async()=>{
  const dir=rt.path.join(rt.cwd,'native-preview');await rt.fs.mkdir(dir);
  await runFfmpegOk(rt,['-y','-loglevel','error','-f','lavfi','-i','testsrc2=size=180x320:rate=30:duration=3','-f','lavfi','-i','sine=frequency=440:duration=3','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',rt.path.join(dir,'clip.mp4')]);
  await rt.fs.writeFile(rt.path.join(dir,'video.json'),JSON.stringify({version:1,canvas:{width:180,height:320,fps:30},materials:[{id:'clip',kind:'video',file:'clip.mp4'}],segments:[{id:'a',frames:90,base:{material:'clip'}}],tracks:[]}));
  const server=await startPreview(rt,{projectDir:dir,edit:true});
  const browser=await chromium.launch({executablePath:chrome!,headless:true});
  try{
   const page=await browser.newPage(), pictures:string[]=[];
   page.on('request',req=>{if(/\.cache\/.*\.png/.test(req.url()))pictures.push(req.url());});
   await page.goto(server.url);await page.waitForSelector('body[data-ready="1"]');
   pictures.length=0;await page.locator('#play').click();
   const frame=page.frames().find(f=>new URL(f.url()).pathname==='/page')!;
   await frame.waitForSelector('video[data-preview-video]');
   await page.waitForFunction(()=>Number(document.querySelector<HTMLInputElement>('#slider')?.value)>35);
   const decoded=await frame.locator('video').evaluate(v=>(v as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames);
   expect(decoded).toBeGreaterThan(10);expect(pictures.length).toBeLessThan(3);
   await page.locator('#play').click();
   const n=await page.locator('#slider').inputValue();await page.waitForSelector('body[data-applied="'+n+'"]');
   expect(await frame.locator('video').evaluate(v=>(v as HTMLVideoElement).paused&&(v as HTMLElement).style.display==='none')).toBe(true);
   expect(await frame.locator('[data-segment="a"] > img').getAttribute('src')).toMatch(/\.png$/);
  }finally{await browser.close();await server.close();}
 });
});
