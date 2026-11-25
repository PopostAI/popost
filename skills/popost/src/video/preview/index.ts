/**
 * The preview debugger: a local page that shows any frame of a project, its timeline, and how a render compares with
 * a reference video and with the measurements. Read-only, unless started with --edit (edit/). See README.md here.
 */
import type { Runtime } from '../../runtime';
import { PreviewInputError, startPreview, type PreviewOptions, type PreviewServer } from './server';

export { PreviewInputError, startPreview, type PreviewOptions, type PreviewServer };

export interface PreviewCommandArgs { projectDir: string; reference?: string; measure?: string; referenceMeasure?: string; port?: number; edit?: boolean; cloud?: boolean }

/** The port the command tries first when none is given; a busy port falls back to any free one. */
export const DEFAULT_PORT = 4317;

const isAddressInUse = (e: unknown): boolean => typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'EADDRINUSE';

/** Starts the preview on the port asked for, or on DEFAULT_PORT (any free port when that one is taken). */
export const openPreview = async (rt: Runtime, args: PreviewCommandArgs): Promise<PreviewServer> => {
  const opts: PreviewOptions = { ...args, port: args.port ?? DEFAULT_PORT };
  try {
    return await startPreview(rt, opts);
  } catch (e) {
    if (!isAddressInUse(e)) throw e;
    if (args.port !== undefined) throw new PreviewInputError('preview: port ' + args.port + ' is in use. Pass --port with another number, or --port 0 for any free port.');
    return startPreview(rt, { ...opts, port: 0 });
  }
};
