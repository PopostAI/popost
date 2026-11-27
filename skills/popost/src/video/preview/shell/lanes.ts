/**
 * Timeline lanes drawn to scale in frames, with a playhead; a click seeks, a click on a block also selects it.
 * Lanes: seconds, segments with their transitions, one lane per visual item (entrance and exit shaded), audio, the
 * words of every audio track that has them, and the boundaries and motion events of the render's and the reference's
 * measurements, mapped to timeline frames. In edit mode the item bars get grips at their ends and every segment one at
 * its end; edit/lanes-edit.ts drags them.
 */
import type { MeasureFile, PreviewState } from '../protocol';
import type { Resolved, ResolvedAudio, ResolvedItem } from '../../types';
import type { Actions, Store, View } from './app';
import { h, placeAt, placeSpan } from './dom';
import { selectionFrame } from './edit/reveal';
import { waveform } from './studio/audio';
import { t, type Lang } from './i18n';
import {
  allEvents, boundaryLabel, eventLabel, motionLabel, packRows, rulerTicks, sameSelection, timelineFps, timelineFrames, toTimeline,
  transitionLabel, type Selection, type Source,
} from './model';

const DOT = ' · ';

const sel = (s: Selection): Record<string, string> => ({ sel: JSON.stringify(s) });

const lane = (id: string, label: string, children: readonly HTMLElement[], opts: { cls?: string; height?: number; labelSel?: Selection } = {}): HTMLElement =>
  h('div', { class: 'lane ' + (opts.cls ?? ''), id: 'lane-' + id, ...(opts.height ? { style: 'height:' + opts.height + 'px' } : {}) }, [
    h('div', { class: 'lane-label', text: label, title: label, ...(opts.labelSel ? { data: sel(opts.labelSel) } : {}) }),
    h('div', { class: 'lane-track' }, children),
  ]);

const block = (cls: string, start: number, end: number, total: number, label: string, title: string, s?: Selection): HTMLElement =>
  placeSpan(h('div', { class: cls, text: label, title, ...(s ? { data: sel(s) } : {}) }), start, end, total);

const rulerLane = (frames: number, fps: number, lang: Lang): HTMLElement =>
  lane('ruler', t(lang, 'ruler'), rulerTicks(frames, fps).map((tk) => placeAt(h('div', { class: 'rtick', text: tk.label, title: 'frame ' + tk.frame }), tk.frame, frames)), { cls: 'ruler' });

/** Edit mode: a grip on the end of every segment (the border its length moves). */
const segmentGrips = (r: Resolved): HTMLElement[] =>
  r.segments.map((s) => placeAt(h('div', { class: 'seg-grip', title: s.id + ': ' + (s.end - s.start) + ' frames', data: { border: String(s.index) } }), s.end, r.frames));

const segmentLane = (r: Resolved, lang: Lang, edit: boolean, generation: number): HTMLElement => {
  const F = r.frames;
  const children = r.segments.flatMap((s) => {
    const color = s.base.kind === 'color' ? s.base.color : undefined;
    const seg = block('blk seg', s.start, s.end, F, s.id, s.id + ': frames ' + s.start + '..' + (s.end - 1), { kind: 'segment', id: s.id });
    seg.textContent = '';
    seg.setAttribute('role','button'); seg.tabIndex = 0; seg.setAttribute('aria-label', (lang === 'zh' ? '镜头 ' : 'Shot ') + (s.index + 1) + ' · ' + ((s.end-s.start)/r.canvas.fps).toFixed(2) + 's');
    seg.dataset.index = String(s.index);
    seg.append(h('img', { attrs: { loading: 'lazy', alt: '', src: '/api/thumbnail?frame=' + Math.floor((s.start + s.end) / 2) + '&g=' + generation } }), h('span', { class: 'segment-name', text: String(s.index+1).padStart(2,'0') + ' · ' + ((s.end-s.start)/r.canvas.fps).toFixed(2) + 's' }));
    if (color) seg.prepend(h('span', { class: 'swatch', style: 'background:' + color }));
    const tr = s.transition;
    if (!tr) return s.index === 0 ? [seg] : [seg, placeAt(h('div', { class: 'tick' }), s.start, F)];
    const label = transitionLabel(tr);
    const band = block('band', tr.a, tr.a + tr.frames, F, '', label + ': mixed frames ' + tr.a + '..' + (tr.a + tr.frames - 1) + ', takes over at ' + tr.boundary, { kind: 'segment', id: s.id });
    band.append(h('span', { class: 'band-label', text: label }));
    return [seg, band, placeAt(h('div', { class: 'tick' }), s.start, F)];
  });
  return lane('segments', t(lang, 'segments'), edit ? [...children, ...segmentGrips(r)] : children, { cls: 'segments' });
};

