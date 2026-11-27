import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findChromium } from '../../src/render/browser';
import { createDiskRuntime } from '../../src/testing/disk';
import { startPreview, type PreviewServer } from '../../src/video/preview/index';
import { serverProcesses } from './make-fixtures';

const rt=await createDiskRuntime({processes:serverProcesses});
const chrome=findChromium(process.env)??undefined;
afterAll(()=>rt.cleanup());

describe.skipIf(!chrome)('Studio editing from the canvas and timeline (Chrome)',()=>{
  let browser:Browser,preview:PreviewServer,page:Page;
  const errors:string[]=[];
  const refusals:string[]=[];
  const source=async()=> (await (await page.request.get(preview.url+'api/state')).json()).source;
  const selected=async()=>JSON.parse(await page.locator('#lanes .blk.selected').first().getAttribute('data-sel')??'null');
  beforeAll(async()=>{
    for(const color of ['red','blue'])await writeFile(path.join(rt.dir,color+'.svg'),`<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><rect width="60" height="60" fill="${color}"/></svg>`);
    await writeFile(path.join(rt.dir,'video.json'),JSON.stringify({version:1,canvas:{width:640,height:360,fps:30},materials:[{id:'red',kind:'image',file:'red.svg'},{id:'blue',kind:'image',file:'blue.svg'}],
      segments:[{id:'one',frames:120,base:{color:'#eeeeee'}},{id:'two',frames:120,base:{color:'#ffffff'}}],
      tracks:[{id:'title',type:'text',text:'Edit this',box:[.1,.2,.55,.13],during:{segment:'one'},style:{size:.09,weight:700,letterSpacing:-.045}},
        {id:'picture',type:'image',material:'red',box:[.72,.15,.2,.4],during:{segment:'one'}},
        {id:'line',type:'shape',shape:'rect',color:'#123456',box:[.1,.8,.7,.01],during:{segment:'one',from:15},enter:{preset:'wipe',frames:78}}]}));
    preview=await startPreview(rt,{projectDir:rt.dir,edit:true});browser=await chromium.launch({executablePath:chrome,headless:true});
    page=await browser.newPage({viewport:{width:1280,height:720},locale:'en-US'});page.on('pageerror',e=>errors.push(e.message));
    page.on('response',async response=>{if(response.status()>=400&&/\/api\/(edit|source|undo)/.test(response.url()))refusals.push(await response.text());});
    await page.goto(preview.url);await page.locator('body[data-ready="1"]').waitFor();
  });
  afterAll(async()=>{await browser?.close();await preview?.close();});
  it('starts with a fitted shot overview and links a layer back to the sidebar, inspector and canvas',async()=>{
    expect(await page.locator('#timeline-layers').getAttribute('aria-pressed')).toBe('false');
    expect(await page.locator('.blk.item').count()).toBe(0);
    await page.locator('#timeline-layers').click();await page.locator('.blk.item').filter({hasText:'Edit this'}).click();
    expect(await selected()).toEqual({kind:'item',id:'title'});
    expect(await page.locator('[data-panel="elements"]').getAttribute('aria-pressed')).toBe('true');
    expect(await page.locator('#studio-content .studio-item.selected').textContent()).toBe('Edit this');
    await page.locator('#sel-box:visible').waitFor();expect(await page.locator('#edit-form textarea').inputValue()).toBe('Edit this');
  });
  it('enters inline editing on the first double-click and Escape cancels without saving',async()=>{
    await page.keyboard.press('Escape');
    const rect=await page.frameLocator('#page').locator('[data-item="title"]').boundingBox();expect(rect).not.toBeNull();
    await page.mouse.dblclick(rect!.x+rect!.width/2,rect!.y+rect!.height/2);
    const inline=page.locator('#stage-text-editor');await inline.waitFor();await inline.fill('Cancelled edit');await inline.press('Escape');
    expect(await inline.count()).toBe(0);expect((await source()).tracks[0].text).toBe('Edit this');
  });
  it('edits a long title on the canvas, fits it into its box, persists it and undoes text and size together',async()=>{
    const box=page.locator('#sel-box');await box.dblclick();
    const inline=page.locator('#stage-text-editor');await inline.waitFor();
    await inline.fill('Editing a video should feel as simple as editing a document.');await inline.press('Tab');
    await expect.poll(async()=> (await source()).tracks[0].text,{timeout:10000}).toBe('Editing a video should feel as simple as editing a document.');
    await page.locator('body[data-ready="1"]').waitFor();
    await expect.poll(()=>page.frameLocator('#page').locator('[data-item="title"]').textContent()).toContain('Editing a video');
    const fit=await page.frameLocator('#page').locator('[data-item="title"]').evaluate(el=>{const child=el.firstElementChild as HTMLElement;return {height:el.clientHeight,text:child.scrollHeight};});
    expect(fit.text).toBeLessThanOrEqual(fit.height+1);expect((await source()).tracks[0].style.size).toBeLessThan(.09);
    await page.locator('#edit-undo').click();await expect.poll(async()=> (await source()).tracks[0].text,{timeout:10000}).toBe('Edit this');
    expect((await source()).tracks[0].style.size).toBe(.09);
  });
  it('selects an image directly, replaces its source, and keeps selection after reloading',async()=>{
    await page.locator('.media-lane .blk.item').filter({hasText:'image'}).click();
    expect(await selected()).toEqual({kind:'item',id:'picture'});
    await page.locator('select[data-path="tracks[1].material"]').selectOption('blue');
    await expect.poll(async()=> (await source()).tracks[1].material,{timeout:10000}).toBe('blue');
    await page.reload();await page.locator('#sel-box:visible').waitFor();
    expect(await selected()).toEqual({kind:'item',id:'picture'});
    expect(await page.locator('select[data-path="tracks[1].material"]').inputValue()).toBe('blue');
  });
  it('shortens a shot to three seconds and can reorder, duplicate and undo the complete shot',async()=>{
    await page.locator('#lane-segments .blk.seg').first().click();
    await page.locator('input[data-path="segments[0].frames"]').fill('3');await page.locator('input[data-path="segments[0].frames"]').press('Tab');
    await expect.poll(async()=> (await source()).segments[0].frames,{timeout:10000}).toBe(90);
    expect((await source()).tracks[2].enter.frames).toBe(75);
    await page.locator('#scene-later').click();await expect.poll(async()=> (await source()).segments[0].id,{timeout:10000}).toBe('two');
    expect(await selected()).toEqual({kind:'segment',id:'one'});
    await expect.poll(async()=>Number(await page.locator('#frame-no').textContent()),{timeout:10000}).toBeGreaterThanOrEqual(120);
    expect(await page.locator('#studio-content .studio-shot.selected').textContent()).toContain('one');
    await page.locator('#edit-duplicate').click();await expect.poll(async()=> (await source()).segments.length,{timeout:10000}).toBe(3);
    expect((await source()).tracks).toHaveLength(6);
    await page.locator('#edit-undo').click();await expect.poll(async()=> (await source()).segments.length,{timeout:10000}).toBe(2);
    expect(refusals).toEqual([]);expect(errors).toEqual([]);
  });
  it('trims a timeline-wide audio bed from its handle and undoes the whole drag',async()=>{
    const wave=Buffer.alloc(44+16000*8);wave.write('RIFF');wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(8000,24);wave.writeUInt32LE(16000,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(wave.length-44,40);
    await writeFile(path.join(rt.dir,'bed.wav'),wave);
    const base=await source();const next={...base,materials:[...base.materials,{id:'bed',kind:'audio',file:'bed.wav'}],tracks:[...base.tracks,{id:'bed',type:'audio',material:'bed'}]};
    expect((await page.request.post(preview.url+'api/source',{data:{source:next,base}})).ok()).toBe(true);
    const audio=page.locator('#lane-audio-bed .blk.audio');await audio.click();
    expect(await selected()).toEqual({kind:'audio',id:'bed'});
    await page.locator('#timeline-snapping').click();
    const grip=await page.locator('#lane-audio-bed .grip.end').boundingBox();expect(grip).not.toBeNull();
    const lane=await page.locator('#lane-audio-bed .lane-track').boundingBox();
    const frames=(await (await page.request.get(preview.url+'api/state')).json()).resolved.frames;
    await page.mouse.move(grip!.x+grip!.width/2,grip!.y+grip!.height/2);await page.mouse.down();
    await page.mouse.move(grip!.x+grip!.width/2-30*lane!.width/frames,grip!.y+grip!.height/2,{steps:8});await page.mouse.up();
    await expect.poll(async()=> (await source()).tracks.at(-1).during?.to,{timeout:10000}).toBe(frames-30);
    await page.locator('#edit-undo').click();await expect.poll(async()=> (await source()).tracks.at(-1).during,{timeout:10000}).toBeUndefined();
    expect(refusals).toEqual([]);expect(errors).toEqual([]);
  });
});
