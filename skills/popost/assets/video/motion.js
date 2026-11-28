/*
 * popost motion helper: easings, springs, seeded randomness and a set of effects, each a function of the shot's time.
 * Part of the popost Skill. Copyright (c) 2026 CLIPCAT AI LTD. See the Skill's LICENSE.
 *
 * A scene loads it (<script src="../lib/popost-motion.js"></script>, written by
 * `popost video scene library <project> --name motion`) and calls, for example
 *   var M = popostMotion;
 *   M.bounce('#ball', { at: 0.2, for: 1.6, from: [640, 120], floor: 560, bounces: 3, trail: 4, shadow: true });
 *   M.slam('#title', { at: 1.9 });
 * Times are seconds from the start of the shot; positions are CSS pixels of the scene.
 *
 * Everything drawn is a function of the time only: no timers, no clock, no Math.random. The engine calls
 * window.__popostScene.render(seconds, fps) for every frame, in any order; this helper adds itself to that function.
 *
 * Sound cues. Every effect says where a sound belongs: { at, cue, gain, effect } with `at` in seconds of the shot,
 * `cue` one of CUES and `gain` 0..1 (1 the loudest hit of the shot). They are collected in
 * window.__popostScene.cues, sorted by time, and read by `popost video scene cues <project>` without rendering.
 * Pass `cue: false` to an effect to leave its cues out, or `cue: 'pop'` / `gain: 0.5` to change them.
 *
 * The motion rules these effects follow (squash on contact frames only, springs by damping ratio, a flash frame on a
 * slam, titles that land and stay still) are in the Skill's references/video-motion.md, which credits its sources.
 */
