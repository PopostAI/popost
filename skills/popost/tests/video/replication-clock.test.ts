import { describe, expect, it } from 'vitest';
import { packetClock } from '../../src/video/media/ffmpeg';

describe('source packet clock', () => {
  it('keeps constant and fractional rates, independent of packet decode order', () => {
    const crc = '#tb 0: 1/30000\n0, -2002, 0, 1001, 20, 0x1\n0, -1001, 2002, 1001, 20, 0x2\n0, 0, 1001, 1001, 20, 0x3\n';
    expect(packetClock(crc).frames).toBe(3);
    expect(packetClock(crc).duration).toBeCloseTo(.1001, 12);
    expect(packetClock(crc).fps).toBeCloseTo(3 / .1001, 10);
  });
  it('uses presentation duration for variable rates instead of frames divided by nominal fps', () => {
    const crc = '#tb 0: 1/1000\n0, 0, 0, 20, 1, 0x1\n0, 20, 20, 40, 1, 0x2\n0, 60, 60, 20, 1, 0x3\n';
    expect(packetClock(crc)).toEqual({ frames: 3, duration: .08, fps: 37.5 });
  });
  it('does not infer a duration from an absent timebase or incomplete packet timestamps', () => {
    expect(packetClock('0, 0, 0, 20, 1, 0x1\n')).toEqual({ frames: 1 });
    expect(packetClock('#tb 0: 1/1000\n0, 0, N/A, 0, 1, 0x1\n')).toEqual({ frames: 1 });
  });
});
