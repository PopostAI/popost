import type { Runtime } from '../../runtime';
import { PopostClient } from '../../providers/api';

export interface ExportAccess { premium: boolean; verified: boolean; pricingUrl?: string }
export interface VideoExportSettings {
  name: string; resolution: 'original' | '480' | '720' | '1080' | '1440' | '2160';
  dynamicRange: 'sdr'; fps: number | null; bitrate: number | null; audio: boolean; from?: number; to?: number;
}
export const exportAccess = async (rt: Runtime): Promise<ExportAccess> => {
  let pricingUrl: string | undefined;
  try {
    const client = new PopostClient(rt);
    pricingUrl = new URL('/zh/pricing',client.baseUrl).href;
    const account = await client.request('GET', '/me', { timeoutSec: 5 }) as { tier?: string; plan?: { tier?: string }; user?: { tier?: string } };
    const tier = account.tier ?? account.plan?.tier ?? account.user?.tier;
    return { pricingUrl, premium: typeof tier === 'string' && ['basic', 'standard', 'pro', 'max'].includes(tier), verified: typeof tier === 'string' };
  } catch { return { pricingUrl, premium: false, verified: false }; }
};
const obj = (v: unknown): Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
export const readExportSettings = (raw: unknown, canvas: { width: number; height: number }, access: ExportAccess): VideoExportSettings => {
  const v = obj(raw);
  if (v.dynamicRange !== undefined && v.dynamicRange !== 'sdr') throw new Error('HDR is unavailable: HTML scenes are rendered in SDR. Choose SDR.');
  const resolution = String(v.resolution ?? 'original') as VideoExportSettings['resolution'];
  if (!['original', '480', '720', '1080', '1440', '2160'].includes(resolution)) throw new Error('Choose original, 480p, 720p, 1080p, 2K or 4K.');
  const edge = resolution === 'original' ? Math.min(canvas.width, canvas.height) : Number(resolution);
  if (edge > 1080 && !access.premium) throw new Error('PAID_RESOLUTION: 2K and 4K require a paid plan. Open the online pricing page to unlock, then refresh your plan.');
  const fps = v.fps === undefined || v.fps === null ? null : Number(v.fps);
  if (fps !== null && ![24, 25, 30, 50, 60].includes(fps)) throw new Error('Frame rate must match the timeline or be 24, 25, 30, 50 or 60 fps.');
  const bitrate = v.bitrate === undefined || v.bitrate === null ? null : Number(v.bitrate);
  if (bitrate !== null && (!Number.isFinite(bitrate) || bitrate < 1 || bitrate > 100)) throw new Error('Video bitrate must be recommended or between 1 and 100 Mbps.');
  const name = String(v.name ?? 'Popost-video').replace(/\.mp4$/i, '').replace(/[^\p{L}\p{N} ._-]/gu, '-').trim().slice(0, 100) || 'Popost-video';
  const range = (key: 'from' | 'to'): number | undefined => {
    if (v[key] === undefined) return undefined;
    const n = Number(v[key]);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('Export range must use non-negative whole timeline frames.');
    return n;
  };
  return { name, resolution, dynamicRange: 'sdr', fps, bitrate, audio: v.audio !== false, from: range('from'), to: range('to') };
};
export const exportScale = (settings: VideoExportSettings, canvas: { width: number; height: number }): number =>
  settings.resolution === 'original' ? 1 : Number(settings.resolution) / Math.min(canvas.width, canvas.height);
