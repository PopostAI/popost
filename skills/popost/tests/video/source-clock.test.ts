import { afterAll, describe, expect, it } from 'vitest';
import { sourceClockOf } from '../../src/video/replication/source-clock';
import { createDiskRuntime } from '../../src/testing/disk';
import { runCli } from '../../src/testing/memory';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { sha256 } from '../../src/core/util';

const crc = (pts: number[], durations = pts.map(() => 1), base = '1/60') => '#tb 0: '+base+'\n'+pts.map((p,i) => '0, '+p+', '+p+', '+durations[i]+', 1, 0x0').join('\n');
describe('actual decoded presentation clock', () => {
  it('keeps an ordinary CFR source unchanged', () => {
    const c = sourceClockOf(crc([0,1,2]), { fps: 60, frames: 3 });
    expect(c.nonUniform).toBe(false); expect(c.frames.map(x=>x.normalizedFrame)).toEqual([0,1,2]);
  });
  it('maps a varying/held source through actual PTS instead of dividing its index by average FPS', () => {
    const c = sourceClockOf(crc([0,1,2,9], [1,1,7,2]), { fps: 30, frames: 4 });
    expect(c.nonUniform).toBe(true); expect(c.frames.map(x=>x.normalizedFrame)).toEqual([0,1,1,5]);
    expect(c.frames[3]!.ptsSeconds).toBeCloseTo(.15); expect(c.frames[3]!.ptsSeconds).not.toBeCloseTo(3/30,5);
  });
  it('flags a changed average even when most decoded intervals remain nominally CFR', () => {
    expect(sourceClockOf(crc([0,1,2]), { fps: 58.29, frames: 3 }).nonUniform).toBe(true);
  });
  it('preserves the raw origin while exposing the relative playback clock', () => {
    const c = sourceClockOf(crc([600,601,602]), { fps: 60, frames: 3 });
    expect(c.originPTSSeconds).toBe(10); expect(c.frames[0]).toMatchObject({ rawPtsSeconds:10, ptsSeconds:0, normalizedFrame:0 });
  });
  it('rejects reordered packet timestamps and an unbound frame count', () => {
    expect(()=>sourceClockOf(crc([0,2,1]), { fps:60, frames:3 })).toThrow('presentation');
    expect(()=>sourceClockOf(crc([0,1]), { fps:60, frames:3 })).toThrow('frame count');
  });
  it('rejects missing time bases and invalid durations', () => {
    expect(()=>sourceClockOf('0,0,0,1', { fps:60, frames:1 })).toThrow('time base');
    expect(()=>sourceClockOf(crc([0],[0]), { fps:60, frames:1 })).toThrow('invalid');
  });
});
const rt = await createDiskRuntime({env:{POPOST_CPUS:'1'}}), available = await hasFfmpeg(rt);
afterAll(async()=>rt.cleanup());
describe.skipIf(!available)('bound source clock CLI', () => {
  it('decodes a B-frame MP4 in visible order and writes the actual mapping without changing source bytes', async () => {
    const dir=rt.dir+'/source-clock',file=dir+'/reference.mp4',out=dir+'/clock.json';await rt.fs.mkdir(dir);
    await runFfmpegOk(rt,['-y','-loglevel','error','-f','lavfi','-i','testsrc2=size=128x72:rate=24:duration=0.5','-c:v','libx264','-bf','2','-pix_fmt','yuv420p',file]);
    const hash=sha256(await rt.fs.readFile(file));
    await rt.fs.writeFile(dir+'/replication.json',JSON.stringify({format:'popost-video-replication',version:1,source:{fingerprint:hash,fps:24,frames:12},audio:{sourceSpeech:'absent',sourceRoles:[],narration:'forbid',evidence:[]},visual:{medium:'test pattern',style:['fixture'],evidence:[]},events:[]}));
    expect(await runCli(rt,['video','replication','clock',dir,'--reference',file,'--out',out])).toMatchObject({code:0});
    const c=JSON.parse(await rt.fs.readText(out));expect(c.frames).toHaveLength(12);expect(c.frames.map((f:{normalizedFrame:number})=>f.normalizedFrame)).toEqual(Array.from({length:12},(_,i)=>i));expect(c.nonUniform).toBe(false);expect(sha256(await rt.fs.readFile(file))).toBe(hash);
  });
});
