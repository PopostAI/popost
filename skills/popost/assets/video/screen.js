/*
 * popost screen helper: a still of a page under a camera, driven by a short list of steps.
 * Part of the popost Skill. Copyright (c) 2026 CLIPCAT AI LTD. See the Skill's LICENSE.
 *
 * A scene loads it (<script src="../lib/popost-screen.js"></script>) and calls
 *   popostScreen('#window', { still: '../assets/page-01.png', scale: 1, top: 0, steps: [ ... ] });
 * Boxes are [x, y, width, height] in page pixels, exactly as `popost video capture --outline` prints them; scale and
 * top are what `--still` printed (stillScale and y). Times are seconds from the start of the shot.
 *
 * Everything drawn is a function of the shot's time only: no timers, no clock, no randomness. The engine calls
 * window.__popostScene.render(seconds) for every frame; this helper adds itself to that function.
 */
(function () {
  'use strict';
  var SVG = 'http://www.w3.org/2000/svg';
  var LENGTH = { zoom: 0.8, view: 0.8, scroll: 0.8, highlight: 0.4, clear: 0.25, pointer: 0.6, click: 0.45, type: 1.2 };
  var KINDS = ['view', 'zoom', 'scroll', 'highlight', 'clear', 'pointer', 'click', 'still', 'type'];
  var BLUR = 2.5;
  var LINE = 4;
  var PAD = 6;
  var ARROW = 'M0 0L0 15.6L3.7 12.2L6.2 17.9L8.7 16.8L6.2 11.2L11.1 11.2Z';

  var clamp01 = function (p) { return p < 0 ? 0 : p > 1 ? 1 : p; };
  var ease = function (name, p) {
    p = clamp01(p);
    if (name === 'linear') return p;
    if (name === 'in') return p * p * p;
    if (name === 'out') return 1 - Math.pow(1 - p, 3);
    return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  };
  var mix = function (a, b, p) { return a + (b - a) * p; };
  var px = function (n) { return Math.round(n * 100) / 100 + 'px'; };
  var kindOf = function (step) { for (var i = 0; i < KINDS.length; i++) if (step[KINDS[i]] !== undefined) return KINDS[i]; return undefined; };
  var isBox = function (b) { return Array.isArray(b) && b.length === 4 && b.every(function (n) { return typeof n === 'number' && isFinite(n); }); };
  var el = function (tag, css, parent, ns) {
    var e = ns ? document.createElementNS(SVG, tag) : document.createElement(tag);
    if (css) e.setAttribute('style', css);
    parent.appendChild(e);
    return e;
  };
  /**
   * Whether the scene's page is laid out at all. A scene waiting for its segment can sit in a frame that is not
   * displayed: its page then has no viewport, and every element in it measures 0.
   */
  var pageShown = function () { return (window.innerWidth || document.documentElement.clientWidth) > 0; };
  /** Adds a drawing to the scene's render(seconds, fps), after the one the scene set itself (if any). */
  var onRender = function (draw) {
    var scene = window.__popostScene || (window.__popostScene = {});
    var before = scene.render;
    scene.render = function (seconds, fps) {
      if (typeof before === 'function') before.call(scene, seconds, fps);
      draw(seconds);
    };
  };

  function popostScreen(target, options) {
    var o = options || {};
    var win = typeof target === 'string' ? document.querySelector(target) : target;
    var problems = [], untold = [];
    var report = function (level, message, fix) {
      problems.push({ level: level, message: message, fix: fix });
      untold.push('popost-screen: ' + level + ': ' + message + ' | Fix: ' + fix);
    };
    // Problems are written to the console (where scene check reads them) when a frame is drawn with the scene on
    // screen, not while the page loads: so they are read with this scene's frames, not with whichever scene was
    // being looked at while every scene loaded.
    var tell = function () {
      if (!pageShown()) return;
      untold.splice(0).forEach(function (line) { console.error(line); });
    };
    if (!win) { report('error', 'popostScreen: no element matches "' + target + '".', 'Give the selector of the element that is the window onto the still.'); onRender(tell); return { draw: tell, problems: problems }; }
    if (getComputedStyle(win).position === 'static') win.style.position = 'relative';
    win.style.overflow = 'hidden';
    if (o.background) win.style.background = o.background;

    var steps = (o.steps || []).map(function (s, i) { return Object.assign({ index: i + 1, kind: kindOf(s) }, s); });
    // Every still is in the page from the start, so that the engine waits for it and says so when one does not load.
    var layer = el('div', 'position:absolute;left:0;top:0;transform-origin:0 0;', win);
    var stills = [{ src: o.still, scale: o.scale || 1, top: o.top || 0, from: 0 }];
    steps.forEach(function (s) { if (s.kind === 'still') stills.push({ src: s.still, scale: s.scale || stills[0].scale, top: s.top !== undefined ? s.top : stills[0].top, from: s.at }); });
    stills.forEach(function (st) {
      st.img = el('img', 'position:absolute;left:0;display:block;max-width:none;', layer);
      st.img.alt = '';
      st.img.setAttribute('src', st.src || '');
    });
    var overlay = el('svg', 'position:absolute;left:0;top:0;overflow:visible;pointer-events:none;', win, true);
    var dim = el('path', '', overlay, true);
    var pointerSvg = el('svg', 'position:absolute;left:0;top:0;overflow:visible;pointer-events:none;transform-origin:0 0;', win, true);
    var size = o.pointerSize || 1;
    pointerSvg.setAttribute('width', String(24 * size)); pointerSvg.setAttribute('height', String(36 * size)); pointerSvg.setAttribute('viewBox', '0 0 12 18');
    var arrow = el('path', '', pointerSvg, true);
    arrow.setAttribute('d', ARROW); arrow.setAttribute('fill', o.pointerColor || '#ffffff'); arrow.setAttribute('stroke', o.pointerOutline || '#111111'); arrow.setAttribute('stroke-width', '1.1'); arrow.setAttribute('stroke-linejoin', 'round');
    var colour = o.color || '#e5342b';
    steps.forEach(function (s) {
      if (s.kind === 'highlight') { s.shape = el(s.style === 'underline' ? 'line' : 'rect', '', overlay, true); s.shape.setAttribute('fill', 'none'); s.shape.setAttribute('stroke', s.color || colour); s.shape.setAttribute('stroke-width', String(LINE)); s.shape.setAttribute('stroke-linecap', 'round'); }
      if (s.kind === 'click') { s.ring = el('circle', '', overlay, true); s.ring.setAttribute('fill', 'none'); s.ring.setAttribute('stroke', s.color || o.ringColor || colour); s.ring.setAttribute('stroke-width', '2.5'); }
      if (s.kind === 'type') { s.field = el('div', 'position:absolute;box-sizing:border-box;white-space:pre;overflow:hidden;', layer); s.caret = el('span', 'display:inline-block;vertical-align:middle;', s.field); s.text = document.createTextNode(''); s.field.insertBefore(s.text, s.caret); }
    });

    var W = 0, H = 0, ready = false, failed = false, sizeTold = false, cams = [], moves = [];
    var stillAt = function (t) { var cur = stills[0]; for (var i = 1; i < stills.length; i++) if (t >= stills[i].from) cur = stills[i]; return cur; };
    var extent = function (st) { return { x: 0, y: st.top, w: st.img.naturalWidth / st.scale, h: st.img.naturalHeight / st.scale }; };
    /** The view: the page rectangle the window shows, x, y, w (page pixels); its height is w * H / W. */
    var fit = function (st, v) {
      var e = extent(st), h = v.w * H / W, x = v.x, y = v.y;
      x = v.w >= e.w ? e.x + (e.w - v.w) / 2 : Math.min(Math.max(x, e.x), e.x + e.w - v.w);
      y = h >= e.h ? e.y + (e.h - h) / 2 : Math.min(Math.max(y, e.y), e.y + e.h - h);
      return { x: x, y: y, w: v.w };
    };
    var whole = function (st, all, from) {
      var e = extent(st), w = all ? Math.max(e.w, e.h * W / H) : e.w;
      var cy = from ? from.y + from.w * H / W / 2 : e.y;
      return fit(st, { x: e.x, y: from ? cy - w * H / W / 2 : e.y, w: w });
    };
    var camAt = function (t, upTo) {
      var v = cams.start;
      for (var i = 0; i < upTo; i++) {
        var c = cams[i];
        if (t < c.t0) break;
        var p = c.t1 > c.t0 ? ease(c.ease, (t - c.t0) / (c.t1 - c.t0)) : 1;
        v = p >= 1 ? c.to : { x: mix(c.from.x, c.to.x, p), y: mix(c.from.y, c.to.y, p), w: mix(c.from.w, c.to.w, p) };
      }
      return v;
    };
    var toScreen = function (v, x, y) { var k = W / v.w; return [(x - v.x) * k, (y - v.y) * k]; };
    var toPage = function (v, sx, sy) { var k = W / v.w; return [v.x + sx / k, v.y + sy / k]; };
    var label = function (s) { return 'step ' + s.index + ' (' + s.kind + ' at ' + s.at + ' s)'; };

    var outside = function (s, box, st) {
      var e = extent(st), tol = 1;
      if (box[0] >= e.x - tol && box[1] >= e.y - tol && box[0] + box[2] <= e.x + e.w + tol && box[1] + box[3] <= e.y + e.h + tol && box[2] > 0 && box[3] > 0) return false;
      report('error', label(s) + ': the box [' + box.join(', ') + '] lies outside the still "' + st.src + '", which covers x ' + e.x + '..' + Math.round(e.x + e.w) + ' and y ' + e.y + '..' + Math.round(e.y + e.h) + ' in page pixels (' + st.img.naturalWidth + 'x' + st.img.naturalHeight + ' pixels at scale ' + st.scale + ', from y ' + st.top + ').',
        'Give the box in page pixels exactly as --outline printed it, and give this still the scale and top that --still printed (stillScale and y). A box below the still needs a still taken further down (--at) or with --full-page.');
      return true;
    };

    /**
     * Measures the window and checks the steps, once: true when it is ready to draw, false to measure again on the
     * next frame drawn. A window that is not rendered (display: none on it, on an element round it or on the frame the
     * scene sits in, as while the scene waits for its segment) measures 0, which says nothing about its size: that is
     * no fault, and nothing is kept from it. A rendered window of no width or height is one.
     */
    var prepare = function () {
      for (var i = 0; i < stills.length; i++) {
        var st = stills[i];
        if (!st.img.naturalWidth) { report('error', 'The still "' + st.src + '" did not load.', 'Check the path: it is relative to the scene file (../assets/page-01.png from scenes/).'); failed = true; return false; }
        st.img.style.width = px(st.img.naturalWidth / st.scale); st.img.style.height = px(st.img.naturalHeight / st.scale); st.img.style.top = px(st.top);
      }
      if (!pageShown() || win.getClientRects().length === 0) return false;
      W = win.clientWidth; H = win.clientHeight;
      if (!W || !H) {
        if (!sizeTold) report('error', 'The window element has no size: it is drawn ' + W + 'x' + H + ' CSS pixels.', 'Give it a width and a height in CSS pixels (an element that holds only the screen is 0 pixels high unless it is given a height).');
        sizeTold = true;
        return false;
      }
      cams.start = whole(stills[0], o.start === 'all');
      var last = -Infinity;
      steps.forEach(function (s) {
        if (!s.kind) { report('error', 'step ' + s.index + ' does nothing: it has none of ' + KINDS.join(', ') + '.', 'Give it one of them, for example { "at": 1, "zoom": [x, y, w, h] }.'); return; }
        if (typeof s.at !== 'number' || !isFinite(s.at) || s.at < 0) { report('error', 'step ' + s.index + ' (' + s.kind + ') has no time: "at" must be seconds from the start of the shot.', 'Add "at": 1.2 (seconds).'); s.at = last > 0 ? last : 0; }
        if (s.at < last) report('error', label(s) + ' comes before the step above it (at ' + last + ' s): the steps are out of order.', 'List the steps in the order of their times, or correct the time.');
        last = Math.max(last, s.at);
        s.len = typeof s.for === 'number' ? Math.max(0, s.for) : (LENGTH[s.kind] || 0);
      });
      return true;
    };

    /** Camera moves, pointer moves and the rest, worked out once in time order: drawing a frame only reads them. */
    var plan = function () {
      steps.forEach(function (s) {
        var st = stillAt(s.at);
        var box = s[s.kind === 'type' ? 'into' : s.kind];
        if (s.kind === 'type' && !isBox(s.into)) report('error', label(s) + ' has no box to type into.', 'Add "into": [x, y, width, height] in page pixels, the field from --outline.');
        if ((s.kind === 'zoom' || s.kind === 'highlight' || s.kind === 'type') && isBox(box)) s.bad = outside(s, box, st);
        if (s.kind === 'pointer' && isBox(s.pointer)) s.bad = outside(s, s.pointer, st);
        if ((s.kind === 'zoom' || s.kind === 'highlight') && !isBox(box)) { report('error', label(s) + ' needs a box [x, y, width, height].', 'Copy the element\'s box from --outline.'); s.bad = true; }
        if (s.bad) return;
        if (s.kind === 'view' || s.kind === 'zoom' || s.kind === 'scroll' || s.kind === 'still') {
          var from = camAt(s.at, cams.length), to;
          if (s.kind === 'view') to = whole(st, s.view === 'all', from);
          else if (s.kind === 'zoom') {
            var f = typeof s.fill === 'number' && s.fill > 0 ? Math.min(1, s.fill) : 0.5;
            var w = Math.max(s.zoom[2] / f, s.zoom[3] / f * W / H);
            to = fit(st, { x: s.zoom[0] + s.zoom[2] / 2 - w / 2, y: s.zoom[1] + s.zoom[3] / 2 - w * H / W / 2, w: w });
          } else if (s.kind === 'scroll') {
            var e = extent(st), h = from.w * H / W;
            var y = s.scroll === 'top' ? e.y : s.scroll === 'bottom' ? e.y + e.h - h : from.y + Number(s.scroll || 0);
            to = fit(st, { x: from.x, y: y, w: from.w });
          } else to = fit(st, from);
          var enlarge = W / to.w / st.scale;
          if (enlarge > BLUR + 1e-9) report('warning', label(s) + ' enlarges the still ' + enlarge.toFixed(1) + ' times: it will look blurred.', 'Take the still at a larger --scale or --zoom (and give its stillScale as scale), or zoom less: a smaller fill.');
          cams.push({ t0: s.at, t1: s.kind === 'still' ? s.at : s.at + s.len, from: from, to: to, ease: s.ease || 'in-out' });
        }
      });
      steps.forEach(function (s) {
        if (s.bad) return;
        if (s.kind === 'pointer') {
          var p = isBox(s.pointer) ? [s.pointer[0] + s.pointer[2] / 2, s.pointer[1] + s.pointer[3] / 2] : s.pointer;
          if (!Array.isArray(p) || p.length !== 2) { report('error', label(s) + ' needs a point [x, y] or a box [x, y, width, height].', 'Give the element\'s box from --outline.'); return; }
          var v = camAt(s.at, cams.length), prev = moves[moves.length - 1];
          var start = prev ? prev.to : toPage(v, toScreen(v, p[0], p[1])[0] + W * 0.3, toScreen(v, p[0], p[1])[1] + H * 0.25);
          moves.push({ t0: s.at, t1: s.at + s.len, from: start, to: p, ease: s.ease || 'in-out', first: !prev });
        }
        if (s.kind === 'click' && !moves.some(function (m) { return m.t0 <= s.at; })) report('error', label(s) + ' clicks where there is no pointer yet.', 'Add a pointer step before it: { "at": ..., "pointer": [x, y, w, h] }.');
      });
      ready = true;
    };

    var pointerAt = function (t) {
      var pos = null, alpha = 1;
      for (var i = 0; i < moves.length; i++) {
        var m = moves[i];
        if (t < m.t0) break;
        var p = m.t1 > m.t0 ? ease(m.ease, (t - m.t0) / (m.t1 - m.t0)) : 1;
        // A curve, not a line: the control point is off the straight path by a quarter of its length.
        var dx = m.to[0] - m.from[0], dy = m.to[1] - m.from[1];
        var cx = (m.from[0] + m.to[0]) / 2 + dy * 0.25, cy = (m.from[1] + m.to[1]) / 2 - dx * 0.25;
        pos = [(1 - p) * (1 - p) * m.from[0] + 2 * (1 - p) * p * cx + p * p * m.to[0], (1 - p) * (1 - p) * m.from[1] + 2 * (1 - p) * p * cy + p * p * m.to[1]];
        if (m.first) alpha = clamp01((t - m.t0) / 0.15);
      }
      return pos ? { x: pos[0], y: pos[1], alpha: alpha } : null;
    };

    var draw = function (seconds) {
      if (!ready && !failed && prepare()) plan();
      if (ready) paint(seconds);
      tell();
    };

    var paint = function (seconds) {
      var t = Math.max(0, seconds);
      var st = stillAt(t), v = camAt(t, cams.length), k = W / v.w;
      stills.forEach(function (s) { s.img.style.display = s === st ? 'block' : 'none'; });
      layer.style.transform = 'translate(' + px(-v.x * k) + ',' + px(-v.y * k) + ') scale(' + Math.round(k * 1e5) / 1e5 + ')';
      overlay.setAttribute('width', String(W)); overlay.setAttribute('height', String(H));
      var screenBox = function (b) { var a = toScreen(v, b[0], b[1]); return [a[0] - PAD, a[1] - PAD, b[2] * k + 2 * PAD, b[3] * k + 2 * PAD]; };
      var dimmed = '';
      steps.forEach(function (s) {
        if (s.kind === 'highlight' && s.shape) {
          var on = !s.bad && t >= s.at && st === stillAt(s.at);
          var cleared = steps.filter(function (c) { return c.kind === 'clear' && c.at >= s.at && t >= c.at; })[0];
          var fade = cleared ? 1 - ease('out', cleared.len > 0 ? (t - cleared.at) / cleared.len : 1) : 1;
          var p = ease(s.ease || 'out', s.len > 0 ? (t - s.at) / s.len : 1);
          s.shape.style.display = on && fade > 0 && s.style !== 'dim' ? 'inline' : 'none';
          if (!on || s.bad) return;
          var b = screenBox(s.highlight);
          if (s.style === 'dim') { dimmed = 'M0 0H' + W + 'V' + H + 'H0Z M' + b[0] + ' ' + b[1] + 'v' + b[3] + 'h' + b[2] + 'v' + -b[3] + 'Z'; dim.setAttribute('fill', 'rgba(0,0,0,' + (0.55 * p * fade).toFixed(3) + ')'); return; }
          s.shape.setAttribute('opacity', fade.toFixed(3));
          if (s.style === 'underline') {
            var y = b[1] + b[3] - PAD + LINE;
            s.shape.setAttribute('x1', String(b[0] + PAD)); s.shape.setAttribute('y1', String(y)); s.shape.setAttribute('x2', String(b[0] + PAD + (b[2] - 2 * PAD) * p)); s.shape.setAttribute('y2', String(y));
          } else {
            var len = 2 * (b[2] + b[3]);
            s.shape.setAttribute('x', String(b[0])); s.shape.setAttribute('y', String(b[1])); s.shape.setAttribute('width', String(b[2])); s.shape.setAttribute('height', String(b[3])); s.shape.setAttribute('rx', '6');
            s.shape.setAttribute('stroke-dasharray', len + ' ' + len); s.shape.setAttribute('stroke-dashoffset', String(len * (1 - p)));
          }
        }
        if (s.kind === 'type' && s.field) {
          var shown = !s.bad && t >= s.at && st === stillAt(s.at);
          s.field.style.display = shown ? 'block' : 'none';
          if (!shown) return;
          var chars = Array.from(String(s.type)), n = Math.floor(chars.length * clamp01(s.len > 0 ? (t - s.at) / s.len : 1));
          // Inside the field's border, so the field still looks like a field; the white covers its placeholder.
          var bx = s.into, fs = s.size || bx[3] * 0.5, inset = Math.max(1, bx[3] * 0.06);
          s.field.style.cssText = 'position:absolute;box-sizing:border-box;white-space:pre;overflow:hidden;display:block;left:' + px(bx[0] + inset) + ';top:' + px(bx[1] + inset) + ';width:' + px(bx[2] - 2 * inset) + ';height:' + px(bx[3] - 2 * inset) + ';padding-left:' + px(bx[3] * 0.3 - inset) + ';line-height:' + px(bx[3] - 2 * inset) + ';font:' + (s.weight || 400) + ' ' + px(fs) + ' ' + (s.font || 'system-ui, "Noto Sans CJK SC", sans-serif') + ';color:' + (s.color || '#111111') + ';background:' + (s.cover === false ? 'transparent' : (s.background || '#ffffff')) + ';';
          s.text.nodeValue = chars.slice(0, n).join('');
          var typing = t < s.at + s.len;
          s.caret.style.cssText = 'display:inline-block;vertical-align:middle;margin-left:' + px(fs * 0.05) + ';width:' + px(Math.max(1, fs * 0.08)) + ';height:' + px(fs * 1.15) + ';background:' + (typing ? (s.color || '#111111') : 'transparent') + ';';
        }
      });
      dim.setAttribute('d', dimmed);
      var ptr = pointerAt(t);
      pointerSvg.style.display = ptr ? 'block' : 'none';
      var dip = 1;
      steps.forEach(function (s) {
        if (s.kind !== 'click' || !s.ring) return;
        var dt = t - s.at, at = pointerAt(s.at), on = ptr && at && dt >= 0 && dt < s.len;
        s.ring.style.display = on ? 'inline' : 'none';
        if (!on) return;
        // The ring stays where the click was, on the page: it moves with the camera, not with the pointer.
        var a = toScreen(v, at.x, at.y), p = s.len > 0 ? dt / s.len : 1;
        s.ring.setAttribute('cx', String(a[0])); s.ring.setAttribute('cy', String(a[1]));
        s.ring.setAttribute('r', String(4 + 18 * ease('out', p))); s.ring.setAttribute('opacity', (1 - p).toFixed(3));
        if (dt < 0.2) dip = Math.min(dip, 1 - 0.15 * Math.sin(Math.PI * dt / 0.2));
      });
      if (ptr) {
        var at = toScreen(v, ptr.x, ptr.y);
        pointerSvg.style.transform = 'translate(' + px(at[0]) + ',' + px(at[1]) + ') scale(' + dip.toFixed(4) + ')';
        pointerSvg.style.opacity = ptr.alpha.toFixed(3);
      }
    };

    onRender(draw);
    return { draw: draw, problems: problems };
  }

  window.popostScreen = popostScreen;
})();