(function () {
  'use strict';
  var SVG = 'http://www.w3.org/2000/svg';
  /** The cue names the sound side knows. */
  var CUES = ['whoosh', 'swish', 'pop', 'click', 'tick', 'type', 'impact', 'riser', 'shimmer', 'glitch', 'ding', 'rumble', 'draw', 'sparkle'];

  // ---------------------------------------------------------------------------------------------------------------
  // Numbers
  // ---------------------------------------------------------------------------------------------------------------
  var clamp = function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; };
  var clamp01 = function (p) { return p < 0 ? 0 : p > 1 ? 1 : p; };
  var mix = function (a, b, p) { return a + (b - a) * p; };
  /** 0 before t0, 1 after t0 + length, linear between. */
  var progress = function (t, t0, length) { return length > 0 ? clamp01((t - t0) / length) : t >= t0 ? 1 : 0; };
  var num = function (v, fallback) { return typeof v === 'number' && isFinite(v) ? v : fallback; };

  /** A seeded generator: rng(seed)() is 0..1; the same seed gives the same numbers on every render. */
  var rng = function (seed) {
    var a = (num(seed, 1) * 2654435761) >>> 0;
    var next = function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    next.range = function (lo, hi) { return lo + (hi - lo) * next(); };
    next.int = function (n) { return Math.floor(next() * n); };
    next.pick = function (list) { return list[Math.floor(next() * list.length)]; };
    next.sign = function () { return next() < 0.5 ? -1 : 1; };
    return next;
  };
  /** A number 0..1 for an integer and a seed, with no state. */
  var hash = function (i, seed) {
    var t = (Math.imul(i | 0, 374761393) + Math.imul(num(seed, 1) | 0, 668265263)) >>> 0;
    t = Math.imul(t ^ (t >>> 13), 1274126177) >>> 0;
    return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
  };
  /** Smooth noise of one number, -1..1: the same x and seed give the same value. */
  var noise = function (x, seed) {
    var i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
    return mix(hash(i, seed), hash(i + 1, seed), u) * 2 - 1;
  };
  var noise2 = function (x, y, seed) {
    var xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    var h = function (a, b) { return hash(a * 157 + b * 311, seed); };
    return mix(mix(h(xi, yi), h(xi + 1, yi), u), mix(h(xi, yi + 1), h(xi + 1, yi + 1), u), v) * 2 - 1;
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Easings: functions of 0..1. ease('power2.out'), ease('back.out(1.7)'), ease('spring(0.5,130)'), ease('steps(6)').
  // ---------------------------------------------------------------------------------------------------------------
  /** A spring from 0 to 1: damping is the damping ratio (1 never overshoots, 0.5 overshoots by 16%, 0.2 rings),
   *  stiffness the spring constant with mass 1 and the time in units of the tween's length. */
  var spring = function (damping, stiffness) {
    var z = Math.max(0.01, num(damping, 0.6)), w = Math.sqrt(Math.max(1e-6, num(stiffness, 130)));
    return function (u) {
      if (u <= 0) return 0;
      if (z < 1) {
        var wd = w * Math.sqrt(1 - z * z);
        return 1 - Math.exp(-z * w * u) * (Math.cos(wd * u) + ((z * w) / wd) * Math.sin(wd * u));
      }
      return 1 - Math.exp(-w * u) * (1 + w * u);
    };
  };
  var bounceOut = function (u) {
    var n = 7.5625, d = 2.75, v;
    if (u < 1 / d) return n * u * u;
    if (u < 2 / d) { v = u - 1.5 / d; return n * v * v + 0.75; }
    if (u < 2.5 / d) { v = u - 2.25 / d; return n * v * v + 0.9375; }
    v = u - 2.625 / d;
    return n * v * v + 0.984375;
  };
  var inOut = function (fin) { return function (u) { return u < 0.5 ? fin(2 * u) / 2 : 1 - fin(2 - 2 * u) / 2; }; };
  var outOf = function (fin) { return function (u) { return 1 - fin(1 - u); }; };
  var BASE = {
    sine: function (u) { return 1 - Math.cos((u * Math.PI) / 2); },
    expo: function (u) { return u <= 0 ? 0 : Math.pow(2, 10 * u - 10); },
    circ: function (u) { return 1 - Math.sqrt(1 - Math.min(1, u * u)); }
  };
  var easeCache = {};
  var buildEase = function (name) {
    var n = String(name).replace(/\s+/g, '');
    if (n === 'linear' || n === 'none') return function (u) { return u; };
    if (n === 'in') n = 'power2.in'; if (n === 'out') n = 'power2.out'; if (n === 'in-out' || n === 'inOut') n = 'power2.inOut';
    var m = /^([a-z]+)(\d)?(?:\.(in|out|inOut))?(?:\(([^)]*)\))?$/.exec(n);
    if (!m) return null;
    var family = m[1], k = m[2] ? Number(m[2]) : 0, dir = m[3] || 'out';
    var args = m[4] ? m[4].split(',').map(Number) : [];
    var fin;
    if (family === 'power') fin = function (u) { return Math.pow(u, k + 1); };
    else if (BASE[family]) fin = BASE[family];
    else if (family === 'back') { var s = num(args[0], 1.70158); fin = function (u) { return u * u * ((s + 1) * u - s); }; }
    else if (family === 'elastic') {
      var p = num(args[1], 0.3);
      var eo = function (u) { return u <= 0 ? 0 : u >= 1 ? 1 : Math.pow(2, -10 * u) * Math.sin(((u - p / 4) * 2 * Math.PI) / p) + 1; };
      return dir === 'in' ? outOf(eo) : dir === 'inOut' ? inOut(outOf(eo)) : eo;
    } else if (family === 'bounce') return dir === 'in' ? outOf(bounceOut) : dir === 'inOut' ? inOut(outOf(bounceOut)) : bounceOut;
    else if (family === 'spring') return spring(args[0], args[1]);
    else if (family === 'steps') { var st = Math.max(1, Math.round(num(args[0], 6))); return function (u) { return Math.min(1, Math.floor(u * st + 1e-9) / st); }; }
    else return null;
    return dir === 'in' ? fin : dir === 'inOut' ? inOut(fin) : outOf(fin);
  };
  /** The easing of a name (or a function, returned as it is). An unknown name is power2.out, and is reported once. */
  var ease = function (name) {
    if (typeof name === 'function') return name;
    var key = name === undefined ? 'power2.out' : String(name);
    if (!easeCache[key]) {
      var f = buildEase(key);
      if (!f) { problems.push('There is no ease named "' + key + '"; power2.out is used. Names: linear, power1-4 / sine / expo / circ / back(s) / elastic(1,p) / bounce with .in .out .inOut, steps(n), spring(damping,stiffness).'); f = buildEase('power2.out'); }
      easeCache[key] = f;
    }
    return easeCache[key];
  };
  /** Stepped time, "on twos": the time held for `hold` frames at a time (2 by default), as hand-drawn animation is. */
  var stepped = function (seconds, fps, hold) { var h = Math.max(1, hold || 2) / (fps || 30); return Math.floor(seconds / h + 1e-9) * h; };

  // ---------------------------------------------------------------------------------------------------------------
  // The scene: one render function for the engine, and the list of sound cues.
  // ---------------------------------------------------------------------------------------------------------------
  var problems = [];
  var drawers = [];
  var layers = [];
  var scene = (window.__popostScene = window.__popostScene || {});
  if (!Array.isArray(scene.cues)) scene.cues = [];
  var before = scene.render;
  var state = { seconds: 0, fps: 30 };
  var pending = [];
  /** Whether the page is laid out. A scene of a later shot loads in a layer that is not displayed: everything measures 0 until its first frame. */
  var shown = function () { return document.documentElement.clientWidth > 0 && document.documentElement.clientHeight > 0; };
  /**
   * Runs a set-up that measures the page (an element's size, a path's length) now when the page is laid out, else on
   * the first frame that shows it. Use it in a scene for anything that reads sizes: M.whenShown(function () { ... }).
   */
  var whenShown = function (setup) { if (shown() && !pending.length) setup(); else pending.push(setup); };
  scene.render = function (seconds, fps) {
    state.seconds = seconds; state.fps = fps || 30;
    if (before) before(seconds, fps);
    var i;
    if (pending.length && shown()) { var run = pending; pending = []; for (i = 0; i < run.length; i++) run[i](); }
    for (i = 0; i < layers.length; i++) fitLayer(layers[i]);
    for (i = 0; i < drawers.length; i++) drawers[i](seconds, state.fps);
  };
  /** Adds a function drawn on every frame: draw(seconds, fps). Everything it sets must follow from `seconds`. */
  var on = function (draw) { drawers.push(draw); if (shown()) draw(state.seconds, state.fps); return draw; };
  var r3 = function (v) { return Math.round(v * 1000) / 1000; };
  /** Adds a sound cue of the shot. */
  var cue = function (at, name, gain, effect) {
    if (CUES.indexOf(name) < 0) problems.push('There is no cue named "' + name + '". Names: ' + CUES.join(', ') + '.');
    scene.cues.push({ at: r3(Math.max(0, at)), cue: name, gain: r3(clamp01(num(gain, 0.7))), effect: effect || 'custom' });
    scene.cues.sort(function (a, b) { return a.at - b.at; });
  };
  /** The cues an effect declares, unless its options say otherwise: o.cue false leaves them out, a name replaces the first one's. */
  var declare = function (o, effect, list) {
    if (o && o.cue === false) return [];
    var out = list.map(function (c, i) {
      return { at: c[0], cue: i === 0 && o && typeof o.cue === 'string' ? o.cue : c[1], gain: clamp01(c[2] * num(o && o.gain, 1)) };
    });
    out.forEach(function (c) { cue(c.at, c.cue, c.gain, effect); });
    return out;
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Elements
  // ---------------------------------------------------------------------------------------------------------------
  var one = function (target) {
    var e = typeof target === 'string' ? document.querySelector(target) : target;
    if (!e) problems.push('No element matches "' + target + '".');
    return e;
  };
  var all = function (target) {
    if (typeof target === 'string') return Array.prototype.slice.call(document.querySelectorAll(target));
    if (target && typeof target.length === 'number' && !target.tagName) return Array.prototype.slice.call(target);
    return target ? [target] : [];
  };
  var make = function (tag, css, parent, ns) {
    var e = ns ? document.createElementNS(SVG, tag) : document.createElement(tag);
    if (css) e.setAttribute('style', css);
    (parent || document.body).appendChild(e);
    return e;
  };
  var px = function (n) { return Math.round(n * 100) / 100 + 'px'; };
  /**
   * Sets what an effect moves on an element: { x, y, scale, scaleX, scaleY, rotate (degrees), skewX, opacity, blur
   * (pixels) }. Several effects on one element are combined: each writes under its own key, and the element gets all.
   */
  var parts = new WeakMap();
  var put = function (el, key, s) {
    if (!el) return;
    var mine = parts.get(el);
    if (!mine) { mine = { keys: [], by: {}, base: el.style.transform || '' }; parts.set(el, mine); }
    if (!mine.by[key]) mine.keys.push(key);
    mine.by[key] = s;
    var tf = mine.base, opacity = 1, blur = 0, hasOpacity = false;
    for (var i = 0; i < mine.keys.length; i++) {
      var p = mine.by[mine.keys[i]];
      if (p.x || p.y) tf += ' translate(' + px(p.x || 0) + ',' + px(p.y || 0) + ')';
      if (p.rotate) tf += ' rotate(' + r3(p.rotate) + 'deg)';
      if (p.skewX) tf += ' skewX(' + r3(p.skewX) + 'deg)';
      var sx = num(p.scaleX, 1) * num(p.scale, 1), sy = num(p.scaleY, 1) * num(p.scale, 1);
      if (sx !== 1 || sy !== 1) tf += ' scale(' + r3(sx) + ',' + r3(sy) + ')';
      if (p.opacity !== undefined) { opacity *= p.opacity; hasOpacity = true; }
      if (p.blur) blur += p.blur;
    }
    el.style.transform = tf.trim() || 'none';
    if (hasOpacity) el.style.opacity = r3(clamp01(opacity));
    el.style.filter = blur > 0.05 ? 'blur(' + px(blur) + ')' : '';
  };
  var keyCount = 0;
  var newKey = function (name) { keyCount++; return name + keyCount; };

  /** A canvas over (or, with under, behind) an element (the body by default) that the particle effects draw on; cleared on every frame. */
  var layer = function (parent, under) {
    var host = parent ? one(parent) : document.body;
    for (var i = 0; i < layers.length; i++) if (layers[i].host === host && layers[i].under === !!under) return layers[i];
    var canvas = make('canvas', 'position:absolute;left:0;top:0;pointer-events:none;', host);
    // under: behind everything else of the host (a ground of rays or streaks), instead of over it.
    if (under && host.firstChild !== canvas) host.insertBefore(canvas, host.firstChild);
    var l = { host: host, under: !!under, canvas: canvas, ctx: canvas.getContext('2d'), width: 0, height: 0 };
    layers.push(l);
    fitLayer(l);
    return l;
  };
  /** Gives a layer the size of its host (known only once the page is laid out) and clears it for the frame. */
  var fitLayer = function (l) {
    var w = l.host === document.body ? window.innerWidth : l.host.clientWidth, h = l.host === document.body ? window.innerHeight : l.host.clientHeight;
    if (w > 0 && h > 0 && (l.width !== w || l.height !== h)) { l.width = l.canvas.width = w; l.height = l.canvas.height = h; l.canvas.style.width = w + 'px'; l.canvas.style.height = h + 'px'; }
    else l.ctx.clearRect(0, 0, l.canvas.width, l.canvas.height);
  };

  // ---------------------------------------------------------------------------------------------------------------
  // A generic tween: M.tween('#card', { at: 0.4, for: 0.6, ease: 'expo.out', from: { x: -400, opacity: 0 }, to: { x: 0, opacity: 1 } })
  // ---------------------------------------------------------------------------------------------------------------
  var KEYS = ['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotate', 'skewX', 'opacity', 'blur'];
  var REST = { x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotate: 0, skewX: 0, opacity: 1, blur: 0 };
  var between = function (from, to, p) {
    var s = {};
    KEYS.forEach(function (k) {
      if (from[k] === undefined && to[k] === undefined) return;
      s[k] = mix(num(from[k], REST[k]), num(to[k], REST[k]), p);
    });
    return s;
  };
  var tween = function (target, o) {
    o = o || {};
    var els = all(target), e = ease(o.ease), at = num(o.at, 0), len = num(o['for'], 0.5), from = o.from || {}, to = o.to || {}, key = newKey('tween');
    on(function (t) {
      // Opacity and blur never overshoot: a spring past its end would flash.
      var raw = progress(t, at, len), p = e(raw), flat = clamp01(p);
      var s = between(from, to, p);
      if (s.opacity !== undefined) s.opacity = mix(num(from.opacity, 1), num(to.opacity, 1), flat);
      if (s.blur !== undefined) s.blur = Math.max(0, mix(num(from.blur, 0), num(to.blur, 0), flat));
      els.forEach(function (el) { put(el, key, s); });
    });
    return { at: at, end: at + len, cues: o.cue ? declare(o, 'tween', [[at, typeof o.cue === 'string' ? o.cue : 'swish', 0.5]]) : [] };
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Entrances
  // ---------------------------------------------------------------------------------------------------------------
  /** A spring pop: scale from `from` (0 by default) to 1 on a spring, opacity in the first fifth. Cue: pop. */
  var pop = function (target, o) {
    o = o || {};
    var els = all(target), at = num(o.at, 0), len = num(o['for'], 0.5), from = num(o.from, 0), sp = spring(num(o.damping, 0.5), num(o.stiffness, 180)), key = newKey('pop');
    on(function (t) {
      var u = progress(t, at, len), s = t < at ? from : mix(from, 1, sp(u));
      els.forEach(function (el) { put(el, key, { scale: s, opacity: clamp01(u * 5) }); });
    });
    return { at: at, end: at + len, cues: declare(o, 'pop', [[at + 0.03, 'pop', 0.7]]) };
  };
  /**
   * A slam: the element arrives from large (or from a side) on an accelerating ease, lands, and the frame flashes for
   * a frame or two; the ground can shake. Cues: whoosh at the start, impact on the landing frame.
   */
  var slam = function (target, o) {
    o = o || {};
    var els = all(target), at = num(o.at, 0), len = num(o['for'], 0.22), from = num(o.from, 3.2), key = newKey('slam'), e = ease(o.ease || 'power3.in');
    var land = at + len, settle = num(o.settle, 0.18), dip = num(o.dip, 0.06);
    var white = o.flash === false ? null : make('div', 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;opacity:0;background:' + (o.flashColor || '#ffffff') + ';', o.flashOn ? one(o.flashOn) : document.body);
    on(function (t, fps) {
      var p = e(progress(t, at, len));
      // After the landing: a small dip below 1 and back, never a second bounce.
      var after = t > land ? Math.sin(Math.PI * clamp01((t - land) / settle)) * dip * (1 - clamp01((t - land) / settle)) : 0;
      var s = { scale: mix(from, 1, p) - after, opacity: clamp01(progress(t, at, len * 0.4)), blur: (1 - p) * num(o.blur, 6), x: mix(num(o.x, 0), 0, p), y: mix(num(o.y, 0), 0, p) };
      els.forEach(function (el) { put(el, key, s); });
      if (white) { var frames = (t - land) * fps; white.style.opacity = frames >= -0.5 && frames < num(o.flashFrames, 2) - 0.5 ? String(num(o.flashOpacity, 0.85) * (frames < 0.5 ? 1 : 0.45)) : '0'; }
    });
    if (o.shake) shake(o.shake === true ? document.body : o.shake, { at: land, 'for': 0.3, amount: num(o.shakeAmount, 10), cue: false });
    return { at: at, end: land + settle, land: land, cues: declare(o, 'slam', [[land, 'impact', 1], [at, 'whoosh', 0.5]]) };
  };
  /**
   * The offsets of a staggered group. order: 'start', 'end', 'center', 'edges', 'random' (seeded) or, with cols, the
   * grid orders 'diagonal', 'rows', 'columns', 'radial'. Returns seconds for each index.
   */
  var offsets = function (n, each, order, o) {
    o = o || {};
    var rank = [], i, cols = o.cols, r = rng(num(o.seed, 7));
    for (i = 0; i < n; i++) {
      var col = cols ? i % cols : i, row = cols ? Math.floor(i / cols) : 0, rows = cols ? Math.ceil(n / cols) : 1;
      if (order === 'end') rank.push(n - 1 - i);
      else if (order === 'center') rank.push(Math.abs(i - (n - 1) / 2));
      else if (order === 'edges') rank.push((n - 1) / 2 - Math.abs(i - (n - 1) / 2));
      else if (order === 'random') rank.push(r() * n);
      else if (order === 'diagonal') rank.push(col + row);
      else if (order === 'columns') rank.push(col);
      else if (order === 'rows') rank.push(row);
      else if (order === 'radial') rank.push(Math.hypot(col - (cols - 1) / 2, row - (rows - 1) / 2));
      else rank.push(i);
    }
    var lo = Math.min.apply(null, rank);
    return rank.map(function (v) { return (v - lo) * each; });
  };
  var ENTER = {
    rise: { from: { y: 28, opacity: 0 }, ease: 'power3.out', len: 0.45 },
    drop: { from: { y: -28, opacity: 0 }, ease: 'power3.out', len: 0.45 },
    fade: { from: { opacity: 0 }, ease: 'power1.out', len: 0.3 },
    blur: { from: { opacity: 0, blur: 8 }, ease: 'power2.out', len: 0.3 },
    scale: { from: { scale: 0.6, opacity: 0 }, ease: 'back.out(1.6)', len: 0.4 },
    left: { from: { x: -60, opacity: 0 }, ease: 'expo.out', len: 0.5 },
    right: { from: { x: 60, opacity: 0 }, ease: 'expo.out', len: 0.5 },
    turn: { from: { rotate: -12, y: 20, opacity: 0 }, ease: 'back.out(1.4)', len: 0.45 }
  };
  /**
   * One entrance for each element of a group, one after another: M.stagger('.row', { at: 0.4, each: 0.07, enter:
   * 'rise' }). enter: a name of ENTER, 'pop', or a function (element, seconds, index) that starts an effect. Cues: a
   * tick for each element, quieter than a hit.
   */
  var stagger = function (target, o) {
    o = o || {};
    var els = all(target), at = num(o.at, 0), each = num(o.each, 0.06), offs = offsets(els.length, each, o.order || 'start', o);
    var kind = o.enter || 'rise', end = at, list = [];
    els.forEach(function (el, i) {
      var t0 = at + offs[i];
      if (typeof kind === 'function') kind(el, t0, i);
      else if (kind === 'pop') pop(el, { at: t0, 'for': num(o['for'], 0.45), cue: false });
      else {
        var e = ENTER[kind] || ENTER.rise;
        tween(el, { at: t0, 'for': num(o['for'], e.len), ease: o.ease || e.ease, from: o.from || e.from, to: {} });
      }
      end = Math.max(end, t0 + num(o['for'], 0.45));
      // A cue for every element up to eight; a longer list gets every other one, so that it does not rattle.
      if (els.length <= 8 || i % Math.ceil(els.length / 8) === 0) list.push([t0, o.sound || 'tick', 0.35]);
    });
    return { at: at, end: end, offsets: offs, cues: declare(o, 'stagger', list) };
  };
  /** A grid of elements revealed in an order: M.gridReveal('.cell', { cols: 4, order: 'diagonal', at: 0.2 }). Cue: swish. */
  var gridReveal = function (target, o) {
    o = o || {};
    var r = stagger(target, { at: o.at, each: num(o.each, 0.05), order: o.order || 'diagonal', cols: o.cols || 4, enter: o.enter || 'scale', seed: o.seed, 'for': o['for'], cue: false });
    r.cues = declare(o, 'gridReveal', [[num(o.at, 0), 'swish', 0.5]]);
    return r;
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Text
  // ---------------------------------------------------------------------------------------------------------------
  /** Splits an element's text into spans, by 'chars', 'words' or 'lines' (lines: by <br> or \n). Returns the spans. */
  var split = function (target, by) {
    var el = one(target);
    if (!el) return [];
    if (el.__popostSplit && el.__popostSplit.by === by) return el.__popostSplit.spans;
    var text = el.textContent || '', spans = [];
    var piece = function (t, parent) { var s = document.createElement('span'); s.textContent = t; s.style.display = 'inline-block'; s.style.whiteSpace = 'pre'; parent.appendChild(s); spans.push(s); return s; };
    el.textContent = '';
    if (by === 'lines') text.split(/\n/).forEach(function (line) { var s = piece(line, el); s.style.display = 'block'; });
    else text.split(/(\s+)/).forEach(function (word) {
      if (!word) return;
      if (/^\s+$/.test(word)) { el.appendChild(document.createTextNode(word)); return; }
      if (by === 'words') { piece(word, el); return; }
      // Characters stay inside a span of their word, so that a line never breaks inside a word.
      var w = document.createElement('span'); w.style.display = 'inline-block'; w.style.whiteSpace = 'nowrap'; el.appendChild(w);
      Array.from(word).forEach(function (ch) { piece(ch, w); });
    });
    el.__popostSplit = { by: by, spans: spans };
    return spans;
  };
  /**
   * Kinetic type: the words (or characters, or lines) of an element enter one after another. enter: 'rise', 'drop',
   * 'blur', 'scale', 'fade', 'pop' or 'slam'. Cues: a tick a word; an impact a word for 'slam'.
   */
  var kinetic = function (target, o) {
    o = o || {};
    var by = o.by || 'words', spans = split(target, by), enter = o.enter || 'rise';
    var each = num(o.each, by === 'chars' ? 0.03 : by === 'words' ? 0.09 : 0.18);
    if (enter === 'slam') return stagger(spans, { at: o.at, each: Math.max(each, 0.16), order: o.order, sound: 'impact', cue: o.cue, gain: o.gain, enter: function (el, t0) { slam(el, { at: t0, 'for': 0.16, from: 2.4, flash: false, cue: false }); } });
    return stagger(spans, { at: o.at, each: each, order: o.order, enter: enter, 'for': o['for'], ease: o.ease, seed: o.seed, cue: by === 'chars' ? false : o.cue, gain: o.gain });
  };
  /**
   * Types a text: characters appear one by one, with a cursor. for: the seconds the typing takes (or cps: characters
   * a second). Cues: type, one for every third character.
   */
  var typeOn = function (target, o) {
    o = o || {};
    var el = one(target);
    if (!el) return { at: 0, end: 0, cues: [] };
    var chars = Array.from(o.text !== undefined ? String(o.text) : el.textContent || ''), at = num(o.at, 0);
    var len = o.cps ? chars.length / o.cps : num(o['for'], Math.max(0.3, chars.length * 0.05));
    var cursor = o.cursor === false ? '' : typeof o.cursor === 'string' ? o.cursor : '|', blink = num(o.blink, 0.5);
    on(function (t) {
      var n = t < at ? 0 : Math.min(chars.length, Math.floor(((t - at) / Math.max(1e-6, len)) * chars.length + 1e-9));
      var showCursor = cursor && t >= at && (n < chars.length || (o.cursorStays !== false && Math.floor((t - at - len) / blink) % 2 === 0));
      el.textContent = chars.slice(0, n).join('') + (showCursor ? cursor : '');
    });
    var list = [];
    for (var i = 0; i < chars.length; i += num(o.cueEvery, 3)) list.push([at + (i / Math.max(1, chars.length)) * len, 'type', 0.3]);
    return { at: at, end: at + len, cues: declare(o, 'typeOn', list) };
  };
  /** A text that settles out of changing characters, left to right. Cue: glitch. */
  var scramble = function (target, o) {
    o = o || {};
    var el = one(target);
    if (!el) return { at: 0, end: 0, cues: [] };
    var chars = Array.from(o.text !== undefined ? String(o.text) : el.textContent || ''), at = num(o.at, 0), len = num(o['for'], 0.9);
    var pool = Array.from(o.chars || 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#%&*+='), seed = num(o.seed, 3), rate = num(o.rate, 20);
    on(function (t) {
      var p = progress(t, at, len), tick = Math.floor(t * rate);
      el.textContent = chars.map(function (ch, i) {
        if (/\s/.test(ch) || p * chars.length > i + 1 || t >= at + len) return ch;
        return t < at ? (o.hidden === false ? pool[Math.floor(hash(i, seed) * pool.length)] : ' ') : pool[Math.floor(hash(i * 131 + tick, seed) * pool.length)];
      }).join('');
    });
    return { at: at, end: at + len, cues: declare(o, 'scramble', [[at, 'glitch', 0.5]]) };
  };
  /** A number that counts: M.counter('#n', { at: 0.5, for: 1.2, from: 0, to: 12800, separator: ',', prefix: '$' }). Cues: ticks while it runs, a pop when it lands. */
  var counter = function (target, o) {
    o = o || {};
    var el = one(target), at = num(o.at, 0), len = num(o['for'], 1), from = num(o.from, 0), e = ease(o.ease || 'power3.out'), decimals = num(o.decimals, 0);
    var format = function (v) {
      var s = v.toFixed(decimals);
      if (o.separator) { var bits = s.split('.'); bits[0] = bits[0].replace(/\B(?=(\d{3})+(?!\d))/g, o.separator); s = bits.join('.'); }
      return (o.prefix || '') + s + (o.suffix || '');
    };
    on(function (t) {
      if (!el) return;
      // The slot's own text is the target when no "to" is given, read here because slots are filled after the scripts ran.
      var to = o.to !== undefined ? o.to : Number(String(el.getAttribute('data-to') || el.__popostTo || (el.__popostTo = el.textContent)).replace(/[^0-9.-]/g, '')) || 0;
      el.textContent = format(mix(from, to, e(progress(t, at, len))));
    });
    var list = [[at + len, 'pop', 0.6]];
    for (var i = 0; i < 6; i++) list.push([at + len * (1 - Math.pow(1 - i / 6, 2)) * 0.9, 'tick', 0.25]);
    return { at: at, end: at + len, cues: declare(o, 'counter', list) };
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Paths
  // ---------------------------------------------------------------------------------------------------------------
  /**
   * Draws an SVG path on, as a pen would: the stroke grows from its start. tip: an element (or true for a drawn dot)
   * that rides the end of the stroke. Cue: draw.
   */
  var drawOn = function (target, o) {
    o = o || {};
    var paths = all(target), at = num(o.at, 0), len = num(o['for'], 0.8), e = ease(o.ease || 'power2.inOut'), each = num(o.each, 0);
    var tip = o.tip === true ? null : o.tip ? one(o.tip) : undefined;
    var lengths = [];
    if (o.tip === true && paths[0]) { tip = make('circle', '', paths[0].ownerSVGElement || paths[0].parentNode, true); tip.setAttribute('r', String(num(o.tipSize, 5))); tip.setAttribute('fill', o.tipColor || 'currentColor'); }
    // Hidden until measured: a path's length is known only once the page is laid out.
    paths.forEach(function (p) { p.style.visibility = 'hidden'; });
    whenShown(function () {
      lengths = paths.map(function (p) { return p.getTotalLength ? p.getTotalLength() : 0; });
      paths.forEach(function (p, i) { p.style.strokeDasharray = lengths[i] + ' ' + lengths[i]; p.style.visibility = ''; });
    });
    on(function (t) {
      if (!lengths.length) return;
      var last = null;
      paths.forEach(function (p, i) {
        var u = e(progress(t, at + i * each, len));
        p.style.strokeDashoffset = String(lengths[i] * (1 - u));
        if (u > 0 && u < 1) last = { p: p, d: lengths[i] * u };
      });
      if (!tip) return;
      tip.style.display = last ? '' : 'none';
      if (!last) return;
      var pt = last.p.getPointAtLength(last.d);
      if (tip.namespaceURI === SVG) { tip.setAttribute('cx', String(pt.x)); tip.setAttribute('cy', String(pt.y)); }
      else put(tip, 'tip', { x: pt.x, y: pt.y });
    });
    var end = at + len + each * Math.max(0, paths.length - 1);
    return { at: at, end: end, cues: declare(o, 'drawOn', [[at, 'draw', 0.5]]) };
  };
  /** Points along a path's "d", evenly spaced: for morphing between two shapes with any commands. */
  var samplePath = function (d, n) {
    var svg = make('svg', 'position:absolute;width:0;height:0;visibility:hidden;', document.body, true), p = make('path', '', svg, true);
    p.setAttribute('d', d);
    var len = p.getTotalLength(), pts = [];
    for (var i = 0; i < n; i++) { var q = p.getPointAtLength((i / n) * len); pts.push([q.x, q.y]); }
    svg.parentNode.removeChild(svg);
    return pts;
  };
  /**
   * Morphs a path from one shape to another: both are sampled to the same number of points and each point travels.
   * M.morph('#blob', { to: 'M..Z', at: 1, for: 0.6 }) (from: the path's own d). Closed shapes. Cue: swish.
   */
  var morph = function (target, o) {
    o = o || {};
    var path = one(target), n = num(o.points, 96), at = num(o.at, 0), len = num(o['for'], 0.6), e = ease(o.ease || 'power2.inOut');
    if (!path) return { at: at, end: at + len, cues: [] };
    // Several morphs of one path make a chain: one drawer for the path takes the latest that has started, so that a
    // frame before the first morph shows the first shape again whichever frame was drawn before it.
    var mine = { at: at, len: len, e: e, a: null, b: null, fromD: o.from || path.getAttribute('d') }, chain = path.__popostMorphs;
    whenShown(function () {
      mine.a = samplePath(mine.fromD, n); mine.b = samplePath(o.to, n);
      // The start point of the second shape is turned to the one nearest the first shape's start: no twist.
      var best = 0, bestD = Infinity;
      for (var i = 0; i < n; i++) { var d = Math.hypot(mine.b[i][0] - mine.a[0][0], mine.b[i][1] - mine.a[0][1]); if (d < bestD) { bestD = d; best = i; } }
      mine.b = mine.b.slice(best).concat(mine.b.slice(0, best));
    });
    if (chain) { chain.push(mine); chain.sort(function (x, y) { return x.at - y.at; }); }
    else {
      chain = path.__popostMorphs = [mine];
      on(function (t) {
        var m = chain[0];
        for (var i = 1; i < chain.length; i++) if (t >= chain[i].at) m = chain[i];
        if (!m.a) return;
        var p = m.e(progress(t, m.at, m.len)), out = '';
        for (var k = 0; k < m.a.length; k++) out += (k ? 'L' : 'M') + r3(mix(m.a[k][0], m.b[k][0], p)) + ' ' + r3(mix(m.a[k][1], m.b[k][1], p));
        path.setAttribute('d', out + 'Z');
      });
    }
    return { at: at, end: at + len, cues: declare(o, 'morph', [[at, 'swish', 0.45]]) };
  };
  /** Moves an element along an SVG path (its centre on the path), turned to the path's direction when rotate is true. Cue: whoosh. */
  var follow = function (target, pathTarget, o) {
    o = o || {};
    var el = one(target), path = one(pathTarget), at = num(o.at, 0), len = num(o['for'], 1), e = ease(o.ease || 'power2.inOut'), key = newKey('follow');
    var total = path && path.getTotalLength ? path.getTotalLength() : 0;
    on(function (t) {
      if (!el || !total) return;
      var d = total * e(progress(t, at, len)), p = path.getPointAtLength(d), q = path.getPointAtLength(Math.min(total, d + 1)), back = path.getPointAtLength(Math.max(0, d - 1));
      put(el, key, { x: p.x, y: p.y, rotate: o.rotate ? (Math.atan2(q.y - back.y, q.x - back.x) * 180) / Math.PI : 0 });
    });
    return { at: at, end: at + len, cues: declare(o, 'follow', [[at, 'whoosh', 0.4]]) };
  };

  // ---------------------------------------------------------------------------------------------------------------
  // A bouncing thing: parabolic arcs with restitution.
  // ---------------------------------------------------------------------------------------------------------------
  /**
   * The path of a ball that is dropped and bounces: bouncePath({ height, bounces, restitution, for }) returns
   * at(u) for seconds u from the release: { y (0 at the floor, `height` at the release), v (speed, pixels a second,
   * positive downwards), contact (0..1: 1 on the frame it touches) } and the contact times. Each arc is a parabola;
   * each bounce keeps `restitution` of the speed (0.55 a rubber ball, 0.75 a lively one, 0.35 a heavy one).
   */
  var bouncePath = function (o) {
    o = o || {};
    var height = num(o.height, 300), n = Math.max(0, Math.round(num(o.bounces, 3))), e = clamp(num(o.restitution, 0.6), 0.05, 0.95), total = num(o['for'], 1.5);
    // Time units of sqrt(2h/g): the fall takes 1, bounce i takes 2 e^i.
    var units = 1, i;
    for (i = 1; i <= n; i++) units += 2 * Math.pow(e, i);
    var fall = total / units, g = (2 * height) / (fall * fall), contacts = [fall], arcs = [];
    for (i = 1; i <= n; i++) { arcs.push({ t0: contacts[i - 1], v: Math.pow(e, i) * g * fall, len: 2 * Math.pow(e, i) * fall }); contacts.push(contacts[i - 1] + 2 * Math.pow(e, i) * fall); }
    var window_ = num(o.contact, 0.045);
    var at = function (u) {
      var y, v, k;
      if (u <= 0) { y = height; v = 0; }
      else if (u < fall) { y = height - 0.5 * g * u * u; v = g * u; }
      else {
        y = 0; v = 0;
        for (k = 0; k < arcs.length; k++) {
          var a = arcs[k];
          if (u >= a.t0 && u < a.t0 + a.len) { var s = u - a.t0; y = a.v * s - 0.5 * g * s * s; v = -(a.v - g * s); break; }
        }
      }
      var contact = 0;
      for (k = 0; k < contacts.length; k++) contact = Math.max(contact, 1 - Math.abs(u - contacts[k]) / window_);
      // The strength of each contact falls with the bounces.
      return { y: Math.max(0, y), v: v, contact: clamp01(contact), g: g };
    };
    return { at: at, contacts: contacts, end: contacts[contacts.length - 1], gravity: g, restitution: e };
  };
  /**
   * A ball (any element) that drops and bounces. from: [x, y] of its centre at the release; floor: the y its bottom
   * rests on; to: the x it travels to while bouncing (default: stays). squash: how flat it gets on the frames it
   * touches (0.3); stretch: how long it gets along its path at full speed (0.25); trail: ghost copies behind it;
   * shadow: a contact shadow on the floor that tightens as it comes down. The element is positioned by its centre:
   * give it position: absolute; left: 0; top: 0 and a negative margin of half its size, or let the helper do it
   * (center: true, the default). Cues: an impact at every contact, quieter each time.
   */
  var bounce = function (target, o) {
    o = o || {};
    var el = one(target);
    if (!el) return { at: 0, end: 0, cues: [] };
    var at = num(o.at, 0), key = newKey('bounce');
    // The times of the landings do not depend on any size: they are known at once, for the cues and for the caller.
    var path = bouncePath({ height: 1, bounces: o.bounces, restitution: o.restitution, 'for': num(o['for'], 1.6), contact: o.contact });
    var squash = num(o.squash, 0.3), stretch = num(o.stretch, 0.25);
    whenShown(function () {
      var from = o.from || [window.innerWidth / 2, 100], floor = num(o.floor, window.innerHeight - 100);
      var size = num(o.size, el.offsetHeight || 60), half = size / 2, drop = floor - half - from[1];
      var toX = o.to !== undefined ? num(o.to[0] !== undefined ? o.to[0] : o.to, from[0]) : from[0];
      var vmax = path.gravity * path.contacts[0];
      if (o.center !== false) { el.style.position = 'absolute'; el.style.left = '0'; el.style.top = '0'; el.style.margin = -half + 'px 0 0 ' + -(num(o.width, el.offsetWidth || size) / 2) + 'px'; }
      var pose = function (t) {
        var u = t - at, s = path.at(u), k = clamp01(u / path.end);
        // Squash only while it touches (wider and flatter, its bottom on the floor), less at each softer landing; stretch along the fall at speed.
        var sq = s.contact * squash * (u <= path.contacts[0] + 0.02 ? 1 : Math.pow(path.restitution, path.contacts.filter(function (c) { return c <= u + 0.02; }).length - 1));
        var st = (1 - s.contact) * stretch * Math.min(1, Math.abs(s.v) / vmax);
        var sy = (1 - sq) * (1 + st), sx = 1 / sy;
        return { x: mix(from[0], toX, ease(o.travel || 'linear')(k)), y: floor - half - s.y * drop + (half * (1 - sy)) * (s.contact > 0 ? 1 : 0), scaleX: sx, scaleY: sy, rotate: o.spin ? num(o.spin, 0) * k : 0, height: s.y };
      };
      var ghosts = [], shadow = null, n = Math.max(0, Math.round(num(o.trail, 0))), gap = num(o.trailGap, 0.035), i;
      for (i = 0; i < n; i++) { var g = el.cloneNode(true); g.removeAttribute('id'); el.parentNode.insertBefore(g, el); ghosts.push(g); }
      if (o.shadow) shadow = make('div', 'position:absolute;left:0;top:0;width:' + size * 1.1 + 'px;height:' + size * 0.22 + 'px;margin:' + -(size * 0.11) + 'px 0 0 ' + -(size * 0.55) + 'px;border-radius:50%;background:' + (typeof o.shadow === 'string' ? o.shadow : 'rgba(0,0,0,0.45)') + ';', el.parentNode);
      if (shadow) el.parentNode.insertBefore(shadow, ghosts[0] || el);
      on(function (t) {
        var p = pose(t);
        put(el, key, p);
        ghosts.forEach(function (g, j) {
          var q = pose(t - (j + 1) * gap), moving = Math.abs(p.y - q.y) + Math.abs(p.x - q.x) > 1;
          put(g, key, { x: q.x, y: q.y, scaleX: q.scaleX, scaleY: q.scaleY, opacity: moving ? 0.35 * (1 - j / n) : 0 });
        });
        // The shadow is small and dark under a ball on the floor, wide and faint under one high up.
        if (shadow) put(shadow, key, { x: p.x, y: floor, scale: mix(1, 1.9, clamp01(p.height)), opacity: mix(1, 0.25, clamp01(p.height)), blur: mix(1.5, 10, clamp01(p.height)) });
      });
    });
    return { at: at, end: at + path.end, contacts: path.contacts.map(function (c) { return r3(at + c); }),
      cues: declare(o, 'bounce', path.contacts.map(function (c, k2) { return [at + c, 'impact', Math.max(0.15, Math.pow(path.restitution, k2))]; })) };
  };
  /**
   * Ghost copies behind anything that moves: `pose(seconds)` returns what put() takes, and the element and its copies
   * are set from it at the frame's time and at earlier times. M.trail('#dot', pose, { copies: 5, gap: 0.03 }).
   */
  var trail = function (target, pose, o) {
    o = o || {};
    var el = one(target), n = Math.max(1, Math.round(num(o.copies, 4))), gap = num(o.gap, 0.035), key = newKey('trail'), ghosts = [];
    if (!el) return { cues: [] };
    for (var i = 0; i < n; i++) { var g = el.cloneNode(true); g.removeAttribute('id'); el.parentNode.insertBefore(g, el); ghosts.push(g); }
    on(function (t) {
      var p = pose(t);
      put(el, key, p);
      ghosts.forEach(function (g, j) {
        var q = pose(t - (j + 1) * gap), s = {};
        for (var k in q) s[k] = q[k];
        s.opacity = num(q.opacity, 1) * num(o.opacity, 0.4) * (1 - j / n) * (Math.abs(num(q.x, 0) - num(p.x, 0)) + Math.abs(num(q.y, 0) - num(p.y, 0)) > 0.5 ? 1 : 0);
        put(g, key, s);
      });
    });
    return { cues: [] };
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Particles and light, drawn on a canvas layer
  // ---------------------------------------------------------------------------------------------------------------
  var COLOURS = ['#ffd23f', '#ee4266', '#3bceac', '#540d6e', '#0ead69', '#3a86ff'];
  /**
   * A burst of particles from a point: each flies out, slows, falls a little and fades. M.burst({ at: 1, x: 640, y:
   * 360, count: 28 }). Options: speed (pixels a second), gravity, life (seconds), size, colors, spread (degrees) and
   * angle (the middle of the spread; -90 is up), shape ('dot', 'square', 'line', 'star'), drag, seed, on (the element
   * the layer covers). Cue: pop.
   */
  var burst = function (o) {
    o = o || {};
    var l = layer(o.on), at = num(o.at, 0), n = Math.round(num(o.count, 24)), life = num(o.life, 0.9), r = rng(num(o.seed, 11));
    var spread = (num(o.spread, 360) * Math.PI) / 180, angle = (num(o.angle, -90) * Math.PI) / 180, colors = o.colors || COLOURS, drag = num(o.drag, 2.2);
    var ps = [];
    for (var i = 0; i < n; i++) {
      var a = angle + (r() - 0.5) * spread, v = num(o.speed, 520) * (0.45 + 0.55 * r());
      ps.push({ vx: Math.cos(a) * v, vy: Math.sin(a) * v, size: num(o.size, 9) * (0.5 + r()), color: colors[i % colors.length], life: life * (0.6 + 0.4 * r()), spin: (r() - 0.5) * 14, turn: r() * 6.28, flip: 2 + r() * 6 });
    }
    var g = num(o.gravity, 700), shape = o.shape || 'dot';
    on(function (t) {
      var u = t - at, c = l.ctx, x0 = num(o.x, l.width / 2), y0 = num(o.y, l.height / 2);
      if (u < 0 || u > life) return;
      ps.forEach(function (p) {
        if (u > p.life) return;
        // Speed decays by drag, so the distance is v (1 - e^(-k u)) / k: fast out, then hanging.
        var d = (1 - Math.exp(-drag * u)) / drag, x = x0 + p.vx * d, y = y0 + p.vy * d + 0.5 * g * u * u, k = u / p.life;
        c.save(); c.translate(x, y); c.rotate(p.turn + p.spin * u); c.globalAlpha = clamp01(1.4 * (1 - k));
        c.fillStyle = p.color; c.strokeStyle = p.color;
        var s = p.size * (shape === 'confetti' ? 1 : 1 - 0.5 * k);
        if (shape === 'square') c.fillRect(-s / 2, -s / 2, s, s);
        else if (shape === 'confetti') { c.scale(1, Math.cos(p.flip * u + p.turn)); c.fillRect(-s / 2, -s / 4, s, s / 2); }
        else if (shape === 'line') { c.rotate(-p.turn - p.spin * u + Math.atan2(p.vy + g * u, p.vx)); c.lineWidth = Math.max(1, s / 4); c.beginPath(); c.moveTo(-s * 1.5, 0); c.lineTo(s * 1.5, 0); c.stroke(); }
        else if (shape === 'star') { c.beginPath(); for (var j = 0; j < 10; j++) { var rr = j % 2 ? s * 0.45 : s, an = (j * Math.PI) / 5; c.lineTo(Math.cos(an) * rr, Math.sin(an) * rr); } c.closePath(); c.fill(); }
        else { c.beginPath(); c.arc(0, 0, s / 2, 0, 6.2832); c.fill(); }
        c.restore();
      });
    });
    return { at: at, end: at + life, cues: declare(o, o.effect || 'burst', o.cues || [[at, 'pop', 0.8]]) };
  };
  /** Confetti: paper that is thrown up in a fan, flutters and falls. Cues: pop, then a shimmer while it falls. */
  var confetti = function (o) {
    o = o || {};
    var at = num(o.at, 0);
    return burst({ at: at, x: o.x, y: o.y, count: num(o.count, 70), speed: num(o.speed, 1100), spread: num(o.spread, 70), angle: num(o.angle, -90), gravity: num(o.gravity, 900), life: num(o.life, 2.2), size: num(o.size, 14),
      colors: o.colors, shape: 'confetti', drag: num(o.drag, 1.8), seed: num(o.seed, 5), on: o.on, effect: 'confetti', cue: o.cue, gain: o.gain, cues: [[at, 'pop', 0.9], [at + 0.25, 'shimmer', 0.4]] });
  };
  /** Sparks: short bright lines thrown from a point in one direction, pulled down. Cue: sparkle. */
  var sparks = function (o) {
    o = o || {};
    var at = num(o.at, 0);
    return burst({ at: at, x: o.x, y: o.y, count: num(o.count, 18), speed: num(o.speed, 760), spread: num(o.spread, 80), angle: num(o.angle, -60), gravity: num(o.gravity, 1500), life: num(o.life, 0.6), size: num(o.size, 10),
      colors: o.colors || ['#fff3b0', '#ffd23f', '#ff9f1c'], shape: 'line', drag: num(o.drag, 3), seed: num(o.seed, 9), on: o.on, effect: 'sparks', cue: o.cue, gain: o.gain, cues: [[at, 'sparkle', 0.6]] });
  };
  /** A ring that opens from a point and thins as it fades: the ground answering a landing. Cue: impact. */
  var shockwave = function (o) {
    o = o || {};
    var l = layer(o.on), at = num(o.at, 0), len = num(o['for'], 0.5), e = ease(o.ease || 'expo.out'), radius = num(o.radius, 260), rings = Math.max(1, Math.round(num(o.rings, 1)));
    on(function (t) {
      for (var i = 0; i < rings; i++) {
        var u = progress(t - i * 0.08, at, len);
        if (u <= 0 || u >= 1) continue;
        var c = l.ctx, p = e(u);
        c.save(); c.globalAlpha = (1 - u) * num(o.opacity, 0.9); c.strokeStyle = o.color || '#ffffff'; c.lineWidth = Math.max(0.5, num(o.width, 14) * (1 - p));
        c.beginPath(); c.ellipse(num(o.x, l.width / 2), num(o.y, l.height / 2), radius * p, radius * p * num(o.flat, 1), 0, 0, 6.2832); c.stroke(); c.restore();
      }
    });
    return { at: at, end: at + len, cues: declare(o, 'shockwave', [[at, 'impact', 0.8]]) };
  };
  /**
   * Rays that turn behind a badge or a prize: a sunburst. It keeps turning for the whole shot (an ambient layer, not
   * an entrance), and can open at `at` over `for` seconds. Cue: shimmer when it opens.
   */
  var sunburst = function (o) {
    o = o || {};
    var l = layer(o.on, o.under !== false), rays = Math.round(num(o.rays, 16)), at = num(o.at, 0), len = num(o['for'], 0.5), speed = (num(o.speed, 18) * Math.PI) / 180, e = ease(o.ease || 'back.out(1.4)');
    on(function (t) {
      var open = e(progress(t, at, len));
      if (open <= 0) return;
      var c = l.ctx, r = num(o.radius, Math.hypot(l.width, l.height) / 2) * open, inner = num(o.inner, 0), step = 6.2832 / rays;
      c.save(); c.translate(num(o.x, l.width / 2), num(o.y, l.height / 2)); c.rotate(speed * t); c.globalAlpha = num(o.opacity, 0.5) * clamp01(open); c.fillStyle = o.color || '#ffd23f';
      for (var i = 0; i < rays; i++) {
        var a = i * step, w = step * num(o.share, 0.5) / 2;
        c.beginPath(); c.moveTo(Math.cos(a - w * 0.2) * inner, Math.sin(a - w * 0.2) * inner); c.lineTo(Math.cos(a - w) * r, Math.sin(a - w) * r); c.lineTo(Math.cos(a + w) * r, Math.sin(a + w) * r); c.lineTo(Math.cos(a + w * 0.2) * inner, Math.sin(a + w * 0.2) * inner); c.closePath(); c.fill();
      }
      c.restore();
    });
    return { at: at, end: at + len, cues: declare(o, 'sunburst', [[at, 'shimmer', 0.5]]) };
  };
  /** Speed lines: streaks that rush past in one direction while something moves fast. Cue: whoosh. */
  var speedLines = function (o) {
    o = o || {};
    var l = layer(o.on, o.under), at = num(o.at, 0), len = num(o['for'], 0.5), n = Math.round(num(o.count, 26)), seed = num(o.seed, 21), angle = (num(o.angle, 0) * Math.PI) / 180;
    on(function (t) {
      var u = progress(t, at, len);
      if (u <= 0 || u >= 1) return;
      // In and out over a seventh of a second, full strength between: it can run for a whole shot.
      var c = l.ctx, strength = Math.min(1, (t - at) / 0.15, (at + len - t) / 0.15), diag = Math.hypot(l.width, l.height);
      c.save(); c.translate(l.width / 2, l.height / 2); c.rotate(angle); c.strokeStyle = o.color || '#ffffff'; c.lineCap = 'round';
      for (var i = 0; i < n; i++) {
        var y = (hash(i, seed) - 0.5) * diag, w = diag * (0.15 + 0.35 * hash(i, seed + 1)), sp = 1.5 + 2 * hash(i, seed + 2);
        var x = (((hash(i, seed + 3) + u * sp) % 1) - 0.5) * (diag + w);
        c.globalAlpha = strength * (0.25 + 0.5 * hash(i, seed + 4)); c.lineWidth = 1 + 3 * hash(i, seed + 5);
        c.beginPath(); c.moveTo(x - w / 2, y); c.lineTo(x + w / 2, y); c.stroke();
      }
      c.restore();
    });
    return { at: at, end: at + len, cues: declare(o, 'speedLines', [[at, 'whoosh', 0.7]]) };
  };
  /** A full-frame flash for a frame or two (the frame a slam lands on). No cue of its own. */
  var flash = function (o) {
    o = o || {};
    var at = num(o.at, 0), white = make('div', 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;opacity:0;background:' + (o.color || '#ffffff') + ';', o.on ? one(o.on) : document.body);
    on(function (t, fps) { var f = (t - at) * fps; white.style.opacity = f >= -0.5 && f < num(o.frames, 2) - 0.5 ? String(num(o.opacity, 0.85) * (f < 0.5 ? 1 : 0.45)) : '0'; });
    return { at: at, end: at + num(o.frames, 2) / 30, cues: [] };
  };
  /**
   * Bars that follow a sound: `envelope` is a list of levels 0..1, `rate` of them a second (the envelope the sound
   * side gives, or one written by hand). Each bar reads the envelope a little apart and is smoothed, so that the row
   * moves like a spectrum. Ambient: no cue.
   */
  var bars = function (target, envelope, o) {
    o = o || {};
    var host = one(target), n = Math.round(num(o.count, 24)), rate = num(o.rate, 30), seed = num(o.seed, 4), list = [];
    if (!host) return { cues: [] };
    host.style.display = 'flex'; host.style.alignItems = o.align || 'flex-end'; host.style.gap = px(num(o.gap, 4));
    for (var i = 0; i < n; i++) list.push(make('div', 'flex:1;height:100%;transform-origin:' + (o.align === 'center' ? 'center' : 'bottom') + ';border-radius:' + px(num(o.radius, 3)) + ';background:' + (o.color || 'currentColor') + ';', host));
    var level = function (t) { var k = t * rate, a = Math.floor(k); if (!envelope || !envelope.length || a < 0) return 0; var v0 = num(envelope[Math.min(envelope.length - 1, a)], 0), v1 = num(envelope[Math.min(envelope.length - 1, a + 1)], 0); return mix(v0, v1, k - a); };
    on(function (t) {
      list.forEach(function (b, j) {
        var mid = 1 - Math.abs(j - (n - 1) / 2) / (n / 2), v = level(t - hash(j, seed) * 0.06) * (0.45 + 0.55 * mid) * (0.7 + 0.3 * (noise(t * 9 + j * 3.1, seed) * 0.5 + 0.5));
        b.style.transform = 'scaleY(' + r3(Math.max(num(o.floor, 0.04), clamp01(v))) + ')';
      });
    });
    return { cues: [] };
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Camera and distortion
  // ---------------------------------------------------------------------------------------------------------------
  /** A camera shake that dies away: smooth noise, the same on every render. amount in pixels. Cue: rumble. */
  var shake = function (target, o) {
    o = o || {};
    var el = one(target), at = num(o.at, 0), len = num(o['for'], 0.4), amount = num(o.amount, 12), freq = num(o.frequency, 28), seed = num(o.seed, 13), key = newKey('shake');
    on(function (t) {
      var u = progress(t, at, len), k = u <= 0 || u >= 1 ? 0 : Math.pow(1 - u, num(o.decay, 2)) * amount;
      put(el, key, { x: noise(t * freq, seed) * k, y: noise(t * freq, seed + 7) * k, rotate: noise(t * freq, seed + 19) * k * num(o.rotate, 0.04) });
    });
    return { at: at, end: at + len, cues: declare(o, 'shake', [[at, 'rumble', 0.6]]) };
  };
  /**
   * A glitch: the element is copied twice in red and cyan, moved apart, and slices of it jump sideways, in bursts.
   * amount in pixels. Cue: glitch.
   */
  var glitch = function (target, o) {
    o = o || {};
    var el = one(target), at = num(o.at, 0), len = num(o['for'], 0.4), amount = num(o.amount, 14), seed = num(o.seed, 17), rate = num(o.rate, 24), key = newKey('glitch');
    if (!el) return { at: at, end: at + len, cues: [] };
    var copies = [];
    whenShown(function () {
      copies = ['#ff2a6d', '#05d9e8'].map(function (colour) {
        var c = el.cloneNode(true); c.removeAttribute('id'); c.style.position = 'absolute'; c.style.left = el.offsetLeft + 'px'; c.style.top = el.offsetTop + 'px'; c.style.width = el.offsetWidth + 'px'; c.style.margin = '0';
        c.style.color = colour; c.style.mixBlendMode = 'screen'; c.style.pointerEvents = 'none'; c.style.display = 'none'; el.parentNode.insertBefore(c, el);
        return c;
      });
    });
    on(function (t) {
      var u = progress(t, at, len), live = u > 0 && u < 1, tick = Math.floor(t * rate), k = live ? (hash(tick, seed) > num(o.calm, 0.35) ? 1 : 0.15) * amount : 0;
      copies.forEach(function (c, i) {
        c.style.display = live && o.rgb !== false ? '' : 'none';
        put(c, key, { x: (i ? 1 : -1) * k * (0.3 + 0.7 * hash(tick, seed + 3 + i)), y: (hash(tick, seed + 9 + i) - 0.5) * k * 0.3, opacity: 0.85 });
      });
      // One slice of the element jumps: a band cut by clip-path, moved sideways.
      var top = hash(tick, seed + 21) * 80, h = 8 + hash(tick, seed + 22) * 22;
      el.style.clipPath = live && k > amount * 0.5 ? 'polygon(0 0,100% 0,100% ' + top + '%,' + (100 + k) + '% ' + top + '%,' + (100 + k) + '% ' + (top + h) + '%,100% ' + (top + h) + '%,100% 100%,0 100%)' : '';
      put(el, key, { x: live ? (hash(tick, seed + 30) - 0.5) * k * 0.5 : 0, skewX: live ? (hash(tick, seed + 31) - 0.5) * k * 0.4 : 0 });
    });
    return { at: at, end: at + len, cues: declare(o, 'glitch', [[at, 'glitch', 0.7]]) };
  };
  /**
   * Layers at different depths under one camera move: a layer of depth 0 does not move, depth 1 moves by the whole
   * amount, depth 2 twice as far (in front). M.parallax([{ el: '#sky', depth: 0.2 }, { el: '#hills', depth: 0.6 }], {
   * to: [-200, 0], zoom: 1.08, for: 4 }). A move over the whole shot is an ambient layer: no cue unless cue is set.
   */
  var parallax = function (list, o) {
    o = o || {};
    var at = num(o.at, 0), len = num(o['for'], 3), e = ease(o.ease || 'sine.inOut'), from = o.from || [0, 0], to = o.to || [-120, 0], key = newKey('parallax');
    var ls = list.map(function (x) { return { el: one(x.el), depth: num(x.depth, 1) }; });
    on(function (t) {
      var p = e(progress(t, at, len));
      ls.forEach(function (x) { put(x.el, key, { x: mix(from[0], to[0], p) * x.depth, y: mix(from[1], to[1], p) * x.depth, scale: 1 + (mix(num(o.zoomFrom, 1), num(o.zoom, 1), p) - 1) * x.depth }); });
    });
    return { at: at, end: at + len, cues: o.cue ? declare(o, 'parallax', [[at, 'whoosh', 0.4]]) : [] };
  };
  /** A slow drift for a ground or a prop that must not stand dead still: smooth noise, small. Never on a title. Ambient: no cue. */
  var drift = function (target, o) {
    o = o || {};
    var els = all(target), amount = num(o.amount, 8), period = num(o.period, 5), seed = num(o.seed, 23), key = newKey('drift');
    on(function (t) {
      els.forEach(function (el, i) {
        put(el, key, { x: noise(t / period + i * 3.7, seed) * amount, y: noise(t / period + i * 5.3, seed + 5) * amount, rotate: noise(t / period + i * 1.9, seed + 11) * num(o.rotate, 0), scale: 1 + noise(t / period + i, seed + 13) * num(o.scale, 0) });
      });
    });
    return { cues: [] };
  };
  /** A steady turn: degrees a second, for a wheel, a ray, a loader. Ambient: no cue. */
  var spin = function (target, o) {
    o = o || {};
    var els = all(target), key = newKey('spin');
    on(function (t) { els.forEach(function (el, i) { put(el, key, { rotate: num(o.speed, 90) * (t - num(o.at, 0)) * (o.alternate && i % 2 ? -1 : 1) }); }); });
    return { cues: [] };
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Reveals and surfaces
  // ---------------------------------------------------------------------------------------------------------------
  /**
   * Reveals (or hides, with out: true) an element by a moving edge: kind 'left', 'right', 'up', 'down', 'circle'
   * (from a point, at: [x%, y%]), 'iris' (a circle from the centre), 'diagonal', 'blinds' (count bands). Cue: whoosh.
   */
  var wipe = function (target, o) {
    o = o || {};
    var els = all(target), at = num(o.at, 0), len = num(o['for'], 0.6), e = ease(o.ease || 'power3.inOut'), kind = o.kind || 'left', n = Math.round(num(o.count, 8)), c = o.centre || [50, 50];
    var shape = function (p) {
      var q = (p * 100).toFixed(2), i, pts;
      if (kind === 'right') return 'inset(0 0 0 ' + (100 - p * 100).toFixed(2) + '%)';
      if (kind === 'up') return 'inset(' + (100 - p * 100).toFixed(2) + '% 0 0 0)';
      if (kind === 'down') return 'inset(0 0 ' + (100 - p * 100).toFixed(2) + '% 0)';
      if (kind === 'circle' || kind === 'iris') return 'circle(' + (p * 150).toFixed(2) + '% at ' + (kind === 'iris' ? 50 : c[0]) + '% ' + (kind === 'iris' ? 50 : c[1]) + '%)';
      if (kind === 'diagonal') return 'polygon(0 0,' + (p * 200).toFixed(2) + '% 0,0 ' + (p * 200).toFixed(2) + '%)';
      if (kind === 'blinds') { pts = []; for (i = 0; i < n; i++) { var y0 = (i * 100) / n, y1 = y0 + (100 / n) * p; pts.push('0 ' + y0 + '%,100% ' + y0 + '%,100% ' + y1 + '%,0 ' + y1 + '%,0 ' + y0 + '%'); } return 'polygon(evenodd,' + pts.join(',') + ')'; }
      return 'inset(0 ' + (100 - Number(q)).toFixed(2) + '% 0 0)';
    };
    on(function (t) {
      var p = e(progress(t, at, len));
      els.forEach(function (el) { el.style.clipPath = shape(o.out ? 1 - p : p); });
    });
    return { at: at, end: at + len, cues: declare(o, 'wipe', [[at, 'whoosh', 0.55]]) };
  };
  /** A band of light that sweeps over an element once (its text or its surface). Cue: shimmer. */
  var shimmer = function (target, o) {
    o = o || {};
    var els = all(target), at = num(o.at, 0), len = num(o['for'], 0.8), e = ease(o.ease || 'power2.inOut'), angle = num(o.angle, 110), width = num(o.width, 18);
    var sheens = [];
    whenShown(function () {
      sheens = els.map(function (el) {
        if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
        el.style.overflow = 'hidden';
        return make('div', 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;mix-blend-mode:' + (o.blend || 'screen') + ';', el);
      });
    });
    on(function (t) {
      var u = progress(t, at, len), p = e(u) * (100 + 2 * width) - width, a = u > 0 && u < 1 ? num(o.opacity, 0.7) : 0;
      sheens.forEach(function (s) { s.style.background = 'linear-gradient(' + angle + 'deg, transparent ' + (p - width) + '%, ' + (o.color || 'rgba(255,255,255,' + a + ')') + ' ' + p + '%, transparent ' + (p + width) + '%)'; s.style.opacity = a ? '1' : '0'; });
    });
    return { at: at, end: at + len, cues: declare(o, 'shimmer', [[at + len * 0.3, 'shimmer', 0.45]]) };
  };
  /**
   * Goo: the shapes inside an element melt into one another where they come close (a blur and a hard alpha step, as
   * an SVG filter). Move the shapes with any effect; the joins follow. Returns the filter's id. No cue.
   */
  var goo = function (target, o) {
    o = o || {};
    var el = one(target), id = 'popost-goo-' + (keyCount++), blurAmount = num(o.blur, 12);
    var svg = make('svg', 'position:absolute;width:0;height:0;', document.body, true);
    svg.innerHTML = '<defs><filter id="' + id + '" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceGraphic" stdDeviation="' + blurAmount + '" result="b"/>'
      + '<feColorMatrix in="b" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 ' + num(o.sharp, 22) + ' ' + -num(o.cut, 9) + '" result="g"/>' + (o.keep === false ? '' : '<feComposite in="SourceGraphic" in2="g" operator="atop"/>') + '</filter></defs>';
    if (el) el.style.filter = 'url(#' + id + ')';
    return { id: id, cues: [] };
  };
  /**
   * Motion blur on a canvas by drawing the moments between two frames on top of one another: draw(ctx, seconds) is
   * called `samples` times across the shutter (a share of the frame's time, 0.5 is a film camera's) with the alpha
   * that makes them add up. Use it for a fast mover drawn on a canvas; DOM elements take put(..., { blur }).
   */
  var motionBlur = function (target, draw, o) {
    o = o || {};
    var canvas = one(target), n = Math.max(1, Math.round(num(o.samples, 8))), shutter = num(o.shutter, 0.5);
    if (!canvas) return { cues: [] };
    var ctx = canvas.getContext('2d'), buffer = document.createElement('canvas');
    buffer.width = canvas.width; buffer.height = canvas.height;
    var bctx = buffer.getContext('2d');
    on(function (t, fps) {
      if (!canvas.width || !canvas.height) return;
      if (buffer.width !== canvas.width || buffer.height !== canvas.height) { buffer.width = canvas.width; buffer.height = canvas.height; }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (var i = 0; i < n; i++) {
        bctx.clearRect(0, 0, buffer.width, buffer.height);
        draw(bctx, t - (shutter / fps) * (i / n));
        // Sample i gets 1 / (i + 1): the running mean of all samples drawn so far.
        ctx.globalAlpha = 1 / (i + 1);
        ctx.drawImage(buffer, 0, 0);
      }
      ctx.globalAlpha = 1;
    });
    return { cues: [] };
  };

  window.popostMotion = {
    version: 1, CUES: CUES, problems: problems,
    clamp: clamp, clamp01: clamp01, mix: mix, progress: progress, rng: rng, hash: hash, noise: noise, noise2: noise2,
    ease: ease, spring: spring, stepped: stepped, bouncePath: bouncePath, offsets: offsets,
    on: on, whenShown: whenShown, cue: cue, cues: function () { return scene.cues.slice(); }, put: put, layer: layer, split: split,
    tween: tween, pop: pop, slam: slam, stagger: stagger, gridReveal: gridReveal, kinetic: kinetic, typeOn: typeOn, scramble: scramble, counter: counter,
    drawOn: drawOn, morph: morph, follow: follow, bounce: bounce, trail: trail,
    burst: burst, confetti: confetti, sparks: sparks, shockwave: shockwave, sunburst: sunburst, speedLines: speedLines, flash: flash, bars: bars,
    shake: shake, glitch: glitch, parallax: parallax, drift: drift, spin: spin, wipe: wipe, shimmer: shimmer, goo: goo, motionBlur: motionBlur
  };
})();
