import type { Resolved, ResolvedPlay } from '../../types';
import { sourceFrame } from '../../timeline/footage';

interface Clip { img: HTMLImageElement; play: ResolvedPlay; video?: HTMLVideoElement; active: boolean }

/** Native decoding belongs to the interactive preview; export still uses deterministic extracted frames. */
export const nativeFootage = (doc: Document, r: Resolved) => {
  const clips: Clip[] = [];
  const add = (selector: string, play: ResolvedPlay): void => {
    const img = doc.querySelector<HTMLImageElement>(selector + ' > img');
    if (img) clips.push({ img, play, active: false });
  };
  r.segments.forEach(s => { if (s.base.kind === 'video') add('[data-segment="' + CSS.escape(s.id) + '"]', s.base.play); });
  r.items.forEach(it => { if (it.play) add('[data-item="' + CSS.escape(it.id) + '"]', it.play); });
  const sync = (frame: number, playing: boolean, speed: number): void => {
    for (const clip of clips) {
      const source = r.footage?.[clip.play.material];
      const parent = clip.img.parentElement;
      const active = playing && !!source && !!parent && parent.style.display !== 'none';
      if (!active) {
        clip.video?.pause();
        if (clip.video) { clip.video.hidden = true; clip.video.style.display = 'none'; }
        clip.img.style.visibility = ''; clip.active = false;
        continue;
      }
      if (!source || !parent) continue;
      const video = clip.video ?? doc.createElement('video');
      if (!clip.video) {
        video.src = '/project/' + source.src.split('/').map(encodeURIComponent).join('/'); video.muted = true; video.playsInline = true; video.preload = 'auto';
        video.dataset.previewVideo = clip.play.material;
        parent.append(video); clip.video = video;
      }
      video.hidden = false;
      video.style.cssText = clip.img.style.cssText + ';position:absolute;inset:0;pointer-events:none;';
      clip.img.style.visibility = video.readyState >= 2 ? 'hidden' : '';
      video.style.visibility = video.readyState >= 2 ? '' : 'hidden';
      const time = sourceFrame(clip.play, source, r.canvas.fps, frame) / source.fps;
      const rate = speed * clip.play.speed;
      video.playbackRate = Math.max(.0625, Math.min(16, rate));
      if (!clip.active || (!video.seeking && Math.abs(video.currentTime - time) > .25)) video.currentTime = time;
      const held = frame < clip.play.start || time >= (source.frames - 1) / source.fps;
      if (held) video.pause();
      else if (video.paused) void video.play().catch(() => undefined);
      clip.active = true;
    }
  };
  return { sync, dispose: (): void => { for (const c of clips) { c.video?.pause(); c.video?.removeAttribute('src'); c.video?.remove(); c.img.style.visibility = ''; } } };
};
