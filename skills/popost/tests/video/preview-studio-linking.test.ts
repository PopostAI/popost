import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findChromium } from '../../src/render/browser';
import { createDiskRuntime } from '../../src/testing/disk';
import { startPreview, type PreviewServer } from '../../src/video/preview/index';
import { serverProcesses } from './make-fixtures';
import type { CloudStatus } from '../../src/cloud/service';

const rt=await createDiskRuntime({processes:serverProcesses});
const chrome=findChromium(process.env)??undefined;
afterAll(()=>rt.cleanup());

describe.skipIf(!chrome)('Studio linked selection and cloud controls (Chrome)',()=>{
 let browser:Browser,preview:PreviewServer,page:Page;
 const errors:string[]=[];
 const jump=async(frame:number):Promise<void>=>{await page.locator('#jump').fill(String(frame));await page.locator('#jump').press('Enter');await page.waitForSelector('body[data-applied="'+frame+'"]');};
 const pinned=async():Promise<unknown>=>JSON.parse(await page.locator('#lanes .blk.selected').first().getAttribute('data-sel')??'null');
 beforeAll(async()=>{
  await writeFile(path.join(rt.dir,'scene.html'),'<!doctype html><html><head><style>html,body{margin:0;width:320px;height:200px}h1{position:absolute;top:40px}</style></head><body><h1 data-slot="title">Late title</h1><p data-slot="dormant" style="display:none">Dormant phase</p><script>window.__popostScene={render:function(s){document.querySelector("h1").style.opacity=s<2?"0":"1";}};</script></body></html>');
  await writeFile(path.join(rt.dir,'video.json'),JSON.stringify({version:1,canvas:{width:320,height:200,fps:30},materials:[],segments:[{id:'scene',frames:120,base:{scene:'scene.html'}}],tracks:[{id:'late',type:'text',text:'Late overlay',box:[.1,.7,.8,.15],during:{segment:'scene',from:75,to:110}},{id:'captions',type:'caption',box:[.1,.85,.8,.1],cues:[{text:'First caption',during:{segment:'scene',from:5,to:30}},{text:'Later caption',during:{segment:'scene',from:90,to:120}}]}]}));
  preview=await startPreview(rt,{projectDir:rt.dir,edit:true});expect((await (await fetch(preview.url+'api/state')).json() as {problems:unknown[]}).problems).toEqual([]);browser=await chromium.launch({executablePath:chrome,headless:true});page=await browser.newPage({viewport:{width:1280,height:720},locale:'en-US'});page.on('pageerror',e=>errors.push(e.message));await page.goto(preview.url);await page.waitForSelector('body[data-ready="1"]');
 });
 afterAll(async()=>{await browser?.close();await preview?.close();});
 it('collapses an empty inspector and reveals late elements across preview, timeline and properties',async()=>{
  expect(await page.locator('#panel').isVisible()).toBe(false);
  await page.locator('[data-panel="elements"]').click();await page.locator('#studio-content').getByRole('button',{name:'Late overlay',exact:true}).click();
  await expect.poll(()=>page.locator('#frame-no').textContent()).not.toBe('0');
  await page.locator('#sel-box:visible').waitFor();expect(await pinned()).toEqual({kind:'item',id:'late'});expect(await page.locator('#edit-form textarea').first().inputValue()).toBe('Late overlay');
  await page.keyboard.press('Escape');expect(await page.locator('#panel').isVisible()).toBe(false);
  await jump(0);expect(await page.getByRole('button',{name:'Dormant phase',exact:true}).count()).toBe(0);await page.getByRole('button',{name:'Late title',exact:true}).click();
  await page.locator('.studio-slot-outline:visible').waitFor();expect(await pinned()).toEqual({kind:'segment',id:'scene'});expect(await page.locator('#slot-inspector textarea').inputValue()).toBe('Late title');
  expect(Number(await page.locator('#frame-no').textContent())).toBeGreaterThanOrEqual(60);
  await page.reload();await page.locator('.studio-slot-outline:visible').waitFor();
 });
 it('selects a subtitle from its text field, keeps focus and links back from the timeline',async()=>{
  await page.locator('[data-panel="script"]').click();const later=page.getByRole('textbox',{name:'Subtitles 2',exact:true});await later.click();
  expect(await later.evaluate(el=>document.activeElement===el)).toBe(true);expect(await pinned()).toEqual({kind:'item',id:'captions#1'});await page.locator('#sel-box:visible').waitFor();
  expect(await page.locator('#edit-form textarea').first().inputValue()).toBe('Later caption');expect(await page.locator('.studio-sentence.selected textarea').inputValue()).toBe('Later caption');
  await page.locator('.caption-lane .blk').first().click();expect(await page.locator('.studio-sentence.selected textarea').inputValue()).toBe('First caption');expect(await page.locator('#edit-form textarea').first().inputValue()).toBe('First caption');expect(errors).toEqual([]);
 });
 it('matches anonymous authorization, blocked-popup copying, retained-ticket retry and saved links',async()=>{
  let status:CloudStatus={ok:true,mode:'anonymous',state:'idle',dirty:true};let starts=0,pushes=0;
  await page.route('**/api/cloud/status',route=>route.fulfill({json:status}));
  await page.route('**/api/studio/cloud/start',route=>{starts++;status={...status,state:'waiting'};return route.fulfill({json:{ok:true,result:{authorizeUrl:'https://popost.ai/en/workspace/cloud-save?v=1'}}});});
  await page.route('**/api/studio/cloud/push',route=>{pushes++;status={ok:true,mode:'anonymous',state:'saved',dirty:false,webUrl:'https://popost.ai/en/workspace/projects/video'};return route.fulfill({json:{ok:true,result:status}});});
  await page.reload();await page.waitForSelector('body[data-ready="1"]');
  await page.evaluate(()=>{window.open=()=>null;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('Clipboard blocked');}}});});
  await page.locator('#studio-cloud-save').click();await page.getByRole('button',{name:'Copy link',exact:true}).waitFor();await page.getByRole('button',{name:'Copy link',exact:true}).click();
  const login=page.getByRole('textbox',{name:'Login link'});expect(await login.inputValue()).toContain('/workspace/cloud-save');await login.focus();await page.waitForTimeout(2200);expect(await login.evaluate(el=>document.activeElement===el)).toBe(true);
  status={...status,state:'failed',error:{code:'NETWORK',message:'offline'}};await page.getByRole('button',{name:'Retry',exact:true}).waitFor();await page.getByRole('button',{name:'Retry',exact:true}).click();
  await page.locator('#studio-cloud a').waitFor();expect(starts).toBe(1);expect(pushes).toBe(1);expect(await page.locator('#studio-cloud').textContent()).toContain('Saved to cloud');
 });
 it('offers keyed conflict overwrite and blocks an upload with invalid local JSON',async()=>{
  let status:CloudStatus={ok:true,mode:'keyed',state:'conflict',dirty:true,webUrl:'https://popost.ai/en/workspace/projects/video'};const forces:boolean[]=[];
  await page.route('**/api/cloud/status',route=>route.fulfill({json:status}));
  await page.route('**/api/studio/cloud/push',async route=>{forces.push((route.request().postDataJSON() as {force:boolean}).force);status={...status,state:'saved',dirty:false};await route.fulfill({json:{ok:true,result:status}});});
  await page.reload();await page.getByRole('button',{name:'Overwrite',exact:true}).click();await page.locator('#studio-cloud a').waitFor();expect(forces).toEqual([true]);
  status={ok:true,mode:'anonymous',state:'idle',dirty:true};await page.reload();await page.locator('[data-panel="code"]').click();await page.locator('#studio-json').fill('{ invalid');await page.locator('#studio-cloud-save').click();
  await expect.poll(()=>page.locator('#studio-cloud').textContent()).toContain('Could not save local edits');expect(forces).toEqual([true]);
  await page.locator('#studio-json').fill('{}');await page.getByRole('button',{name:'Reload JSON',exact:true}).click();expect(errors).toEqual([]);
 });
 it('restarts expired authorization, flushes the focused caption, and honors cloud off',async()=>{
  let status:CloudStatus={ok:true,mode:'anonymous',state:'failed',dirty:true,error:{code:'UNAUTHORIZED',message:'expired'}};let startedSource='';
  await page.route('**/api/cloud/status',route=>route.fulfill({json:status}));
  await page.route('**/api/studio/cloud/start',async route=>{startedSource=JSON.stringify(await (await page.request.get(preview.url+'api/state')).json());status={ok:true,mode:'anonymous',state:'waiting',dirty:true};await route.fulfill({json:{ok:true,result:{authorizeUrl:'https://popost.ai/en/workspace/cloud-save?v=1'}}});});
  await page.reload();await page.locator('[data-panel="script"]').click();await page.evaluate(()=>{window.open=()=>null;});
  const caption=page.getByRole('textbox',{name:'Subtitles 2',exact:true});await caption.fill('Latest focused caption');await page.getByRole('button',{name:'Retry',exact:true}).click();
  await page.getByRole('button',{name:'Copy link',exact:true}).waitFor();expect(startedSource).toContain('Latest focused caption');
  status={ok:true,mode:'off',state:'idle',dirty:true};await expect.poll(()=>page.locator('#studio-cloud').isVisible(),{timeout:5000}).toBe(false);
 });

});
