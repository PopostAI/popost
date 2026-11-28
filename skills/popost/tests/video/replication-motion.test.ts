import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, hasChrome } from '../../src/testing/disk';
import { PACKAGE_ROOT } from '../../src/testing/memory';
import { hasFfmpeg } from '../../src/video/media/ffmpeg';
import { openRenderer, type Renderer } from '../../src/video/render/index';
import type { Project } from '../../src/video/types';
import { compileTyping, keyframeAt, layoutConflicts, odometerAt, sceneClock, typingAt, viewportBox, viewportPoint, viewportUnderline } from '../../src/video/replication/motion';
import { decodePng, isNear, pixelAt, projectDir } from './make-fixtures';

describe('replication motion: pure frame contracts', () => {
  it('reveals complete graphemes at their measured stops, preserves a pause, and seeks backwards', () => {
    const plan = compileTyping({ text: 'A👩🏽‍💻e\u0301', start: 10, end: 20, pauses: [{ after: 1, frames: 4 }], cursorStops: [[0, 0], [8, 0], [26, 0], [35, 0]] });
    expect(plan.graphemes).toEqual(['A', '👩🏽‍💻', 'e\u0301']);
    expect(plan.reveals).toEqual([12, 18, 20]);
    expect(typingAt(plan, 11).text).toBe('');
    expect(typingAt(plan, 12)).toMatchObject({ text: 'A', cursor: { x: 8, y: 0 } });
    expect(typingAt(plan, 17).text).toBe('A');
    expect(typingAt(plan, 18).text).toBe('A👩🏽‍💻');
    expect(typingAt(plan, 20)).toMatchObject({ text: 'A👩🏽‍💻e\u0301', done: true, cursor: { x: 35 } });
    expect(typingAt(JSON.parse(JSON.stringify(plan)) as typeof plan, 13)).toEqual(typingAt(plan, 13));
  });

  it('uses actual advances and line breaks, with deterministic cursor holds and blink', () => {
    const plan = compileTyping({ text: 'Wi\nM', start: 0, frames: 8, advances: [12, 3, 0, 14], origin: [20, 30], lineHeight: 24, blinkFrames: 2, hideWhenDone: true });
    expect(typingAt(plan, 2).cursor).toEqual({ x: 32, y: 30, visible: false });
    expect(typingAt(plan, 4).cursor).toEqual({ x: 35, y: 30, visible: true });
    expect(typingAt(plan, 6).cursor).toEqual({ x: 20, y: 54, visible: false });
    expect(typingAt(plan, 8).cursor).toEqual({ x: 34, y: 54, visible: false });
    expect(() => compileTyping({ text: 'X', start: 0, end: 2, frames: 2, advances: [8] })).toThrow('exactly one');
    expect(() => compileTyping({ text: 'X', start: 0, frames: 2, advances: [] })).toThrow('measured advance');
    expect(() => compileTyping({ text: 'X', start: 0, end: 2, pauses: [{ after: 0, frames: 3 }], advances: [8] })).toThrow('active typing');
  });

  it('rolls each place independently with a carry and a fractional offset, rather than interpolating one number', () => {
    const spec = { from: 1999, to: 2000, start: 10, frames: 8, stagger: 2 };
    const early = odometerAt(spec, 12);
    expect(early.columns.map((c) => c.offset)).toEqual([0, 0, 0, .25]);
    expect(early.columns.at(-1)).toMatchObject({ current: 9, next: 0, direction: 1 });
    expect(early.columns[0]).toMatchObject({ current: 1, next: 2 });
    const final = odometerAt(spec, 24);
    expect(final.done).toBe(true);
    expect(final.columns.map((c) => c.current).join('')).toBe('2000');
    expect(final.columns.every((c) => c.offset === 0 && c.next === c.current)).toBe(true);
    const down = odometerAt({ from: 100, to: 99, start: 0, frames: 4 }, 2);
    expect(down.columns[2]).toMatchObject({ current: 0, next: 9, offset: .5, direction: -1 });
    expect(odometerAt({ from: 10, to: 10, start: 0, frames: 4, turns: 1 }, 1).columns[0]?.offset).toBe(.5);
    expect(() => odometerAt({ from: 999, to: 1000, places: 3, start: 0, frames: 4 }, 0)).toThrow('places');
  });

  it('maps segment-local time to a declared source clock and holds early exposure at zero', () => {
    const clock = { fps: 30, sourceFps: 24, sourceStart: 48, sourceFrames: 120 };
    expect(sceneClock(-.1, clock)).toEqual({ localFrame: 0, sourceFrame: 48 });
    expect(sceneClock(.5, clock)).toEqual({ localFrame: 15, sourceFrame: 60 });
    expect(sceneClock(100, clock)).toEqual({ localFrame: 3000, sourceFrame: 119 });
    expect(() => sceneClock(0, { fps: 0, sourceStart: 0 })).toThrow('Frame rates');
  });

  it('interpolates camera/target vectors, holds explicit states, and rejects ambiguous key times', () => {
    const keys = [{ frame: 10, value: [0, 2, 4], hold: true }, { frame: 20, value: [10, 4, 8] }, { frame: 30, value: [20, 6, 12] }];
    expect(keyframeAt(keys, 19)).toEqual([0, 2, 4]);
    expect(keyframeAt(keys, 20)).toEqual([10, 4, 8]);
    expect(keyframeAt(keys, 25)).toEqual([15, 5, 10]);
    expect(keyframeAt(keys, -1)).toEqual([0, 2, 4]);
    expect(keyframeAt(keys, 99)).toEqual([20, 6, 12]);
    expect(() => keyframeAt([{ frame: 1, value: [0] }, { frame: 1, value: [2] }], 1)).toThrow('strictly increasing');
    expect(() => keyframeAt([{ frame: 0, value: [0] }, { frame: 2, value: [2, 3] }], 1)).toThrow('dimensions');
  });

  it('keeps marks and content in one affine viewport, including rotation, and flags label collisions', () => {
    const transform = [0, 2, -2, 0, 100, 10] as const;
    expect(viewportPoint([5, 6], transform)).toEqual([88, 20]);
    expect(viewportBox([5, 6, 10, 4], transform)).toEqual([80, 20, 8, 20]);
    expect(viewportUnderline([5, 6, 10, 4], transform, 1)).toEqual([[78, 20], [78, 40]]);
    expect(layoutConflicts([{ id: 'number', box: [0, 0, 80, 30] }, { id: 'label', box: [70, 0, 40, 30] }])).toEqual([{ a: 'number', b: 'label' }]);
    expect(layoutConflicts([{ id: 'number', box: [0, 0, 80, 30] }, { id: 'label', box: [90, 0, 40, 30] }], 8)).toEqual([]);
  });
});

