/**
 * The stage: the project's page in a same-origin iframe, scaled to fit, driven only by applyFrame(n); the reference
 * video beside it at the same time (in edit mode, the last render instead when asked); and the overlays (item boxes,
 * measured events, safe area).
 */
import type { PopostVideoPage } from '../../page/contract';
import type { Measure } from '../../types';
import type { Actions, Store, View } from './app';
import { h, placeBox } from './dom';
import { t } from './i18n';
import { eventLabel, eventsAt, itemsAt, safeArea, timelineFps } from './model';
import { nativeFootage } from './footage';

interface Viewer { root: HTMLElement; caption: HTMLElement; note: HTMLElement; box: HTMLElement; overlay: HTMLElement }

interface Parts { root: HTMLElement; render: Viewer; reference: Viewer; iframe: HTMLIFrameElement; scaler: HTMLElement; video: HTMLVideoElement }

const viewer = (id: string, content: HTMLElement): Viewer => {
  const caption = h('div', { class: 'caption' });
  const note = h('div', { class: 'note' });
  const overlay = h('div', { class: 'overlay' });
  const box = h('div', { class: 'frame-box' }, [content, overlay]);
  return { root: h('div', { class: 'viewer', id }, [caption, box, note]), caption, note, box, overlay };
};

/** The largest scale of a w x h picture inside an aw x ah box. */
const fitScale = (w: number, hgt: number, aw: number, ah: number): number => Math.max(0.01, Math.min(aw / w, ah / hgt));

const fit = (p: Parts, v: View): void => {
  const withReference = p.reference.root.isConnected;
  const aw = (p.root.clientWidth - 24 - (withReference ? 16 : 0)) / (withReference ? 2 : 1);
  const ah = p.root.clientHeight - 16 - p.render.caption.offsetHeight - p.render.note.offsetHeight - 8;
  const c = v.state?.resolved?.canvas;
  // The page of problems is a document to read and scroll; the video page only ever receives applyFrame.
  p.render.box.classList.toggle('problems', !c);
  if (c) {
    const s = fitScale(c.width, c.height, aw, ah);
    p.render.box.style.cssText = 'width:' + c.width * s + 'px;height:' + c.height * s + 'px;';
    p.scaler.style.cssText = 'width:' + c.width + 'px;height:' + c.height + 'px;transform:scale(' + s + ');';
  } else {
    p.render.box.style.cssText = 'width:' + Math.max(0, aw) + 'px;height:' + Math.max(0, ah) + 'px;';
    p.scaler.style.cssText = 'width:100%;height:100%;';
  }
  if (!withReference) return;
  const src = v.state?.referenceMeasure?.measure.source;
  const w = p.video.videoWidth || src?.width || c?.width || 16;
  const hgt = p.video.videoHeight || src?.height || c?.height || 9;
  const s = fitScale(w, hgt, aw, ah);
  p.reference.box.style.cssText = 'width:' + w * s + 'px;height:' + hgt * s + 'px;';
};

const eventBoxes = (overlay: HTMLElement, m: Measure | undefined, n: number, fps: number): void => {
  if (!m) return;
  for (const e of eventsAt(m, n, fps)) overlay.append(placeBox(h('div', { class: 'ebox' }, [h('span', { text: eventLabel(e) })]), e.box));
};

const drawOverlays = (p: Parts, v: View, actions: Actions): void => {
  const s = v.state;
  p.render.overlay.replaceChildren();
  p.reference.overlay.replaceChildren();
  if (!s?.resolved) return;
  const fps = timelineFps(s);
  if (v.overlays.safe)
    for (const o of [p.render.overlay, p.reference.overlay]) o.append(placeBox(h('div', { class: 'safe' }), safeArea(s.resolved.canvas)));
  if (v.overlays.boxes)
    for (const it of itemsAt(s.resolved, v.frame))
      p.render.overlay.append(placeBox(h('div', { class: 'ibox', title: it.id, on: { click: () => actions.pin({ kind: 'item', id: it.id }) } }, [h('span', { text: it.id })]), it.box));
  if (v.overlays.events) {
    eventBoxes(p.render.overlay, s.measure?.measure, v.frame, fps);
    eventBoxes(p.reference.overlay, s.referenceMeasure?.measure, v.frame, fps);
  }
};

const captions = (p: Parts, v: View): void => {
  const c = v.state?.resolved?.canvas;
  const broken = Boolean(v.state && !v.state.resolved);
  p.render.caption.textContent = t(v.lang, 'render') + (c ? '  ' + c.width + 'x' + c.height + ', ' + c.fps + ' fps' : '');
  p.render.note.textContent = broken ? t(v.lang, 'errorsOnStage') : v.pageError ? t(v.lang, 'imageFailed') + ': ' + v.pageError : '';
  p.render.note.classList.toggle('error', broken || Boolean(v.pageError));
  const render = v.edit.playRender && v.edit.render?.state === 'done' ? v.edit.render : undefined;
  p.reference.caption.textContent = render ? t(v.lang, 'renderFile') + '  ' + (render.file.split(/[\\/]/).pop() ?? '') : t(v.lang, 'reference') + (v.state?.reference ? '  ' + v.state.reference.name : '');
  p.reference.note.textContent = t(v.lang, 'seekNote');
};

/**
 * Keeps the reference video at the shell's frame. Paused: an exact seek on every frame. Playing: the video plays at
 * the same speed and is re-seeked only when it drifts more than 0.2 s, because a seek on every frame stalls it.
 */