const itemLane = (it: ResolvedItem, F: number, edit: boolean): HTMLElement => {
  const s: Selection = { kind: 'item', id: it.id };
  // The lane's label names the item; the block stays blank so the entrance and exit labels have the room.
  const children = [block('blk item', it.start, it.end, F, '', it.id + ' (' + it.type + '): frames ' + it.start + '..' + (it.end - 1), s)];
  if (it.enter.frames > 0)
    children.push(block('shade enter', it.start, it.start + it.enter.frames, F, motionLabel(it.enter), 'enter: ' + motionLabel(it.enter) + ', ' + it.enter.ease, s));
  if (it.exit.frames > 0)
    children.push(block('shade exit', it.end - it.exit.frames, it.end, F, motionLabel(it.exit), 'exit: ' + motionLabel(it.exit) + ', ' + it.exit.ease, s));
  if (edit) for (const [grip, at] of [['start', it.start], ['end', it.end]] as const) children.push(placeAt(h('div', { class: 'grip ' + grip, data: { grip, ...sel(s) } }), at, F));
  return lane('item-' + it.id, it.id + DOT + it.type, children, { labelSel: s });
};

const audioLane = (a: ResolvedAudio, F: number, lang: Lang, edit = false): HTMLElement => {
  const s: Selection = { kind: 'audio', id: a.id };
  const label = lang === 'zh' ? '音频' : 'Audio';
  const bar = block('blk audio', a.start, a.end ?? F, F, label, label, s);
  bar.setAttribute('role','button');bar.tabIndex=0;bar.setAttribute('aria-label',label);
  void waveform(a.src).then(values => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 500 28'); svg.setAttribute('preserveAspectRatio', 'none');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', values.map((value, i) => 'M' + i + ' ' + (14 - Math.max(1, value * 13)) + 'v' + Math.max(2, value * 26)).join(''));
    path.setAttribute('stroke', '#69967c'); path.setAttribute('stroke-width', '0.8'); svg.append(path); bar.append(svg); bar.classList.add('wave-ready');
  }).catch(() => undefined);
  const handles = (['start','end'] as const).map(grip=>placeAt(h('div',{class:'grip '+grip,data:{grip,...sel(s)}}),grip==='start'?a.start:(a.end??F),F));
  return lane('audio-' + a.id, t(lang, 'audio'), [bar,...(edit ? handles : [])], { labelSel: s });
};

/** One block per token of an audio track's words; a token whose time is a guess (confidence below 0.4) is faded. */
const wordsLane = (w: NonNullable<Resolved['words']>[number], F: number, lang: Lang): HTMLElement =>
  lane('words-' + w.track, t(lang, 'words') + ': ' + w.track, w.tokens.map((tk) =>
    block('blk audio word' + (tk.confidence < 0.4 ? ' unsure' : ''), tk.start, tk.end, F, tk.text, tk.text + ': frames ' + tk.start + '..' + (tk.end - 1) + DOT + 'confidence ' + tk.confidence)), { cls: 'words-lane' });

const boundaryLane = (mf: MeasureFile, source: Source, F: number, fps: number, lang: Lang): HTMLElement => {
  const m = mf.measure;
  const at = (f: number): number => toTimeline(f, m.source.fps, fps);
  const children = m.boundaries.flatMap((b, index) => {
    const s: Selection = { kind: 'boundary', source, index };
    const label = boundaryLabel(b);
    const title = label + ': frames ' + b.start + '..' + b.end + ' of the measured file, takes over at ' + b.frame;
    const mark = placeAt(h('div', { class: 'mark', title, data: sel(s) }, [h('span', { class: 'mark-label', text: label })]), at(b.frame), F);
    return b.kind === 'cut' ? [mark] : [block('mband', at(b.start + 1), at(b.end), F, '', title, s), mark];
  });
  return lane(source + '-boundaries', t(lang, source === 'render' ? 'renderBoundaries' : 'referenceBoundaries'), children, { cls: 'measure ' + source });
};

/** Rows of 14 px; at most 4, so a crowded lane does not push the others out of view. */
const EVENT_ROW = 14;
const EVENT_ROWS = 4;