const rt = await createDiskRuntime();
afterAll(async () => { await rt.cleanup(); });
const ready = hasChrome() && await hasFfmpeg(rt);

describe.skipIf(!ready)('replication motion: actual scene frames', () => {
  let dir = '';
  let renderer: Renderer;
  beforeAll(async () => {
    // Build only this tiny test fixture in memory; no checked-in media or production bundle is touched.
    const result = await build({ stdin: { contents: "export * from './src/video/replication/motion';", resolveDir: PACKAGE_ROOT, loader: 'ts' }, bundle: true, write: false, format: 'iife', globalName: 'M', platform: 'browser' });
    const code = result.outputFiles[0]?.text ?? '';
    expect(code).toContain('compileTyping');
    const html = '<!doctype html><html><head><style>html,body{margin:0;width:320px;height:180px;overflow:hidden}canvas{display:block}</style></head><body><canvas id="c" width="320" height="180"></canvas><script>' + code + `
      const g=document.getElementById('c').getContext('2d');g.font='20px monospace';
      const text='HELLO',stops=Array.from({length:text.length+1},(_,i)=>[20+g.measureText(text.slice(0,i)).width,22]);
      const plan=M.compileTyping({text,start:90,frames:20,cursorStops:stops,blinkFrames:1000});
      window.__popostScene={render(t,fps){
        const clock=M.sceneClock(t,{fps,sourceStart:90}),n=clock.sourceFrame;
        g.setTransform(1,0,0,1,0,0);g.fillStyle='#102040';g.fillRect(0,0,320,180);
        g.font='20px monospace';g.textBaseline='top';const typed=M.typingAt(plan,n);
        g.fillStyle='#fff';g.fillText(typed.text,20,22);g.fillStyle='#ff0000';if(typed.cursor.visible)g.fillRect(typed.cursor.x,typed.cursor.y,3,22);
        const columns=M.odometerAt({from:1999,to:2000,start:90,frames:20,stagger:2},n).columns;
        columns.forEach((d,i)=>{g.save();g.beginPath();g.rect(20+i*16,64,16,24);g.clip();g.fillStyle='#fff';const shift=d.offset*24*d.direction;g.fillText(String(d.current),20+i*16,64-shift);g.fillText(String(d.next),20+i*16,64-shift+24*d.direction);g.restore()});
        const labelWidth=g.measureText('items').width;
        const good=M.layoutConflicts([{id:'number',box:[20,64,64,24]},{id:'label',box:[96,64,labelWidth,24]}],8);
        const bad=M.layoutConflicts([{id:'number',box:[20,64,64,24]},{id:'label',box:[50,64,labelWidth,24]}]);
        g.fillStyle='#00ff00';g.fillText('items',96,64);g.fillStyle=!good.length&&bad.length===1?'#00ff00':'#ff0000';g.fillRect(280,65,10,10);
        const view=M.keyframeAt([{frame:90,value:[1,0,0,1,0,0]},{frame:150,value:[1.25,0,0,1.25,20,-15]}],n);
        g.setTransform(...view);g.fillStyle='#0000ff';g.fillRect(40,110,70,25);g.setTransform(1,0,0,1,0,0);
        const b=M.viewportBox([40,110,70,25],view);g.strokeStyle='#ffff00';g.lineWidth=2;g.strokeRect(...b);
        const line=M.viewportUnderline([40,110,70,25],view,4);g.strokeStyle='#00ffff';g.beginPath();g.moveTo(...line[0]);g.lineTo(...line[1]);g.stroke();
      }};
    </script></body></html>`;
    const project: Project = { version: 1, canvas: { width: 320, height: 180, fps: 30 }, materials: [], tracks: [], segments: [{ id: 'lead', frames: 30, base: { color: '#400000' } }, { id: 'type', frames: 60, base: { scene: 'scenes/test.html' }, in: { transition: 'dissolve', frames: 6 } }] };
    dir = await projectDir('replication-motion-', project);
    await mkdir(path.join(dir, 'scenes'));
    await writeFile(path.join(dir, 'scenes', 'test.html'), html);
    renderer = await openRenderer(rt, dir);
  });
  afterAll(async () => { await renderer?.close(); if (dir) await rm(dir, { recursive: true, force: true }); });

  it('shows actual growing ink and moving cursor, not a full sentence at the first frame or an offset clock', async () => {
    const count = async (n: number): Promise<{ white: number; redX: number }> => {
      const image = await decodePng(await renderer.frame(n));
      let white = 0, redX = 320;
      for (let y = 20; y < 48; y++) for (let x = 18; x < 110; x++) {
        const c = pixelAt(image, x, y);
        if (Math.min(...c) > 210) white++;
        if (isNear(c, [255, 0, 0], 30)) redX = Math.min(redX, x);
      }
      return { white, redX };
    };
    const early = await count(29), first = await count(34), full = await count(54);
    expect(early.white, 'transition exposure must hold the empty initial typing state').toBe(0);
    expect(first.white).toBeGreaterThan(10);
    expect(full.white, 'more glyphs must actually be painted').toBeGreaterThan(first.white * 2);
    expect(full.redX).toBeGreaterThan(first.redX + 30);
    const a = await renderer.frame(34); await renderer.frame(75);
    expect((await renderer.frame(34)).equals(a), 'seeking back must not retain later text').toBe(true);
  });

  it('uses real measured number/label bounds and keeps a moving underline attached', async () => {
    for (const n of [34, 54]) {
      const image = await decodePng(await renderer.frame(n));
      expect(pixelAt(image, 284, 69)).toSatisfy((c: number[]) => isNear(c, [0, 255, 0]));
      const view = keyframeAt([{ frame: 90, value: [1, 0, 0, 1, 0, 0] }, { frame: 150, value: [1.25, 0, 0, 1.25, 20, -15] }], sceneClock((n - 30) / 30, { fps: 30, sourceStart: 90 }).sourceFrame);
      const b = viewportBox([40, 110, 70, 25], view as [number, number, number, number, number, number]);
      const line = viewportUnderline([40, 110, 70, 25], view as [number, number, number, number, number, number], 4);
      expect(pixelAt(image, Math.round(b[0] + b[2] / 2), Math.round(b[1] + b[3] / 2))).toSatisfy((c: number[]) => isNear(c, [0, 0, 255]));
      expect(pixelAt(image, Math.round((line[0][0] + line[1][0]) / 2), Math.round(line[0][1]))).toSatisfy((c: number[]) => isNear(c, [0, 255, 255], 70));
    }
  });
});
