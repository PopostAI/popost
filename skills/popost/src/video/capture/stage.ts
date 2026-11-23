/**
 * What a capture draws inside the page, and what it reads there. installStage runs in the page (Playwright sends the
 * function's source, so it may use nothing from outside its body) and leaves window.__popostStage behind.
 *
 * The drawing is an SVG in a closed shadow root of a manual popover: the popover sits in the top layer, above the
 * page's own elements and dialogs, and the shadow root keeps the page's CSS away from it. It ignores the pointer, so
 * clicks reach the page. Its coordinates are the window's (layout) CSS pixels. A zoom is the screenshot's camera, not
 * a change to the page (see director.ts), so everything drawn here is enlarged with the page; sizes that must stay
 * the same in the picture (line widths, the pointer) are divided by the camera's scale.
 *
 * It also reads the page: the font sizes of the text in a part of the window, the fixed and sticky elements that cover
 * it, and, for --outline, the headings and the elements a plan may point at, each with a CSS selector that matches it
 * alone (a selector without commas, so that --hide takes it as it is).
 */
import type { Camera, HighlightStyle, View } from './steps';

export type OverlayKind = 'header' | 'cookie' | 'language' | 'chat' | 'dialog' | 'bar' | 'other';
export interface OverlayFact {
  /** The same element keeps its key while the page stays. */
  key: number;
  selector: string;
  position: 'fixed' | 'sticky';
  /** [x, y, width, height] in window CSS pixels. */
  box: [number, number, number, number];
  text: string;
  kind: OverlayKind;
}
/** box: [x, y, width, height] in page pixels (CSS pixels from the top left of the page). */
export interface TargetFact { y: number; kind: string; selector: string; text: string; box: [number, number, number, number] }
export interface SectionFact { y: number; tag: string; text: string; selector: string; box: [number, number, number, number] }
export interface StageFrame {
  camera: Camera;
  highlight?: { id: number; style: HighlightStyle; color: string; pad: number; progress: number; opacity: number; line: number };
  pointer?: { x: number; y: number; dip: number; size: number };
  ring?: { x: number; y: number; radius: number; opacity: number; line: number };
  /** Read the text sizes and the covering elements of what the camera shows. */
  sample: boolean;
}
export interface StageSample { text: [number, number][]; overlays: OverlayFact[] }
export interface StageOutline { sections: SectionFact[]; targets: TargetFact[]; overlays: OverlayFact[]; text: [number, number][] }
export interface StageApi {
  keep(id: number, el: Element): void;
  render(frame: StageFrame): StageSample | null;
  /** The layout box of a kept element, null when it is gone. */
  box(id: number): [number, number, number, number] | null;
  /** The text sizes and the covering elements of a rectangle in window (layout) pixels. */
  read(rect: { x: number; y: number; w: number; h: number }): StageSample;
  outline(view: View, limit: number): StageOutline;
}

declare global {
  interface Window { __popostStage?: StageApi }
}

