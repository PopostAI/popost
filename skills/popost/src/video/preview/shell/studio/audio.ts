import type { Store } from '../app';
import { fileUrl } from './ui';

export const mountProjectAudio = (store: Store): void => {
 let nodes: { audio: HTMLAudioElement; gain: GainNode; source: string }[] = [];
 let context: AudioContext | undefined;
 const clear = (): void => { for (const n of nodes) { n.audio.pause(); n.audio.removeAttribute('src'); n.gain.disconnect(); } nodes = []; };
 const sync = (): void => {
  const v = store.get(); const r = v.state?.resolved; if (!r) return;
  const wanted = r.audio;
  if (wanted.length !== nodes.length || nodes.some((n, i) => n.source !== wanted[i]?.src)) {
   clear(); context ??= new AudioContext();
   nodes = wanted.map(a => { const audio = new Audio(fileUrl(a.src)); audio.preload = 'metadata'; const gain = context!.createGain(); context!.createMediaElementSource(audio).connect(gain).connect(context!.destination); return { audio, gain, source: a.src }; });
  }
  if (v.playing && context?.state === 'suspended') void context.resume().catch(() => undefined);
  const t = v.frame / r.canvas.fps;
  nodes.forEach((node, i) => {
   const a = wanted[i]; if (!a) return;
   node.gain.gain.value = v.muted ? 0 : 10 ** (a.gain / 20);
   const inside = v.frame >= a.start && (a.end === undefined || v.frame < a.end);
   const time = Math.max(0, t - a.start / r.canvas.fps + (a.from ? a.from.frame / a.from.fps : 0));
   node.audio.playbackRate = v.speed;
   if (Math.abs(node.audio.currentTime - time) > 0.15) node.audio.currentTime = time;
   if (v.playing && inside && !v.muted) { if (node.audio.paused) void node.audio.play().catch(() => undefined); }
   else node.audio.pause();
  });
 };
 store.subscribe((v, prev) => { if (v.state !== prev.state || v.frame !== prev.frame || v.playing !== prev.playing || v.muted !== prev.muted || v.speed !== prev.speed) sync(); });
 window.addEventListener('pagehide', () => { clear(); void context?.close(); });
};
const waves = new Map<string, Promise<number[]>>();
export const waveform = (file: string): Promise<number[]> => {
 const known = waves.get(file); if (known) return known;
 const value = (async () => { const context = new AudioContext(); try {
  const response = await fetch(fileUrl(file)); const data = await context.decodeAudioData(await response.arrayBuffer()); const channel = data.getChannelData(0); const result: number[] = [];
  for (let i = 0; i < 500; i++) { const a = Math.floor(i * channel.length / 500); const b = Math.floor((i + 1) * channel.length / 500); let peak = 0; for (let j = a; j < b; j += 8) peak = Math.max(peak, Math.abs(channel[j] ?? 0)); result.push(peak); } return result;
 } finally { await context.close(); } })(); waves.set(file, value); return value;
};