const eventLane = (mf: MeasureFile, source: Source, F: number, fps: number, lang: Lang): HTMLElement => {
  const m = mf.measure;
  const spans = allEvents(m).map((x) => ({ start: toTimeline(x.event.start, m.source.fps, fps), end: toTimeline(x.event.end, m.source.fps, fps), value: x }));
  const rows = packRows(spans, EVENT_ROWS);
  const children = rows.map((r) => {
    const label = eventLabel(r.value.event);
    const el = block('ev', r.start, r.end, F, label, label + ': frames ' + r.value.event.start + '..' + (r.value.event.end - 1) + ' of the measured file', { kind: 'event', source, shot: r.value.shot, index: r.value.index });
    el.style.top = 3 + r.row * EVENT_ROW + 'px';
    return el;
  });
  const used = Math.max(1, ...rows.map((r) => r.row + 1));
  return lane(source + '-events', t(lang, source === 'render' ? 'renderEvents' : 'referenceEvents'), children, { cls: 'measure ' + source, height: 6 + used * EVENT_ROW });
};

const buildLanes = (s: PreviewState, lang: Lang, view: View): HTMLElement[] => {
  const F = timelineFrames(s);
  const fps = timelineFps(s);
  const r = s.resolved;
  const edit = s.edit !== undefined;
  const out = [rulerLane(F, fps, lang)];
  if (r) {
    if (edit) {
      const scenes = segmentLane(r, lang, edit, s.generation); scenes.querySelector('.lane-label')!.textContent = lang === 'zh' ? '镜头' : 'Shots';
      out.push(scenes);
      const groups = [
        { id: 'subtitles', label: lang === 'zh' ? '字幕' : 'Subtitles', items: r.items.filter(it => it.cue), cls: 'caption-lane' },
        { id: 'text', label: lang === 'zh' ? '文字' : 'Text', items: r.items.filter(it => !it.cue && it.type === 'text'), cls: 'caption-lane' },
        { id: 'media', label: lang === 'zh' ? '素材' : 'Media', items: r.items.filter(it => !it.cue && it.type !== 'text'), cls: 'media-lane' },
      ];
      for (const group of (view.timeline?.layers === false ? [] : groups)) {
        const packed = packRows(group.items.map(it => ({ start: it.start, end: it.end, value: it })).sort((a,b) => a.start-b.start || b.value.z-a.value.z || a.value.id.localeCompare(b.value.id)), Math.max(1, group.items.length));
        const count = Math.max(0, ...packed.map(x => x.row + 1));
        for (let row = 0; row < count; row++) {
          const bars = packed.filter(x => x.row === row).flatMap(({value: it}) => {
            const nodes = Array.from(itemLane(it, F, edit).querySelector('.lane-track')!.children) as HTMLElement[];
            const bar = nodes[0];
            if (bar) { const label = it.text ?? (lang === 'zh' ? (it.type === 'video' ? '视频' : it.type === 'image' ? '图片' : '形状') : it.type); bar.textContent = label; bar.title = label; bar.setAttribute('role','button'); bar.setAttribute('tabindex','0'); bar.setAttribute('aria-label',label); }
            return nodes;
          });
          out.push(lane(group.id + '-' + row, group.label + (row ? ' ' + (row+1) : ''), bars, { cls: group.cls }));
        }
      }
      if (view.timeline?.layers !== false) for (const slot of view.slots ?? []) {
        const scene = r.segments.find(s => s.id === slot.segment); if (!scene) continue;
        const selected: Selection = {kind:'slot',id:slot.segment,name:slot.name};
        const label=slot.kind==='image'?(lang==='zh'?'图片':'Image'):slot.value;
        const bar = block('blk item scene-field',scene.start,scene.end,F,label,lang === 'zh' ? '场景内容：时间由场景控制，点选后编辑内容' : 'Scene content: timing follows scene; select to edit',selected);
        bar.setAttribute('role','button');bar.tabIndex=0;bar.setAttribute('aria-label',(lang==='zh'?'场景内容：':'Scene field: ')+label);
        out.push(lane('slot-'+slot.segment+'-'+slot.name,lang === 'zh' ? '场景内容' : 'Scene content',[bar],{cls:'caption-lane'}));
      }
      out.push(...r.audio.map(a => audioLane(a, F, lang, true)));
    } else {
      out.push(segmentLane(r, lang, edit, s.generation), ...r.items.map(it => itemLane(it, F, edit)), ...r.audio.map(a => audioLane(a, F, lang)), ...(r.words ?? []).map(w => wordsLane(w, F, lang)));
    }
  }
  for (const [mf, source] of [[s.measure, 'render'], [s.referenceMeasure, 'reference']] as const) {
    if (mf && !edit) out.push(boundaryLane(mf, source, F, fps, lang), eventLane(mf, source, F, fps, lang));
  }
  return out;
};

