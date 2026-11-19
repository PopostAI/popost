import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { guardBrokenPipe } from '../src/broken-pipe';

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

describe('guardBrokenPipe', () => {
  it('ends quietly with the command exit code when the reader goes away (popost … | head)', () => {
    const stdout = new EventEmitter();
    const exits: number[] = [];
    const reports: string[] = [];
    guardBrokenPipe([stdout], { exit: (code) => void exits.push(code), exitCode: () => 0, report: (text) => void reports.push(text) });
    stdout.emit('error', errno('EPIPE'));
    expect(exits).toEqual([0]);
    expect(reports).toEqual([]);
  });

  it('reports any other stream error in one line and exits 1', () => {
    const stderr = new EventEmitter();
    const exits: number[] = [];
    const reports: string[] = [];
    guardBrokenPipe([stderr], { exit: (code) => void exits.push(code), exitCode: () => 0, report: (text) => void reports.push(text) });
    stderr.emit('error', errno('EIO'));
    expect(exits).toEqual([1]);
    expect(reports).toEqual(['popost: output stream failed (EIO)\n']);
  });
});