/** Installs the stage once per document; css is added to the document (the rules --hide asked for, and the stage's own). */
export const installStage = (css: string): void => {
  if (window.__popostStage) return;
  const NS = 'http://www.w3.org/2000/svg';
  const style = document.createElement('style');
  // The page's own caret blinks in real time, so it is hidden and the stage draws one; a page's ::backdrop rule must not
  // darken the page behind the stage's popover.
  style.textContent = css + '*{caret-color:transparent !important}popost-stage::backdrop{display:none !important}';
  document.documentElement.appendChild(style);
  const host = document.createElement('popost-stage');
  host.setAttribute('popover', 'manual');
  host.setAttribute('style', ['all:initial', 'display:block', 'position:fixed', 'inset:0', 'width:auto', 'height:auto', 'margin:0', 'padding:0', 'border:0',
    'background:transparent', 'overflow:visible', 'pointer-events:none', 'z-index:2147483647'].map((d) => d + ' !important').join(';'));
  const root = host.attachShadow({ mode: 'closed' });
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('style', 'position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible');
  root.appendChild(svg);
  const shape = (tag: string, attrs: Record<string, string>): SVGElement => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    el.setAttribute('display', 'none');
    svg.appendChild(el);
    return el;
  };
  const spot = shape('path', { 'fill-rule': 'evenodd', fill: '#000' });
  const frame = shape('rect', { fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  const underline = shape('line', { 'stroke-linecap': 'round' });
  const caret = shape('rect', {});
  const ringBack = shape('circle', { fill: 'none', stroke: '#000' });
  const ringFront = shape('circle', { fill: 'none', stroke: '#fff' });
  // An arrow pointer 18 units tall, its tip at 0,0: white with a dark outline, readable on any page.
  const arrow = shape('path', { d: 'M0 0L0 15.6L3.7 12.2L6.2 17.9L8.7 16.8L6.2 11.2L11.1 11.2Z', fill: '#fff', stroke: '#111', 'stroke-width': '1.1', 'stroke-linejoin': 'round' });
  document.documentElement.appendChild(host);
  const show = (): void => { try { host.showPopover(); } catch { /* already shown, or no popover support: it is still drawn, fixed */ } };
  show();
  const set = (el: SVGElement, attrs: Record<string, string | number>): void => {
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  };
  const hide = (...els: SVGElement[]): void => { for (const el of els) el.setAttribute('display', 'none'); };
  const kept = new Map<number, Element>();
  const keys = new WeakMap<Element, number>();
  let nextKey = 1;
  const keyOf = (el: Element): number => {
    let k = keys.get(el);
    if (k === undefined) { k = nextKey++; keys.set(el, k); }
    return k;
  };
  const words = (el: Element): string => (((el as HTMLElement).innerText || el.getAttribute('aria-label') || el.getAttribute('alt') || el.textContent || '').replace(/\s+/g, ' ').trim()).slice(0, 60);
  const visible = (el: Element): boolean => el.checkVisibility({ opacityProperty: true, visibilityProperty: true });

  // ---- selectors that match one element and have no comma
  const unique = (sel: string): boolean => { try { return document.querySelectorAll(sel).length === 1; } catch { return false; } };
  // Classes a build tool generated (css-1x2y3z, Button_primary__a1B2c, tabItem_LNqP) change with the next release of the site.
  const goodClass = (c: string): boolean => /^[A-Za-z][\w-]{1,40}$/.test(c) && !/\d{3,}/.test(c) && !/^(css|sc|jsx|emotion|svelte|astro|chakra|tw)-/i.test(c)
    && !/__[\w-]{5}$/.test(c) && !/_(?=[A-Za-z0-9]*[A-Z0-9])[A-Za-z0-9]{4,6}$/.test(c);
  const goodId = (id: string): boolean => /^[A-Za-z][\w-]*$/.test(id) && !/\d{4,}/.test(id);
  const part = (el: Element, classes = 2): string => el.tagName.toLowerCase() + Array.from(el.classList).filter(goodClass).slice(0, classes).map((c) => '.' + CSS.escape(c)).join('');
  const nth = (el: Element): string => {
    const same = el.parentElement ? Array.from(el.parentElement.children).filter((c) => c.tagName === el.tagName) : [];
    return same.length > 1 ? ':nth-of-type(' + (same.indexOf(el) + 1) + ')' : '';
  };
  /** A selector of the element alone that needs no context: its id, a unique tag and classes, or a unique landmark tag. */
  const anchor = (el: Element): string | null => {
    if (el === document.body) return 'body';
    if (el.id && goodId(el.id) && unique('#' + CSS.escape(el.id))) return '#' + CSS.escape(el.id);
    const p = part(el);
    if (p.includes('.') && unique(p)) return p;
    return /^(header|footer|nav|main|aside|article|form|table)$/.test(p) && unique(p) ? p : null;
  };
  const selectorOf = (el: Element): string => {
    const own = anchor(el);
    if (own && own !== 'body') return own;
    const tag = el.tagName.toLowerCase();
    for (const attr of ['data-testid', 'data-test', 'aria-label', 'name', 'placeholder', 'href']) {
      const v = el.getAttribute(attr);
      if (!v || v.length > 60 || /[",\\\n\]]/.test(v)) continue;
      const sel = tag + '[' + attr + '="' + v + '"]';
      if (unique(sel)) return sel;
    }
    if (unique(part(el))) return part(el);
    // The shortest of: an ancestor that can be named alone, then the element anywhere inside it.
    const leaves = [part(el), part(el) + nth(el)];
    for (let a: Element | null = el.parentElement, depth = 0; a && a !== document.documentElement && depth < 8; a = a.parentElement, depth++) {
      const name = anchor(a);
      const found = name ? leaves.map((leaf) => name + ' ' + leaf).find(unique) : undefined;
      if (found) return found;
    }
    // Else a path of child steps: the shortest end of it that is unique, or the path from the nearest ancestor that can be named alone.
    const path: string[] = [];
    let cur: Element = el;
    while (cur.parentElement && cur !== document.documentElement) {
      const parent: Element = cur.parentElement;
      path.unshift(part(cur, 1) + nth(cur));
      if (path.length > 1 && unique(path.join(' > '))) return path.join(' > ');
      const a = anchor(parent);
      if (a && unique(a + ' > ' + path.join(' > '))) return a + ' > ' + path.join(' > ');
      cur = parent;
    }
    return path.join(' > ');
  };

  // ---- what covers the window
  const transparent = (c: string): boolean => c === 'transparent' || /rgba\([^)]*,\s*0(\.0+)?\)$/.test(c);
  const paints = (el: Element): boolean => {
    const cs = getComputedStyle(el);
    if (!transparent(cs.backgroundColor) || cs.backgroundImage !== 'none') return true;
    if (/^(IMG|VIDEO|CANVAS|INPUT|BUTTON|SELECT|TEXTAREA|IFRAME|svg|path|use|g|circle|rect)$/.test(el.tagName)) return true;
    return Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== '');
  };
  const stickyToWindow = (el: Element): boolean => {
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (!/^(visible|clip)$/.test(cs.overflowX) || !/^(visible|clip)$/.test(cs.overflowY)) return false;
    }
    return true;
  };
  const kindOf = (el: Element, b: DOMRect, view: { w: number; h: number }): OverlayKind => {
    const said = (el.id + ' ' + String(el.className) + ' ' + (el.getAttribute('aria-label') ?? '') + ' ' + (el.textContent ?? '').slice(0, 300)).toLowerCase();
    if (b.top <= 2 && b.width >= 0.9 * view.w && b.height <= 0.25 * view.h) return 'header';
    if (/cookie|consent|gdpr/.test(said)) return 'cookie';
    if (/\blang|language|locale|region|translat/.test(said)) return 'language';
    if (/chat|intercom|crisp|drift|zendesk|messenger|livechat/.test(said)) return 'chat';
    if (el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true' || el.tagName === 'DIALOG') return 'dialog';
    if (b.width >= 0.9 * view.w) return 'bar';
    return 'other';
  };
  const overlaysIn = (cam: { x: number; y: number; w: number; h: number }, view: { w: number; h: number }): OverlayFact[] => {
    const found: { el: Element; fact: OverlayFact }[] = [];
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
      if (found.some((f) => f.el.contains(el))) continue;
      if (cs.position === 'sticky' && !stickyToWindow(el)) continue;
      const b = el.getBoundingClientRect();
      const x0 = Math.max(b.left, cam.x); const x1 = Math.min(b.right, cam.x + cam.w);
      const y0 = Math.max(b.top, cam.y); const y1 = Math.min(b.bottom, cam.y + cam.h);
      if (x1 - x0 < 8 || y1 - y0 < 8 || (x1 - x0) * (y1 - y0) < 0.0015 * cam.w * cam.h || !visible(el)) continue;
      // Covering means being on top somewhere and painting there: a sample of points in the part that is seen.
      let hits = 0;
      for (let i = 1; i <= 3; i++) for (let j = 1; j <= 3; j++) {
        // On top there, and something between the element hit and the overlay paints: an empty wrapper covers nothing.
        let hit = document.elementFromPoint(x0 + ((x1 - x0) * i) / 4, y0 + ((y1 - y0) * j) / 4);
        if (!hit || !el.contains(hit)) continue;
        for (; hit && hit !== el && !paints(hit); hit = hit.parentElement);
        if (hit && paints(hit)) hits++;
      }
      if (!hits) continue;
      found.push({ el, fact: { key: keyOf(el), selector: selectorOf(el), position: cs.position as 'fixed' | 'sticky', box: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)], text: words(el), kind: kindOf(el, b, view) } });
    }
    return found.map((f) => f.fact);
  };

  // ---- the size of the text in view
  const textIn = (cam: { x: number; y: number; w: number; h: number }): [number, number][] => {
    const counts = new Map<number, number>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let n = walker.nextNode(), seen = 0; n && seen < 30000; n = walker.nextNode(), seen++) {
      const chars = (n.textContent ?? '').replace(/\s+/g, '').length;
      const el = n.parentElement;
      if (!chars || !el || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TITLE)$/.test(el.tagName)) continue;
      range.selectNodeContents(n);
      const inView = Array.from(range.getClientRects()).some((r) => r.width >= 2 && r.height >= 2 && r.right > cam.x && r.left < cam.x + cam.w && r.bottom > cam.y && r.top < cam.y + cam.h);
      if (!inView || !visible(el)) continue;
      const size = Math.round(parseFloat(getComputedStyle(el).fontSize) * 4) / 4;
      if (size > 0) counts.set(size, (counts.get(size) ?? 0) + chars);
    }
    return Array.from(counts.entries());
  };

  // ---- the caret of the focused input, drawn because the page's own blinks in real time
  const caretBox = (): { x: number; y: number; w: number; h: number; color: string } | null => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize) || 16;
    const h = size * 1.15;
    const w = Math.max(1, size / 14);
    const textual = el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && /^(text|search|email|url|tel|password|number|)$/.test(el.type));
    if (textual) {
      const input = el as HTMLInputElement | HTMLTextAreaElement;
      if (input.selectionStart !== input.selectionEnd) return null;
      const b = input.getBoundingClientRect();
      const mirror = document.createElement('div');
      for (const p of ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderStyle',
        'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontStretch', 'letterSpacing', 'wordSpacing', 'textTransform', 'textIndent', 'lineHeight', 'tabSize', 'textAlign'] as const)
        mirror.style[p] = cs[p];
      mirror.style.position = 'absolute';
      mirror.style.visibility = 'hidden';
      mirror.style.whiteSpace = el instanceof HTMLTextAreaElement ? 'pre-wrap' : 'pre';
      mirror.style.overflowWrap = 'break-word';
      const at = input.selectionEnd ?? input.value.length;
      const value = input.type === 'password' ? '\u{2022}'.repeat(input.value.length) : input.value;
      mirror.textContent = value.slice(0, at);
      const mark = document.createElement('span');
      mark.textContent = '\u{200b}';
      mirror.appendChild(mark);
      root.appendChild(mirror);
      const left = mark.offsetLeft;
      const top = mark.offsetTop;
      const markHeight = mark.offsetHeight;
      mirror.remove();
      // offsetLeft and offsetTop count from inside the mirror's border.
      const y = el instanceof HTMLTextAreaElement ? b.top + parseFloat(cs.borderTopWidth) + top - input.scrollTop + (markHeight - h) / 2 : b.top + b.height / 2 - h / 2;
      return { x: b.left + parseFloat(cs.borderLeftWidth) + left - input.scrollLeft, y, w, h, color: cs.color };
    }
    if (!(el as HTMLElement).isContentEditable) return null;
    const sel = getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
    const range = sel.getRangeAt(0).cloneRange();
    let r = range.getClientRects()[0];
    if (!r) {
      const mark = document.createElement('span');
      mark.textContent = '\u{200b}';
      range.insertNode(mark);
      r = mark.getBoundingClientRect();
      mark.remove();
    }
    return { x: r.left, y: r.top + r.height / 2 - h / 2, w, h, color: cs.color };
  };

  const render = (f: StageFrame): StageSample | null => {
    if (!host.isConnected) document.documentElement.appendChild(host);
    // A dialog or popover the page opened after the stage would sit above it: shown again, the stage is on top.
    if (!host.matches(':popover-open') || document.querySelector(':popover-open:not(popost-stage), dialog:modal')) { try { host.hidePopover(); } catch { /* not shown */ } show(); }
    const s = f.camera.s;
    const W = innerWidth;
    const H = innerHeight;
    const h = f.highlight;
    const el = h ? kept.get(h.id) : undefined;
    hide(spot, frame, underline);
    const b = h && el && el.isConnected ? el.getBoundingClientRect() : null;
    // An element the page hid (a tab panel switched away) has no box: nothing is drawn until it is shown again.
    if (h && b && (b.width > 0 || b.height > 0)) {
      const pad = h.pad / s;
      const x = b.left - pad; const y = b.top - pad; const w = b.width + 2 * pad; const hh = b.height + 2 * pad;
      const r = Math.min(6 / s, w / 2, hh / 2);
      if (h.style === 'box') {
        // Drawn on: the dash is the whole outline, and its offset shrinks to nothing.
        const length = 2 * (w + hh) - (8 - 2 * Math.PI) * r;
        set(frame, { display: 'inline', x, y, width: w, height: hh, rx: r, stroke: h.color, 'stroke-width': h.line / s, 'stroke-dasharray': length + ' ' + length, 'stroke-dashoffset': length * (1 - h.progress), opacity: h.opacity });
      } else if (h.style === 'underline') {
        const ly = b.bottom + pad / 2;
        set(underline, { display: 'inline', x1: x, y1: ly, x2: x + w * h.progress, y2: ly, stroke: h.color, 'stroke-width': h.line / s, opacity: h.opacity });
      } else {
        const hole = 'M' + (x + r) + ' ' + y + 'H' + (x + w - r) + 'A' + r + ' ' + r + ' 0 0 1 ' + (x + w) + ' ' + (y + r) + 'V' + (y + hh - r) + 'A' + r + ' ' + r + ' 0 0 1 ' + (x + w - r) + ' ' + (y + hh)
          + 'H' + (x + r) + 'A' + r + ' ' + r + ' 0 0 1 ' + x + ' ' + (y + hh - r) + 'V' + (y + r) + 'A' + r + ' ' + r + ' 0 0 1 ' + (x + r) + ' ' + y + 'Z';
        set(spot, { display: 'inline', d: 'M-10 -10H' + (W + 10) + 'V' + (H + 10) + 'H-10Z' + hole, opacity: 0.55 * h.progress * h.opacity });
      }
    }
    const c = caretBox();
    if (c) set(caret, { display: 'inline', x: c.x - c.w / 2, y: c.y, width: c.w, height: c.h, fill: c.color });
    else hide(caret);
    const ring = f.ring;
    if (ring && ring.opacity > 0) {
      set(ringBack, { display: 'inline', cx: ring.x, cy: ring.y, r: ring.radius / s, 'stroke-width': (ring.line + 2) / s, opacity: ring.opacity * 0.7 });
      set(ringFront, { display: 'inline', cx: ring.x, cy: ring.y, r: ring.radius / s, 'stroke-width': ring.line / s, opacity: ring.opacity });
    } else hide(ringBack, ringFront);
    const p = f.pointer;
    if (p) set(arrow, { display: 'inline', transform: 'translate(' + p.x + ' ' + p.y + ') scale(' + (p.size / s / 18) * (1 - 0.14 * p.dip) + ')' });
    else hide(arrow);
    if (!f.sample) return null;
    const cam = { x: f.camera.x, y: f.camera.y, w: W / s, h: H / s };
    return { text: textIn(cam), overlays: overlaysIn(cam, { w: W, h: H }) };
  };

  // ---- the outline: headings and the elements a plan may point at, the most prominent first
  const candidatesOf = (view: View): Map<Element, { kind: string; weight: number }> => {
    const found = new Map<Element, { kind: string; weight: number }>();
    const add = (el: Element, kind: string, weight: number): void => { if (!found.has(el)) found.set(el, { kind, weight }); };
    for (const el of Array.from(document.querySelectorAll('input,textarea,select,[contenteditable=""],[contenteditable=true],[role=textbox],[role=searchbox],[role=combobox]'))) {
      const type = el instanceof HTMLInputElement ? el.type : '';
      if (!/^(hidden|checkbox|radio|range|color|file)$/.test(type)) add(el, /^(submit|button|reset|image)$/.test(type) ? 'button' : 'input', 5);
    }
    for (const el of Array.from(document.querySelectorAll('button,[role=button],[role=tab],[role=menuitem],a[href]'))) {
      const outer = el.parentElement?.closest('button,[role=button]');
      if (outer) continue;
      const cs = getComputedStyle(el);
      const solid = !transparent(cs.backgroundColor) || (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none' && !transparent(cs.borderTopColor));
      if (el.tagName === 'A' && !solid && !/btn|button|cta/i.test(String(el.className))) {
        if (!el.closest('p,td')) add(el, 'link', el.closest('nav,header,[role=navigation]') ? 1.2 : 0.6);
      } else if (el.getAttribute('role') === 'tab') add(el, 'tab', 2);
      else add(el, 'button', 5);
    }
    const bodySize = parseFloat(getComputedStyle(document.body).fontSize) || 16;
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const text = el.children.length ? '' : (el.textContent ?? '').trim();
      if (text && text.length <= 14 && /^[^\d]{0,3}\d[\d.,:]*\s?(%|[kKmMbB]|x|\+|\/\w+)?$/.test(text) && parseFloat(getComputedStyle(el).fontSize) >= Math.max(28, 1.6 * bodySize)) add(el, 'number', 4);
    }
    // Blocks of code and large pictures: what a recording of documentation or a product page often points at.
    for (const el of Array.from(document.querySelectorAll('pre,img,video,canvas'))) {
      const b = el.getBoundingClientRect();
      if (el.tagName === 'PRE') add(el.parentElement?.closest('pre') ?? el, 'code', 1.2);
      else if (b.width >= 120 && b.height >= 80) add(el, 'picture', 1);
    }
    const area = view.width * view.height;
    const cards: Element[] = [];
    for (const el of Array.from(document.body.querySelectorAll('div,li,article,section,a'))) {
      const b = el.getBoundingClientRect();
      if (b.width < 120 || b.height < 80 || b.width > 0.6 * view.width || b.width * b.height > 0.4 * area || cards.some((c) => c.contains(el))) continue;
      const cs = getComputedStyle(el);
      const framed = cs.boxShadow !== 'none' || (parseFloat(cs.borderTopWidth) >= 1 && parseFloat(cs.borderLeftWidth) >= 1 && cs.borderTopStyle !== 'none' && !transparent(cs.borderTopColor));
      const parent = el.parentElement;
      const filled = !transparent(cs.backgroundColor) && parent !== null && cs.backgroundColor !== getComputedStyle(parent).backgroundColor;
      if (!(framed || filled) || !(el.textContent ?? '').trim() || !parent) continue;
      // A card has a sibling of about its width: one of a row or a column of cards.
      if (!Array.from(parent.children).some((c) => c !== el && Math.abs(c.getBoundingClientRect().width - b.width) < 0.2 * b.width)) continue;
      cards.push(el);
      add(el, 'card', 1.5);
    }
    return found;
  };
  const pageBox = (b: DOMRect): [number, number, number, number] => [Math.round(b.left + scrollX), Math.round(b.top + scrollY), Math.round(b.width), Math.round(b.height)];
  const outline = (view: View, limit: number): StageOutline => {
    const sections = Array.from(document.querySelectorAll('h1,h2,h3,[role=heading]')).flatMap((el) => {
      const b = el.getBoundingClientRect();
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!text || b.width < 1 || b.height < 1 || getComputedStyle(el).visibility === 'hidden') return [];
      return [{ y: Math.round(b.top + scrollY), tag: el.tagName.toLowerCase(), text: text.slice(0, 80), el, box: pageBox(b) }];
    }).sort((a, b) => a.y - b.y);
    // Too many headings: the third level goes first.
    const shownSections = sections.length > limit ? sections.filter((s) => s.tag !== 'h3' && s.tag !== 'div').slice(0, limit) : sections;
    const area = view.width * view.height;
    const hidden = (el: Element, b: DOMRect): boolean => {
      const cs = getComputedStyle(el);
      // Off to a side, or clipped to nothing: a "skip to content" link, text for screen readers.
      return b.width < 4 || b.height < 4 || b.right <= 0 || b.left >= innerWidth || (cs.clip !== 'auto' && cs.clip !== '') || /inset\((50|100)%/.test(cs.clipPath) || !visible(el);
    };
    const repeats = new Map<string, number>();
    const ranked = Array.from(candidatesOf(view)).flatMap(([el, c]) => {
      const b = el.getBoundingClientRect();
      if (hidden(el, b)) return [];
      const label = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? (el.placeholder || el.getAttribute('aria-label') || el.name || el.value) : words(el);
      const above = b.top + scrollY < view.height ? 1.5 : 1;
      return [{ el, y: Math.round(b.top + scrollY), kind: c.kind, text: (label ?? '').replace(/\s+/g, ' ').trim().slice(0, 50), box: pageBox(b), score: Math.min(b.width * b.height, 0.3 * area) * c.weight * above }];
    }).sort((a, b) => b.score - a.score).filter((t) => {
      // The same tab or link repeated down the page (npm, yarn, pnpm in every code block): the three most prominent.
      const key = t.kind + ' ' + t.text;
      repeats.set(key, (repeats.get(key) ?? 0) + 1);
      return (repeats.get(key) ?? 0) <= 3;
    }).slice(0, limit).sort((a, b) => a.y - b.y);
    const whole = { x: 0, y: 0, w: innerWidth, h: innerHeight };
    return {
      sections: shownSections.map((s) => ({ y: s.y, tag: s.tag, text: s.text, selector: s.el.id ? '#' + CSS.escape(s.el.id) : selectorOf(s.el), box: s.box })),
      targets: ranked.map((t) => ({ y: t.y, kind: t.kind, selector: selectorOf(t.el), text: t.text, box: t.box })),
      overlays: overlaysIn(whole, { w: innerWidth, h: innerHeight }),
      text: textIn(whole),
    };
  };

  window.__popostStage = {
    keep: (id, el) => { kept.set(id, el); },
    render,
    box: (id) => {
      const el = kept.get(id);
      if (!el || !el.isConnected) return null;
      const b = el.getBoundingClientRect();
      return [b.left, b.top, b.width, b.height];
    },
    outline,
    read: (rect) => ({ text: textIn(rect), overlays: overlaysIn({ x: 0, y: 0, w: innerWidth, h: innerHeight }, { w: innerWidth, h: innerHeight }) }),
  };
};
