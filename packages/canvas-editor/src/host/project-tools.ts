import { projectIdFromFile } from '../storage/browser-store';
import { hasHostWindow } from './messaging';
import { rawQuery, readParams } from './params';
import { requestFromHost, type StoreOp } from './store-rpc';

export const hostProject = (): string | null => {
  const params = readParams();
  const enabled = new URLSearchParams(rawQuery()).get('tools') === '1';
  return enabled && params.store === 'host' && hasHostWindow() ? projectIdFromFile(params.file) || null : null;
};

export const projectRequest = <T>(op: StoreOp, content?: unknown, timeout?: number): Promise<T> => {
  const id = hostProject();
  if (!id) return Promise.reject(new Error('Project host unavailable'));
  return requestFromHost<T>(id, op, { content }, timeout);
};

export interface ProjectImage {
  readonly src: string;
  readonly name: string;
  readonly width?: number;
  readonly height?: number;
  readonly pageKey?: string;
}