const syncVideo = (video: HTMLVideoElement, v: View, prev: View, force: boolean): void => {
  if (!v.state || !video.getAttribute('src')) return;
  // A quarter of a frame past the frame's start, so the seek lands inside the frame's display time and not on its
  // edge, where rounding of the stream's timestamps can show the frame before.
  const time = (v.frame + 0.25) / timelineFps(v.state);
  if (!v.playing) {
    if (!video.paused) video.pause();
    if (force || prev.playing || Math.abs(video.currentTime - time) > 1e-3) video.currentTime = time;
    return;
  }
  video.playbackRate = v.speed;
  if (force || !prev.playing || prev.speed !== v.speed) {
    video.currentTime = time;
    void video.play().catch(() => undefined);
  } else if (!video.seeking && Math.abs(video.currentTime - time) > 0.2) {
    video.currentTime = time;
  }
};

interface PageDriver { load(generation: number): void; apply(): void; loaded(): number }

/**
 * Loads /page into the iframe, waits for prepare(), and applies the shell's frame. body data-ready / data-applied tell
 * tests; data-applied is set once the frame's video pictures are decoded (settle), so it names a frame that is shown.
 */
const pageDriver = (iframe: HTMLIFrameElement, store: Store): PageDriver => {
  let page: PopostVideoPage | undefined;
  let generation = -1;
  let token = 0;
  let applied = 0;
  let footage: ReturnType<typeof nativeFootage> | undefined;
  const apply = (): void => {
    if (!page) return;
    const v = store.get();
    const n = v.frame;
    const mine = ++applied;
    if (v.playing && page.previewFrame && footage) page.previewFrame(n);
    else page.applyFrame(n);
    footage?.sync(n, v.playing, v.speed);
    void page.settle().then(() => null, (e: unknown) => (e instanceof Error ? e.message : String(e))).then((error) => {
      if (mine !== applied) return;
      if (error !== null && error !== store.get().pageError) store.set({ pageError: error });
      document.body.dataset.applied = String(n);
      iframe.dispatchEvent(new Event('frameapplied'));
    });
  };
  iframe.addEventListener('load', () => {
    const mine = ++token;
    const p = iframe.contentWindow?.__popostVideo;
    page = undefined;
    if (!p) {
      // No __popostVideo: /page sent the list of problems instead of the video.
      document.body.dataset.ready = 'error';
      return;
    }
    void p.prepare().then(() => null, (e: unknown) => (e instanceof Error ? e.message : String(e))).then((error) => {
      if (mine !== token) return;
      page = p;
      const resolved = store.get().state?.resolved;
      if (resolved && iframe.contentDocument) footage = nativeFootage(iframe.contentDocument, resolved);
      if (error !== store.get().pageError) store.set({ pageError: error });
      apply();
      document.body.dataset.ready = '1';
      document.dispatchEvent(new Event('studio:page-ready'));
    });
  });
  const load = (g: number): void => {
    generation = g;
    footage?.dispose(); footage = undefined;
    page = undefined;
    document.body.dataset.ready = '';
    iframe.src = '/page?g=' + g;
  };
  return { load, apply, loaded: () => generation };
};

/** What the video beside the stage plays: the reference, or in edit mode the last render when asked. */
const videoSource = (v: View): string => {
  const r = v.edit.render;
  if (v.edit.playRender && r?.state === 'done') return r.url;
  return v.compare !== false && v.state?.reference ? '/reference' : '';
};

/** The parts edit mode draws on: the box of the render's picture and the page in it. */
export interface StageParts { frameBox: HTMLElement; iframe: HTMLIFrameElement }

export const mountStage = (root: HTMLElement, store: Store, actions: Actions): StageParts => {
  const iframe = h('iframe', { id: 'page', attrs: { title: 'page', tabindex: '-1' } });
  const scaler = h('div', { class: 'scaler' }, [iframe]);
  const video = h('video', { id: 'reference-video', attrs: { preload: 'auto', playsinline: '', tabindex: '-1' } });
  video.muted = true;
  const p: Parts = { root, render: viewer('render-view', scaler), reference: viewer('reference-view', video), iframe, scaler, video };
  root.append(p.render.root);
  const driver = pageDriver(iframe, store);
  new ResizeObserver(() => fit(p, store.get())).observe(root);
  video.addEventListener('loadedmetadata', () => {
    fit(p, store.get());
    syncVideo(video, store.get(), store.get(), true);
  });
  let source = '';
  store.subscribe((v, prev) => {
    const wanted = videoSource(v);
    if (wanted !== source) {
      source = wanted;
      if (wanted && !p.reference.root.isConnected) root.append(p.reference.root);
      if (!wanted) p.reference.root.remove();
      if (wanted) video.src = wanted;
      else video.removeAttribute('src');
    }
    if (v.state && v.state.generation !== driver.loaded()) driver.load(v.state.generation);
    if (v.frame !== prev.frame || v.playing !== prev.playing || v.speed !== prev.speed) driver.apply();
    if (v.frame !== prev.frame || v.overlays !== prev.overlays || v.state !== prev.state) drawOverlays(p, v, actions);
    if (v.frame !== prev.frame || v.playing !== prev.playing || v.speed !== prev.speed) syncVideo(video, v, prev, false);
    if (v.compare !== prev.compare || v.lang !== prev.lang || v.state !== prev.state || v.pageError !== prev.pageError || v.edit !== prev.edit) {
      captions(p, v);
      fit(p, v);
    }
  });
  return { frameBox: p.render.box, iframe };
};
