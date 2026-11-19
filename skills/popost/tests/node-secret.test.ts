import { EventEmitter } from 'node:events';
import type { ReadStream } from 'node:tty';
import { describe, expect, it } from 'vitest';
import { readTerminalSecret } from '../src/node-secret';

const terminal = () => {
  const stream = Object.assign(new EventEmitter(), {
    isTTY: true, isRaw: false, readableFlowing: null as boolean | null,
    setRawMode(raw: boolean) { this.isRaw = raw; },
    resume() { this.readableFlowing = true; },
    pause() { this.readableFlowing = false; },
  });
  return { stream, input: stream as unknown as ReadStream };
};

describe('private terminal input lifecycle', () => {
  it('returns the pasted key without echo and pauses an initially idle stream so the CLI can exit', async () => {
    const { stream, input } = terminal();
    const output: string[] = [];
    const key = 'private-input-placeholder';
    const pending = readTerminalSecret(input, text => output.push(text));
    expect(stream.isRaw).toBe(true);
    stream.emit('data', Buffer.from(`${key}\r`));
    expect(await pending).toBe(key);
    expect(output.join('')).not.toContain(key);
    expect(stream.isRaw).toBe(false);
    expect(stream.readableFlowing).toBe(false);
    expect(stream.listenerCount('data')).toBe(0);
  });
  it('cancels, restores raw mode and removes listeners without exposing partial input', async () => {
    const { stream, input } = terminal();
    const output: string[] = [];
    const pending = readTerminalSecret(input, text => output.push(text));
    stream.emit('data', Buffer.from('partial-secret\x03'));
    await expect(pending).rejects.toThrow('cancelled');
    expect(output.join('')).not.toContain('partial-secret');
    expect(stream.isRaw).toBe(false);
    expect(stream.readableFlowing).toBe(false);
    expect(stream.listenerCount('end')).toBe(0);
    expect(stream.listenerCount('error')).toBe(0);
  });
});
