import { describe, expect, it, vi } from 'vitest';
import { closeOwnedBrowser } from '../../src/render/browser';
import { browserStep, BrowserStepTimeoutError } from '../../src/video/render/browser-step';
import type { Browser } from 'playwright-core';
import { createTestRuntime, runCli } from '../../src/testing/memory';
import { nodePrograms } from '../../src/node-runtime';

describe('owned render browser lifecycle', () => {
  it('forces a stopped owned process to exit, but preserves a successful graceful shutdown', async () => {
    const stopped = { close: vi.fn(() => new Promise<void>(() => undefined)), kill: vi.fn(async () => undefined) };
    await closeOwnedBrowser(stopped, 5);
    expect(stopped.kill).toHaveBeenCalledOnce();
    const healthy = { close: vi.fn(async () => undefined), kill: vi.fn(async () => undefined) };
    await closeOwnedBrowser(healthy, 5);
    expect(healthy.close).toHaveBeenCalledOnce();
    expect(healthy.kill).not.toHaveBeenCalled();
  });
  it('bounds a stuck protocol call with its stage and preserves ordinary project errors', async () => {
    await expect(browserStep('painting frame 15', () => new Promise<void>(() => undefined), 5)).rejects.toBeInstanceOf(BrowserStepTimeoutError);
    await expect(browserStep('setting frame 0', () => new Promise<void>(() => undefined), 5)).rejects.toThrow('setting frame 0');
    const problem = new Error('Missing scene image');
    await expect(browserStep('preparing', async () => { throw problem; }, 5)).rejects.toBe(problem);
    expect(await browserStep('ready', async () => 42, 5)).toBe(42);
  });
  it('returns a structured CLI failure and closes the browser when preparation stops responding', async () => {
    const browser = { newContext: vi.fn(() => new Promise<never>(() => undefined)), close: vi.fn(async () => undefined) };
    // A solid scene needs no local program, but drawing still requires a host with that capability.
    const rt = createTestRuntime({ programs: nodePrograms, launchBrowser: async () => browser as unknown as Browser });
    // Let the CLI's lazy command import finish on the real event loop before advancing the protocol deadline.
    expect((await runCli(rt, ['video', '--help'])).code).toBe(0);
    vi.useFakeTimers();
    try {
      await rt.fs.writeFile('/work/clip/video.json', JSON.stringify({ version: 1, canvas: { width: 20, height: 20, fps: 30 }, materials: [], tracks: [], segments: [{ id: 'a', frames: 1, base: { color: '#ff0000' } }] }));
      const run = runCli(rt, ['video', 'frame', '/work/clip', '--frame', '0', '--out', '/work/f.png']);
      await vi.waitFor(() => expect(browser.newContext).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(30_001);
      expect((await run).code).toBe(2);
      expect(rt.json()).toMatchObject({ ok: false, error: expect.stringContaining('creating the render context') });
      expect(browser.close).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});
