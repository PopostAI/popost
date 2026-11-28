import { describe, expect, it } from 'vitest';
import type { AudioTrack, Resolved } from '../../src/video/types';
import { voiceSpanProblems } from '../../src/video/replication/voice-spans';

const track = (lines?: [number, number][]): AudioTrack => ({ id: 'speaker', type: 'audio', material: 'voice', role: 'voice', ...(lines ? { lines } : {}) });
const resolved = (start = 90, end: number | undefined = 110): Pick<Resolved, 'audio' | 'frames'> => ({ frames: 200,
  audio: [{ id: 'speaker', src: 'assets/voice.wav', start, ...(end === undefined ? {} : { end }), gain: 0 }],
});
describe('strict voice intervals on a displaced audio track', () => {
  it('rejects global timeline coordinates that would silently remove the declared speech', () => {
    const found = voiceSpanProblems({ tracks: [track([[90, 110]])] }, resolved());
    expect(found).toHaveLength(1);
    expect(found[0]?.fix).toContain('relative to this audio track');
  });
  it('keeps speech unchanged when the track moves on the timeline', () => {
    const project = { tracks: [track([[0, 8], [12, 20]])] };
    expect(voiceSpanProblems(project, resolved())).toEqual([]);
    expect(voiceSpanProblems(project, resolved(150, 170))).toEqual([]);
  });
  it('keeps a partially trimmed closing line while rejecting a wholly unheard line', () => {
    expect(voiceSpanProblems({ tracks: [track([[8, 24]])] }, resolved())).toEqual([]);
    expect(voiceSpanProblems({ tracks: [track([[20, 24]])] }, resolved())).toHaveLength(1);
  });
  it('requires actual intervals and a resolved voice route', () => {
    expect(voiceSpanProblems({ tracks: [track()] }, resolved())).toHaveLength(1);
    expect(voiceSpanProblems({ tracks: [track([[0, 20]])] }, { frames: 200, audio: [] })).toHaveLength(1);
  });
  it('rejects negative and reversed local spans', () => {
    expect(voiceSpanProblems({ tracks: [track([[-2, 5], [9, 3]])] }, resolved())).toHaveLength(2);
  });
  it('preserves a full-length mixed narration and leaves music metadata alone', () => {
    expect(voiceSpanProblems({ tracks: [track([[0, 50], [70, 190]])] }, resolved(0, undefined))).toEqual([]);
    expect(voiceSpanProblems({ tracks: [{ ...track(), role: 'music' }] }, resolved())).toEqual([]);
  });
});