const frameAt = (track: HTMLElement, clientX: number, frames: number): number => {
  const rect = track.getBoundingClientRect();
  return Math.floor(((clientX - rect.left) / Math.max(1, rect.width)) * frames);
};

export const mountLanes = (root: HTMLElement, store: Store, actions: Actions): void => {
  const lanes = h('div', { class: 'lanes', id: 'lanes' });
  const playhead = h('div', { class: 'playhead', id: 'playhead' });
  const layer = h('div', { class: 'playhead-layer' }, [playhead]);
  root.append(lanes);
  const framesOf = (v: View): number => (v.state ? timelineFrames(v.state) : 0);
  const placeHead = (v: View): void => { placeSpan(playhead, v.frame, v.frame + 1, framesOf(v)); };
  const markSelected = (v: View): void => {
    lanes.querySelectorAll<HTMLElement>('[data-sel]').forEach((el) => {
      el.setAttribute('aria-pressed', String(v.pinned !== null && sameSelection(JSON.parse(el.dataset.sel ?? 'null') as Selection, v.pinned)));
      el.classList.toggle('selected', v.pinned !== null && sameSelection(JSON.parse(el.dataset.sel ?? 'null') as Selection, v.pinned));
    });
  };
  const build = (v: View): void => {
    lanes.replaceChildren(...(v.state ? buildLanes(v.state, v.lang, v) : []), layer);
    placeHead(v);
    markSelected(v);
  };
  lanes.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const picked = target.closest<HTMLElement>('[data-sel]')?.dataset.sel;
    if (picked) {
      const selection = JSON.parse(picked) as Selection;
      actions.pause();
      const v = store.get();
      if (v.timeline && ['item','slot','audio'].includes(selection.kind) && !v.timeline.layers) store.set({timeline:{...v.timeline,layers:true}});
      actions.pin(selection);
      const track=target.closest<HTMLElement>('.lane-track');
      if(v.state?.edit)actions.seek(selectionFrame(store.get().state,selection,store.get().frame));
      else if(track&&e.detail!==0)actions.seek(frameAt(track,e.clientX,framesOf(v)));
      else {const span=selection.kind==='segment'?v.state?.resolved?.segments.find(s=>s.id===selection.id):selection.kind==='item'?v.state?.resolved?.items.find(s=>s.id===selection.id):undefined;if(span&&(v.frame<span.start||v.frame>=span.end))actions.seek(span.start);}
    } else {
      const track = target.closest<HTMLElement>('.lane-track');
      if (track) { actions.pin(null); if (e.detail !== 0) actions.seek(frameAt(track,e.clientX,framesOf(store.get()))); }
    }
  });
  lanes.addEventListener('keydown', e => { if (e.key !== 'Enter' && e.key !== ' ') return; const el = (e.target as HTMLElement).closest<HTMLElement>('[data-sel]'); if (el) { e.preventDefault(); el.click(); } });
  root.addEventListener('wheel', e => { if (e.shiftKey && !e.deltaX) { root.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
  build(store.get());
  store.subscribe((v, prev) => {
    if (v.state !== prev.state || v.lang !== prev.lang || v.timeline?.layers !== prev.timeline?.layers || v.slots !== prev.slots) build(v);
    else if (v.frame !== prev.frame) placeHead(v);
    if (v.pinned !== prev.pinned) {
      markSelected(v);
      const selected=lanes.querySelector<HTMLElement>('.blk.selected');
      if(selected){const box=selected.getBoundingClientRect(),viewport=root.getBoundingClientRect();const label=lanes.querySelector('.lane-label')?.getBoundingClientRect().width??0;
        if(box.left<viewport.left+label||box.right>viewport.right)root.scrollLeft+=box.left-viewport.left-label-20;
        const header=(lanes.querySelector('.ruler')?.getBoundingClientRect().height??0)+(selected.closest('.segments')?0:lanes.querySelector('.segments')?.getBoundingClientRect().height??0);
        if(box.top<viewport.top+header||box.bottom>viewport.bottom)root.scrollTop+=box.top-viewport.top-header-6;
      }
    }
  });
};
