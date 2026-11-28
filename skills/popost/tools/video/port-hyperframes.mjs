// Maintainer tool (not part of the CLI, not shipped in the npm package): ports the blocks and components of the
// HyperFrames registry (https://github.com/heygen-com/hyperframes, Apache-2.0, Copyright 2026 HeyGen, Inc.) into
// example scenes of the popost Skill, and writes the catalogue of every example.
//
//   node skills/popost/tools/video/port-hyperframes.mjs --hyperframes <checkout> [--only name,name] [--no-browser]
//   node skills/popost/tools/video/port-hyperframes.mjs --catalogue-only        # re-read the examples, no checkout
//
// What it does for every registry item (a component's demo.html, a block's own page):
//   1. refuses what cannot run on the Skill's clock or without the network, with the reason (SKIP below);
//   2. rewrites the page into a scene: GSAP and three.js from ../lib/, no web fonts, pictures as slots with a drawn
//      stand-in, seeded random numbers, no CSS transitions, the composition scaled into any canvas, the HyperFrames
//      variables as declared parameters, clips shown and hidden from the scene's time;
//   3. opens it in Chrome, reads the length of its timelines and derives its sound cues from its tweens (CUE RULES);
//      leaves out what tools/video/verify-examples.ts found not to draw in the renderer (hyperframes-unverified.json);
//   4. writes assets/video/examples/hf/<name>.html with a header that names the source, the licence and the changes.
// Then it reads every example of assets/video/examples (the Skill's own too), writes catalogue.json and
// references/video-effects.md.
//
// A ported file is checked by the Skill's own tests (tests/video/scene-catalogue.test.ts: lint, parameters,
// determinism of a sample) and by `popost video scene check`.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const skill = path.resolve(here, '../..');
const examplesDir = path.join(skill, 'assets/video/examples');
const outDir = path.join(examplesDir, 'hf');
const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] ?? ''; };
const flag = (name) => process.argv.includes(name);

const MAX_BYTES = 400 * 1024;
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
const STAND_IN = 'linear-gradient(135deg, #3d5a80, #98c1d9)';

// ---------------------------------------------------------------------------------------------------------------------
// Classes: one per entry, from the registry item's tags and name, the first rule that fits.
// ---------------------------------------------------------------------------------------------------------------------
const CLASS_RULES = [
  ['caption', /^(caption|captions|subtitle|karaoke|lower|lt)$/],
  ['3d', /^(3d|three|webgl|extrude|extruded|cuboid|turntable|tilt|perspective|orbit|orbiting)$/],
  ['cursor', /^(cursor|cursors|pointer|touch|gesture|tap|drag|marquee)$/],
  ['chart', /^(chart|charts|graph|heatmap|map|maps|count|counter|number|numbers|stat|stats|progress|geography|ticker|race|flowchart|pipeline|usage|rating)$/],
  ['particles', /^(particle|particles|confetti|snow|starfield|burst|spark|sparks|shatter|destruction|explode)$/],
  ['transition', /^(transition|transitions|wipe|whip|iris|curtain|slide|axis|through|cut|swap|morphing|dissolve|reveal)$/],
  ['logo', /^(logo|wordmark|brand|outro|intro|cta|lockup|badge|sting|titlecard)$/],
  ['audio', /^(beat|waveform|audio|oscilloscope|podcast)$/],
  ['camera', /^(camera|parallax|dolly|rack|push|pull|zoom|pan|focus|shake|rig|scroll)$/],
  ['background', /^(background|bg|gradient|noise|aurora|plasma|ambient|texture|grain|leak|godrays|vignette|shader|field|drift)$/],
  ['ui', /^(ui|mock|notification|notifications|chat|message|thread|social|post|card|cards|device|browser|menu|modal|toggle|tabs|sheet|terminal|code|app|signup|onboarding|settings|input|skeleton|feed|stepper|follow|comment|share|spotify|reddit|slack|macos|ios26|instagram|tiktok|x|yt)$/],
  ['overlay', /^(overlay|annotation|annotate|highlight|callout|hw|handwritten|marker|underline|label|hud|scan|separator|whiteboard|vox)$/],
  ['shape', /^(morph|path|svg|stroke|draw|blob|goo|gooey|loader|ring|icon|facet|outline|trace|tracing)$/],
  ['text', /^(typography|text|type|typed|title|letters|headline|kinetic|word|scramble|typewriter|typing|caret|line|stagger|streaming|decode|shimmer|blur|tracking|variable)$/],
];
// Tags that say how an item was made, not what it shows.
const NOISE = /^(motion|primitive|video|dev|port|showcase|deterministic|hyperframes|native|holdable|slots|slot|effect|effects|minimal|experiment|prop|props|images|gallery|vertical|creator|loop|loopable)$/;
const classOf = (item) => {
  const tokens = (text) => text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && !NOISE.test(t));
  // The name says most; the tags decide when the name does not.
  for (const hay of [tokens(item.name), tokens((item.tags ?? []).filter((t) => !/transition-primitive|transitions-dev-port|motion-primitive|video-primitive/.test(t)).join(' '))])
    for (const [name, re] of CLASS_RULES) if (hay.some((t) => re.test(t))) return name;
  return 'motion';
};

// ---------------------------------------------------------------------------------------------------------------------
// What is refused, with the reason the catalogue gives.
// ---------------------------------------------------------------------------------------------------------------------
const SKIP = [
  [/<video\b/i, 'shows footage in a <video>, which a scene cannot hold: place footage as a video item over a scene (references/video-scenes.md, "Footage inside a scene")'],
  [/<audio\b/i, 'plays sound in the page: sound belongs to the project (its cues say where)'],
  [/data-shader=|shaders\.iife\.js|navigator\.gpu/i, 'a WebGPU shader of a third-party library (1.4 MB): WebGPU is not available to the renderer, and the library is not shipped'],
  [/liquid-glass\.iife\.js|surface\.js|shadows\.js|glass-main\.js|frost\.js|caveat-pen\.js/i, 'needs a bundled script of its own (a WebGL or path library built for this block), which is not shipped'],
  [/<script[^>]+type=["']module["']|\bimport\s*\(|^\s*import\s.+from\s/m, 'is written as JavaScript modules loaded from the network'],
  [/topojson|d3-delaunay|clipper|lottie|GLTFLoader|DRACOLoader|EffectComposer|UnrealBloomPass/i, 'needs a library the Skill does not supply (map data, Lottie, glTF or post-processing loaders)'],
  [/\brequestAnimationFrame\s*\(/, 'draws from requestAnimationFrame, on the real clock'],
  [/\b(?:setTimeout|setInterval)\s*\(/, 'uses timers, on the real clock'],
  [/\b(?:Date\.now|performance\.now)\s*\(|\bnew\s+Date\s*\(/, 'reads the real clock'],
  [/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\b/, 'loads data from the network at run time'],
  [/data-composition-src=/, 'mounts a composition file in a way the port does not inline (a host with content, or several levels)'],
  [/<iframe\b|<object\b|<embed\b/i, 'embeds another page'],
];

// ---------------------------------------------------------------------------------------------------------------------
// The rewrite.
// ---------------------------------------------------------------------------------------------------------------------
const stripComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

/** Lines of a script that are only a comment and name something the scene lint looks for. */
const stripFlaggedComments = (html) =>
  html.replace(/^[ \t]*(?:\/\/|\*|\/\*).*\b(?:setTimeout|setInterval|requestAnimationFrame|Date\.now|performance\.now|Math\.random|fetch|XMLHttpRequest|transition\s*:|parent\.|top\.)[^\n]*\n/gm, '');

const paramOf = (v) => {
  const what = (v.description || v.label || v.id).replace(/\s+/g, ' ').trim();
  if (v.type === 'enum') return { name: v.id, type: 'choice', default: v.default, options: (v.options ?? []).map((o) => (typeof o === 'object' ? o.value : o)), what };
  if (v.type === 'number') return { name: v.id, type: 'number', default: v.default ?? 0, min: v.min ?? -100000, max: v.max ?? 100000, ...(v.unit ? { unit: v.unit } : {}), what };
  if (v.type === 'boolean') return { name: v.id, type: 'choice', default: String(v.default ?? false), options: ['true', 'false'], what };
  if (v.type === 'color') return { name: v.id, type: 'colour', default: v.default ?? '#ffffff', what };
  return { name: v.id, type: 'text', default: v.default ?? '', maxLength: v.maxLength ?? 200, what };
};

const SHIM = (native, given = {}, starts = []) => `<script>
  /* popost: the scene's parameters stand in for HyperFrames variables; random numbers are seeded; the composition is
     scaled into the canvas; clips are shown and hidden from the scene's time. */
  (function () {
    var block = document.getElementById('popost-params');
    var values = block ? (JSON.parse(block.textContent).values || {}) : {};
    var vars = ${JSON.stringify(given)};
    Object.keys(values).forEach(function (k) { if (k !== 'fit') vars[k] = values[k] === 'true' ? true : values[k] === 'false' ? false : values[k]; });
    window.__hyperframes = { getVariables: function () { return vars; } };
    var seed = 20240229;
    window.__popostRandom = function () { seed = (seed + 0x6d2b79f5) >>> 0; var t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    window.__popostFit = function () {
      // The canvas, from the size this file declares: a scene of a later shot loads in a layer that is not displayed, where the page measures 0.
      var size = /width: (\\d+)px; height: (\\d+)px;/.exec(document.getElementById('popost-fit').textContent);
      var W = ${native[0]}, H = ${native[1]}, s = document.getElementById('popost-stage'), cw = Number(size[1]), ch = Number(size[2]);
      var k = (values.fit === 'cover' ? Math.max : Math.min)(cw / W, ch / H);
      s.style.transform = 'translate(' + (cw - W * k) / 2 + 'px,' + (ch - H * k) / 2 + 'px) scale(' + k + ')';
      var clips = Array.prototype.slice.call(s.querySelectorAll('.clip[data-start]')).filter(function (c) { return isFinite(parseFloat(c.getAttribute('data-start'))) && c.parentNode !== s; });
      // A mounted composition that starts later in its host runs on its own time.
      ${JSON.stringify(starts)}.forEach(function (m) {
        var tl = window.__timelines && window.__timelines[m.id];
        if (tl) window.__timelines[m.id] = { pause: function () { tl.pause(); }, seek: function (t) { tl.seek(Math.max(0, t - m.start)); }, duration: function () { return tl.duration() + m.start; } };
      });
      var scene = (window.__popostScene = window.__popostScene || {}), before = scene.render;
      scene.render = function (seconds, fps) {
        if (before) before(seconds, fps);
        for (var i = 0; i < clips.length; i++) {
          var a = parseFloat(clips[i].getAttribute('data-start')), d = parseFloat(clips[i].getAttribute('data-duration'));
          clips[i].style.visibility = seconds >= a && (!isFinite(d) || seconds < a + d) ? 'visible' : 'hidden';
        }
      };
    };
  })();
</script>`;

const header = (kind, name, commit, changes) => `<!--
  Adapted from HyperFrames (https://github.com/heygen-com/hyperframes), registry/${kind}/${name}, commit ${commit}.
  Copyright 2026 HeyGen, Inc. Licensed under the Apache License, Version 2.0; the licence text is in the popost
  Skill's THIRD_PARTY_NOTICES. Changed for the popost Skill (tools/video/port-hyperframes.mjs): ${changes.join('; ')}.
-->`;

/** A registry item as a scene, or why not. */
const convert = (item, kind, html, commit, sibling) => {
  let s = stripFlaggedComments(stripComments(html));
  const changes = ['its comments removed'];
  const placeholders = [];
  // A host that mounts another composition file (data-composition-src) gets that file's <template> put inside it,
  // with the values the host gives its variables.
  const mounts = [], mounted = [];
  let missing;
  s = s.replace(/<([a-z0-9]+)\b([^>]*\bdata-composition-src=["']([^"']+)["'][^>]*)>\s*<\/\1>/gi, (tag, el, attrs, src) => {
    const sub = sibling(src);
    if (!sub) { missing = src; return tag; }
    const cleaned = stripFlaggedComments(stripComments(sub));
    const inner = /<template[^>]*>([\s\S]*)<\/template>/i.exec(cleaned)?.[1] ?? /<body[^>]*>([\s\S]*)<\/body>/i.exec(cleaned)?.[1];
    if (!inner) { missing = src; return tag; }
    let declared = [], given = {};
    try { declared = JSON.parse(/data-composition-variables='([^']*)'/.exec(cleaned)?.[1] ?? '[]'); } catch { declared = []; }
    try { given = JSON.parse(/data-variable-values='([^']*)'/.exec(attrs)?.[1] ?? '{}'); } catch { given = {}; }
    mounts.push({ id: /data-composition-id=["']([^"']+)["']/.exec(attrs)?.[1] ?? '', start: Number(/data-start=["']([\d.]+)["']/.exec(attrs)?.[1] ?? 0), declared, given, raw: /data-composition-variables='([^']*)'/.exec(cleaned)?.[1] });
    mounted.push(src.replace(/^\.\//, ''));
    return '<' + el + attrs.replace(/\sdata-composition-src=["'][^"']*["']/, '') + '>' + inner + '</' + el + '>';
  });
  if (missing) return { skip: 'mounts ' + missing + ', which has no template to put in' };
  if (mounts.length) changes.push('the composition' + (mounts.length > 1 ? 's' : '') + ' it mounts (' + mounted.join(', ') + ') put into the page');
  // One mounted composition reads its declared variables from the page's root element.
  if (mounts.length === 1 && mounts[0].raw && !/<html[^>]*data-composition-variables/i.test(s)) s = s.replace(/<html\b/i, "<html data-composition-variables='" + mounts[0].raw + "'");
  for (const [re, reason] of SKIP) if (re.test(s)) return { skip: reason };
  if (!/<html[\s>]/i.test(s)) { s = '<!doctype html>\n<html><head><meta charset="utf-8"></head>\n<body>\n' + s + '\n</body></html>'; changes.push('wrapped into a whole page'); }
  // Libraries from the project, never from the network.
  let external = false;
  s = s.replace(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>/gi, (tag, src) => {
    if (/gsap(?:@[\d.]+)?\/dist\/gsap\.min\.js|gsap-[\d.]+\.min\.js/.test(src)) return '<script src="../lib/gsap.min.js"></script>';
    if (/three@0\.147\.0\/build\/three\.min\.js/.test(src)) return '<script src="../lib/three.min.js"></script>';
    external = true;
    return tag;
  });
  if (external) return { skip: 'loads a script the Skill does not supply' };
  changes.push('GSAP loaded from the project (../lib/gsap.min.js) instead of a CDN');
  if (/<link\b[^>]*>/i.test(s) || /@import\b/i.test(s)) { placeholders.push('web fonts are replaced by the fonts of the machine'); changes.push('web font links removed'); }
  s = s.replace(/<link\b[^>]*>\s*/gi, '').replace(/@import\s+url\([^)]*\)[^;]*;\s*/gi, '').replace(/@import\s+["'][^"']*["'][^;]*;\s*/gi, '');
  // Pictures become slots with a drawn stand-in.
  let pictures = 0;
  s = s.replace(/<img\b([^>]*?)\bsrc=["']([^"']*)["']([^>]*)>/gi, (tag, a, src, b) => {
    if (src.startsWith('data:')) return tag;
    pictures++;
    const rest = (a + b).replace(/\bdata-slot=["'][^"']*["']/i, '');
    const styled = /\bstyle=["']/i.test(rest) ? rest.replace(/\bstyle=["']/i, (m) => m + 'background: ' + STAND_IN + '; ') : rest + ' style="background: ' + STAND_IN + ';"';
    return '<img' + styled + ' src="' + PIXEL + '" data-slot="picture-' + pictures + '">';
  });
  let urls = 0;
  s = s.replace(/url\(\s*(["']?)([^)"']+)\1\s*\)/gi, (m, _q, u) => { if (u.startsWith('#') || u.startsWith('data:')) return m; urls++; return STAND_IN; });
  if (pictures || urls) { placeholders.push((pictures ? pictures + ' picture' + (pictures === 1 ? '' : 's') + ' as slots (picture-1 ...) with a drawn stand-in' : '') + (pictures && urls ? ', ' : '') + (urls ? urls + ' CSS picture' + (urls === 1 ? '' : 's') + ' as a gradient' : '')); changes.push('pictures replaced by slots and drawn stand-ins'); }
  if (/["'`][^"'`\n]*\.(?:jpe?g|png|webp|avif|gif|mp4|webm|mov|mp3|wav|ogg|woff2?|ttf|otf|glb|gltf|hdr)["'`]|__hyperframes\.assetUrl/i.test(s)) return { skip: 'loads picture, footage, sound or font files from its script or its data (material the Skill does not ship)' };
  if (/\bsrc\s*=\s*["']?\s*(?:https?:)?\/\//i.test(s) || /\bhref\s*=\s*["']?\s*(?:https?:)?\/\//i.test(s)) return { skip: 'still loads something from the network after the rewrite' };
  if (/\bMath\.random\s*\(/.test(s)) { s = s.replace(/\bMath\.random\s*\(/g, 'window.__popostRandom('); changes.push('Math.random replaced by a seeded generator'); }
  if (/\btransition\s*:/i.test(s)) { s = s.replace(/(^|[;{\s"'`])transition(?:-[a-z-]+)?\s*:[^;}"'`]*;?/gi, '$1'); changes.push('CSS transitions removed'); }
  if (/(?<![.\w$])(?:window\.)?(?:parent|top|opener)\s*\.|\bwindow\.open\s*\(|(?<![.\w$])(?:window\.|document\.)?location\s*(?:\.\s*\w+\s*)?=[^=]/.test(s)) return { skip: 'its script uses a name the scene lint reserves (parent, top, location)' };
  // The composition's own size, from the registry item or its root.
  const w = Number(/data-width=["'](\d+)["']/.exec(s)?.[1] ?? item.dimensions?.width ?? 1920), h = Number(/data-height=["'](\d+)["']/.exec(s)?.[1] ?? item.dimensions?.height ?? 1080);
  const params = [{ name: 'fit', type: 'choice', default: 'contain', options: ['contain', 'cover'], what: 'how the ' + w + 'x' + h + ' composition is fitted into the canvas: whole with bars, or filling it and cropped' }, ...[...(item.variables ?? []), ...mounts.flatMap((m) => m.declared.map((v) => ({ ...v, default: m.given[v.id] ?? v.default })))].filter((v, i, list) => v && v.id && v.id !== 'fit' && list.findIndex((x) => x.id === v.id) === i).map(paramOf)];
  const given = Object.assign({}, ...mounts.map((m) => m.given));
  const starts = mounts.filter((m) => m.id && m.start > 0).map((m) => ({ id: m.id, start: m.start }));
  // "transition:" in a sentence would read as a CSS transition to the scene lint.
  const about = (item.description || item.title || item.name).replace(/\s+/g, ' ').replace(/\btransition\s*:/gi, 'transition,').trim();
  const block = (extra) => '<script type="application/json" id="popost-params">\n' + JSON.stringify({ about, class: classOf(item), ...(item.tags?.length ? { tags: item.tags } : {}), ...(placeholders.length ? { placeholders: placeholders.join('; ') } : {}), ...extra, params }, null, 1) .replace(/\n}$/, ',\n "values": {}\n}') + '\n</script>';
  const body = /<body([^>]*)>([\s\S]*)<\/body>/i.exec(s);
  if (!body) return { skip: 'has no body' };
  const fitCss = '<style id="popost-fit">\n  html, body { margin: 0 !important; width: 1280px; height: 720px; overflow: hidden !important; background: #000000; }\n  #popost-stage { position: absolute; left: 0; top: 0; width: ' + w + 'px; height: ' + h + 'px; transform-origin: 0 0; overflow: hidden; }\n</style>';
  const page = (extra) => s.replace(/<\/head>/i, fitCss + '\n' + block(extra) + '\n' + SHIM([w, h], given, starts) + '\n</head>')
    .replace(body[0], '<body' + body[1] + '>\n<div id="popost-stage">' + body[2] + '</div>\n<script>window.__popostFit();</script>\n</body>')
    .replace(/^\s*<!doctype html>/i, '<!doctype html>\n' + header(kind, item.name, commit, [...changes, 'the ' + w + 'x' + h + ' composition scaled into the scene\'s canvas (parameter "fit")', 'HyperFrames variables declared as parameters', 'its clips shown and hidden from the scene\'s time', 'sound cues derived from its tweens']));
  changes.push('scaled into the canvas');
  if (!/<\/head>/i.test(s) || !/^\s*<!doctype html>/i.test(s)) return { skip: 'is not a whole page with a head' };
  return { page, about, class: classOf(item), params: params.map((p) => p.name), placeholders: placeholders.join('; '), tags: item.tags ?? [] };
};

// ---------------------------------------------------------------------------------------------------------------------
// CUE RULES: where a sound belongs, from the tweens of a GSAP timeline (references/video-motion.md, "Sound cues").
// Runs in the page.
// ---------------------------------------------------------------------------------------------------------------------
const READ_PAGE = () => {
  const timelines = Object.values(window.__timelines || {}).concat(window.__popostScene && window.__popostScene.timeline ? [window.__popostScene.timeline] : []);
  const cues = [];
  let seconds = 0, first = Infinity;
  const numberOf = (v) => (typeof v === 'number' ? v : typeof v === 'string' && /^-?[\d.]+/.test(v) ? parseFloat(v) : undefined);
  for (const tl of timelines) {
    if (!tl || typeof tl.duration !== 'function') continue;
    seconds = Math.max(seconds, tl.duration());
    if (typeof tl.getChildren !== 'function') continue;
    const groups = new Map();
    for (const tw of tl.getChildren(true, true, false)) {
      let at = tw.startTime(), p = tw.parent;
      while (p && p !== tl) { at = p.startTime() + at / (p.timeScale() || 1); p = p.parent; }
      if (tw.duration() > 0) first = Math.min(first, at);
      const v = tw.vars || {}, from = v.runBackwards ? v : v.startAt || {}, to = v.runBackwards ? {} : v, d = tw.duration();
      const ease = typeof v.ease === 'string' ? v.ease : '';
      const sFrom = numberOf(from.scale), sTo = numberOf(to.scale), far = Math.max(...['x', 'y'].map((k) => Math.abs((numberOf(to[k]) ?? 0) - (numberOf(from[k]) ?? 0))), ...['xPercent', 'yPercent'].map((k) => Math.abs((numberOf(to[k]) ?? 0) - (numberOf(from[k]) ?? 0)) * 4));
      const targets = typeof tw.targets === 'function' ? tw.targets().length : 1;
      let cue;
      if (sFrom !== undefined && sFrom >= 1.5 && d <= 0.35) cue = [at + d, 'impact', 0.9];
      else if (/back|elastic/.test(ease) && ((sFrom !== undefined && sFrom <= 0.6) || (sTo !== undefined && sTo > 1 && sTo <= 1.4))) cue = [at + 0.03, 'pop', 0.65];
      else if ('text' in to || 'scrambleText' in to) cue = [at, 'type', 0.3];
      else if ('drawSVG' in to || 'strokeDashoffset' in to || 'strokeDashoffset' in from) cue = [at, 'draw', 0.45];
      else if ('clipPath' in to || 'clipPath' in from || numberOf(from.scaleX) === 0 || numberOf(from.scaleY) === 0) cue = [at, 'swish', 0.45];
      else if (far >= 260 && d <= 0.9) cue = [at, 'whoosh', 0.5];
      else if (far >= 12 && far < 260 && (numberOf(from.opacity) === 0 || numberOf(from.autoAlpha) === 0) && d <= 0.9) cue = [at, 'tick', 0.3];
      if (!cue) continue;
      // The tweens of one stagger (the same moment to a few hundredths, or one call on many targets) are one group.
      const key = cue[1] + '@' + Math.round(cue[0] * 4);
      const g = groups.get(key) || { list: [], cue };
      g.list.push({ at: cue[0], n: targets });
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      const times = [...new Set(g.list.map((x) => Math.round(x.at * 100) / 100))].sort((a, b) => a - b);
      // Letters that arrive a few hundredths apart are typing, not a row of hits.
      const typed = times.length >= 6 && times[times.length - 1] - times[0] < times.length * 0.06;
      for (const t of typed ? times.filter((_t, i) => i % 3 === 0) : times.slice(0, 6)) cues.push({ at: t, cue: typed ? 'type' : g.cue[1], gain: typed ? 0.3 : g.cue[2] });
    }
  }
  if (window.__popostScene && Array.isArray(window.__popostScene.cues)) for (const c of window.__popostScene.cues) cues.push({ at: c.at, cue: c.cue, gain: c.gain });
  cues.sort((a, b) => a.at - b.at || b.gain - a.gain);
  // At most one cue of a kind in a tenth of a second, sixteen in all (the loudest stay).
  const kept = cues.filter((c, i) => !cues.slice(0, i).some((x) => x.cue === c.cue && Math.abs(x.at - c.at) < 0.1));
  const loudest = [...kept].sort((a, b) => b.gain - a.gain).slice(0, 16);
  if (!isFinite(first)) first = 0;
  return { first: Math.round(first * 100) / 100, seconds: Math.round(seconds * 100) / 100, timelines: timelines.length, cues: kept.filter((c) => loudest.includes(c)).map((c) => ({ at: Math.round(c.at * 1000) / 1000, cue: c.cue, gain: c.gain })) };
};

/**
 * An entry whose tweens gave no cue gets one from what it is, at the start of its first tween: the kind of sound its
 * name and class call for. A ground that only keeps moving (a background) gets none.
 */
const NAME_CUES = [
  [/glitch|rgb|aberration|matrix|decode|scramble/, 'glitch', 0.6], [/type|typing|typed|terminal|code|streaming|notes|prompt/, 'type', 0.35], [/slam|impact|shutter|stomp|explode|shatter/, 'impact', 0.85],
  [/confetti|burst|pop|badge|spring|bubble|emoji|notification|toast/, 'pop', 0.65], [/draw|ink|stroke|underline|circle|scribble|write|marker|trace|hw-|whiteboard/, 'draw', 0.45],
  [/click|tap|press|toggle|cursor|select|menu/, 'click', 0.5], [/count|number|chart|ticker|slot|wheel|flap|progress|rating/, 'tick', 0.35], [/shimmer|gloss|light|sweep|glow|flare|sheen|sparkle/, 'shimmer', 0.45],
  [/wipe|slide|transition|swipe|whip|curtain|push|pan|zoom|carousel|flip|reveal|through|swap|morph|shuffle|throw/, 'whoosh', 0.5],
];
const fallbackCues = (name, kind, first) => {
  if (kind === 'background') return [];
  const hit = NAME_CUES.find(([re]) => re.test(name)) ?? (kind === 'transition' || kind === 'camera' ? [null, 'whoosh', 0.5] : kind === 'text' || kind === 'caption' ? [null, 'tick', 0.3] : [null, 'swish', 0.4]);
  return [{ at: first, cue: hit[1], gain: hit[2] }];
};

const chromePath = () => [process.env.POPOST_CHROME, process.env.PLAYWRIGHT_CHROMIUM, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => p && existsSync(p));

const openBrowser = async () => {
  const exe = chromePath();
  if (!exe || flag('--no-browser')) return undefined;
  const { chromium } = await import('playwright-core');
  return chromium.launch({ executablePath: exe, args: ['--allow-file-access-from-files', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
};

/** Opens a scene file of a scratch project and reads its length and its cues; errors: what its scripts threw. */
const readPage = async (browser, file) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e).split('\n')[0]));
  page.on('requestfailed', (r) => errors.push('did not load: ' + r.url().split('/').pop()));
  try {
    await page.goto(pathToFileURL(file).href, { waitUntil: 'load', timeout: 20000 });
    const read = await page.evaluate(READ_PAGE);
    return { ...read, errors };
  } catch (e) {
    return { seconds: 0, timelines: 0, cues: [], errors: [...errors, String(e.message || e).split('\n')[0]] };
  } finally { await page.close(); }
};

// ---------------------------------------------------------------------------------------------------------------------
// The catalogue and its page.
// ---------------------------------------------------------------------------------------------------------------------
const CLASS_TITLES = {
  text: 'Text and kinetic type', caption: 'Captions and lower thirds', transition: 'Transitions', particles: 'Particles and VFX', '3d': '3D', background: 'Backgrounds and light',
  chart: 'Charts, numbers and maps', ui: 'UI mock-ups', logo: 'Logos, intros and closings', overlay: 'Overlays and annotations', audio: 'Audio-reactive', camera: 'Camera moves', shape: 'Shapes, paths and morphs',
  cursor: 'Cursors and touches', motion: 'Motion primitives',
};

const cueText = (cues) => (cues.length ? [...new Set(cues.map((c) => c.cue))].map((name) => name + ' ' + cues.filter((c) => c.cue === name).map((c) => c.at).slice(0, 4).join(', ') + (cues.filter((c) => c.cue === name).length > 4 ? ', ...' : '')).join('; ') : 'none');

const effectsPage = (catalogue, source) => {
  const L = ['# Effects catalogue', '',
    'GENERATED by `tools/video/port-hyperframes.mjs` from `assets/video/examples/catalogue.json`. Do not edit by hand.', '',
    'Every example scene of the Skill: ' + catalogue.entries.length + ' scenes, each seekable by time (a paused GSAP timeline handed to the engine, or `render(seconds)`), with declared parameters and declared sound cues. Find one, look at it, write it into the project:', '',
    '```bash', 'popost video scene example --search "bounce ball"            # entries that have every word, the best first; --class text narrows', 'popost video scene example <name> --sheet look/<name>.jpg   # a sheet of its frames, each with its time; no project needed',
    'popost video scene example <name> --set fit=cover --size 1080x1920 --out project/scenes/shot-03.html', 'popost video scene library project --name gsap             # the libraries the entry names: gsap, motion, three',
    'popost video scene check project && popost video scene cues project', '```', '',
    '- **Libraries**: `gsap` entries hand a paused GSAP timeline to the engine; `motion` entries draw with the Skill\'s motion helper; `three` entries draw lit 3D. Put each into the project once with `scene library`.',
    '- **Parameters**: `--set name=value`, checked against the entry\'s declaration (`popost video scene example <name>` prints them). `fit` (contain, cover) places a ported 1920x1080 composition into any canvas.',
    '- **Cues**: seconds from the start of the scene, by kind (`video-motion.md`, "Sound cues"). A ported entry\'s cues are derived from its tweens by rule; check them against its sheet.',
    '- **Stand-ins**: where the original loaded pictures or web fonts, the entry has slots (`picture-1` ...) with a drawn stand-in and uses the fonts of the machine. Give the slots your pictures in the fill (`"slots": {"picture-1": "../assets/a.webp"}`).',
    '- A ported entry is a starting point with the original\'s motion, not a finished shot: replace its sample text and colours with the reference\'s, and hold its sheet against the reference\'s frames.', ''];
  if (source) L.push('Ported entries come from the registry of [HyperFrames](https://github.com/heygen-com/hyperframes) at commit `' + source.commit + '` (Copyright 2026 HeyGen, Inc., Apache-2.0): ' + source.found + ' blocks, components and examples found, ' + source.ported + ' ported, ' + source.skipped + ' not ported (listed at the end with the reason). Each ported file names its source and the changes made.', '');
  const classes = [...new Set(catalogue.entries.map((e) => e.class))].sort((a, b) => Object.keys(CLASS_TITLES).indexOf(a) - Object.keys(CLASS_TITLES).indexOf(b));
  L.push('| Class | Entries |', '|---|---|', ...classes.map((c) => '| [' + (CLASS_TITLES[c] ?? c) + '](#' + (CLASS_TITLES[c] ?? c).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + ') (`' + c + '`) | ' + catalogue.entries.filter((e) => e.class === c).length + ' |'), '');
  for (const c of classes) {
    L.push('## ' + (CLASS_TITLES[c] ?? c), '', '| Name | What it shows | Seconds | Libraries | Parameters | Cues (seconds) |', '|---|---|---|---|---|---|');
    for (const e of catalogue.entries.filter((x) => x.class === c)) {
      const cell = (t) => String(t).replace(/\|/g, '/').replace(/\s+/g, ' ');
      L.push('| `' + e.name + '` | ' + cell(e.about.length > 180 ? e.about.slice(0, 177) + '...' : e.about) + (e.placeholders ? ' *Stand-ins: ' + cell(e.placeholders) + '.*' : '') + ' | ' + e.seconds + ' | ' + (e.libraries.join(', ') || '-') + ' | ' + (e.params.slice(0, 8).join(', ') + (e.params.length > 8 ? ', +' + (e.params.length - 8) : '') || '-') + ' | ' + cell(cueText(e.cues)) + ' |');
    }
    L.push('');
  }
  if (catalogue.skipped?.length) {
    L.push('## Not ported', '', 'Registry items that are not in the catalogue, with the reason. Their motion can still be re-made from the motion rulebook (`video-motion.md`).', '', '| Name | Class | Why not |', '|---|---|---|');
    for (const s of catalogue.skipped) L.push('| `' + s.name + '` | ' + s.class + ' | ' + s.reason.replace(/\|/g, '/') + ' |');
    L.push('');
  }
  return L.join('\n');
};

const librariesOf = (html) => [...new Set([...html.matchAll(/<script\b[^>]*\bsrc=["']\.\.\/lib\/([^"']+)["']/gi)].map((m) => ({ 'gsap.min.js': 'gsap', 'popost-motion.js': 'motion', 'three.min.js': 'three', 'popost-screen.js': 'screen' })[m[1]]).filter(Boolean))];

const scratchProject = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'popost-port-'));
  await mkdir(path.join(dir, 'scenes'), { recursive: true });
  await mkdir(path.join(dir, 'lib'), { recursive: true });
  const modules = [path.join(skill, 'node_modules'), path.join(skill, '../../node_modules')];
  const find = (rel) => modules.map((m) => path.join(m, rel)).find((p) => existsSync(p));
  const gsap = find('gsap/dist/gsap.min.js'), three = find('three/build/three.min.js');
  if (gsap) await copyFile(gsap, path.join(dir, 'lib/gsap.min.js'));
  if (three) await copyFile(three, path.join(dir, 'lib/three.min.js'));
  await copyFile(path.join(skill, 'assets/video/motion.js'), path.join(dir, 'lib/popost-motion.js'));
  return dir;
};

const main = async () => {
  const checkout = arg('--hyperframes');
  const only = arg('--only')?.split(',');
  const browser = await openBrowser();
  const scratch = await scratchProject();
  const previous = existsSync(path.join(examplesDir, 'catalogue.json')) ? JSON.parse(await readFile(path.join(examplesDir, 'catalogue.json'), 'utf8')) : { entries: [], skipped: [] };
  const ported = [], skipped = [];
  // What tools/video/verify-examples.ts found not to draw as the scene of a later shot, with the reason: left out.
  const unverifiedFile = path.join(here, 'hyperframes-unverified.json');
  const unverified = existsSync(unverifiedFile) ? JSON.parse(await readFile(unverifiedFile, 'utf8')) : {};
  const REASONS = [
    [/^the same picture/, 'draws nothing that moves when it is the scene of a later shot: it measures its layout while it loads, before the page is laid out'],
    [/^not the same picture/, 'a frame is not the same picture when it is drawn again after other frames: it does not follow from its time alone'],
    [/^error: /, 'its script fails when it is the scene of a later shot'], [/^lint: /, 'the scene lint refuses it after the rewrite'], [/^batch: /, 'its page fails in the renderer'],
  ];
  let source = previous.source;
  if (checkout && !flag('--catalogue-only')) {
    const commit = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD']).toString().trim();
    await mkdir(outDir, { recursive: true });
    let found = 0;
    for (const kind of ['components', 'blocks', 'examples']) {
      const dir = path.join(checkout, 'registry', kind);
      for (const name of (await readdir(dir)).sort()) {
        const itemFile = path.join(dir, name, 'registry-item.json');
        if (!existsSync(itemFile)) continue;
        found++;
        if (only && !only.includes(name)) continue;
        const item = JSON.parse(await readFile(itemFile, 'utf8'));
        const file = [path.join(dir, name, 'demo.html'), path.join(dir, name, name + '.html'), path.join(dir, name, 'index.html')].find((p) => existsSync(p));
        const skip = (reason) => skipped.push({ name, source: 'hyperframes:' + kind + '/' + name, class: classOf(item), reason });
        if (!file) { skip('has no page of its own to port'); continue; }
        if (unverified[name]) { const why = String(unverified[name]); skip((REASONS.find(([re]) => re.test(why))?.[1] ?? why) + (/^(error|lint|batch): /.test(why) ? ' (' + why.replace(/^(error|lint|batch): /, '').slice(0, 100) + ')' : '')); await rm(path.join(outDir, name + '.html'), { force: true }); continue; }
        const html = await readFile(file, 'utf8');
        const made = convert(item, kind, html, commit, (rel) => { const f = path.join(dir, name, rel); return f.startsWith(path.join(dir, name)) && existsSync(f) ? readFileSync(f, 'utf8') : undefined; });
        if (made.skip) { skip(made.skip); continue; }
        let read = { seconds: Number(item.duration) || 0, cues: [], errors: [], timelines: 1 };
        if (browser) {
          const scene = path.join(scratch, 'scenes', name + '.html');
          await writeFile(scene, made.page({ seconds: 0 }));
          read = await readPage(browser, scene);
          if (read.errors.length) { skip('its script fails as a scene: ' + read.errors[0].slice(0, 140)); continue; }
          if (!read.timelines && !/__popostScene/.test(html)) { skip('hands no timeline over (it is driven by the HyperFrames runtime alone)'); continue; }
        }
        const seconds = read.seconds || Number(item.duration) || Number(/data-duration=["']([\d.]+)["']/.exec(html)?.[1]) || 3;
        const cues = read.cues.length ? read.cues : fallbackCues(name, made.class, read.first ?? 0);
        const out = made.page({ seconds }).replace('</head>', '<script type="application/json" id="popost-cues">' + JSON.stringify(cues) + '</script>\n</head>');
        if (Buffer.byteLength(out) > MAX_BYTES) { skip('is ' + Math.round(Buffer.byteLength(out) / 1024) + ' KB as one page (inlined data or pictures); the limit for an example is ' + MAX_BYTES / 1024 + ' KB'); continue; }
        await writeFile(path.join(outDir, name + '.html'), out);
        ported.push(name);
        process.stderr.write('.');
      }
    }
    process.stderr.write('\n');
    source = { project: 'HyperFrames', url: 'https://github.com/heygen-com/hyperframes', commit, licence: 'Apache-2.0', copyright: 'Copyright 2026 HeyGen, Inc.', found, ported: 0, skipped: 0 };
  }
  // Every example of the Skill, the ported and its own.
  const entries = [];
  const files = [...(await readdir(examplesDir)).filter((f) => f.endsWith('.html')).map((f) => f), ...(existsSync(outDir) ? (await readdir(outDir)).filter((f) => f.endsWith('.html')).map((f) => 'hf/' + f) : [])].sort();
  for (const rel of files) {
    const html = await readFile(path.join(examplesDir, rel), 'utf8');
    const block = /<script type="application\/json" id="popost-params">([\s\S]*?)<\/script>/.exec(html)?.[1];
    if (!block) continue;
    const params = JSON.parse(block);
    // A ported entry that has the name of one of the Skill's own examples is listed as hf-<name>.
    const hf = rel.startsWith('hf/'), base = path.basename(rel, '.html'), name = hf && files.includes(base + '.html') ? 'hf-' + base : base;
    let cues = JSON.parse(/<script type="application\/json" id="popost-cues">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '[]');
    let seconds = params.seconds;
    if (!hf && browser) {
      const scene = path.join(scratch, 'scenes', name + '.html');
      await writeFile(scene, html);
      const read = await readPage(browser, scene);
      if (read.errors.length) throw new Error(rel + ': ' + read.errors.join(' | '));
      cues = read.cues.length ? read.cues : cues;
      seconds = seconds || read.seconds || undefined;
    }
    const origin = /registry\/(components|blocks|examples)\/([\w-]+), commit/.exec(html);
    const stand = /Stand-ins: ([^\n]*)\n/.exec(html)?.[1];
    const old = previous.entries.find((e) => e.name === name);
    entries.push({
      name, file: 'assets/video/examples/' + rel, class: params.class ?? old?.class ?? 'transition', about: params.about ?? '', seconds: seconds || old?.seconds || (Number(params.params?.find((p) => p.name === 'delay')?.default ?? 0) + Number(params.params?.find((p) => p.name === 'duration')?.default ?? 1) + 0.5),
      libraries: librariesOf(html), params: (params.params ?? []).map((p) => p.name), cues: cues.length ? cues : old?.cues ?? [],
      ...(origin ? { source: 'hyperframes:' + origin[1] + '/' + origin[2] } : {}), ...(params.placeholders ? { placeholders: params.placeholders } : stand ? { placeholders: stand } : {}), ...(params.tags ? { tags: params.tags } : {}),
    });
  }
  const keptSkips = checkout && !flag('--catalogue-only') ? skipped : previous.skipped ?? [];
  if (source) { source.ported = entries.filter((e) => e.source).length; source.skipped = keptSkips.length; }
  const catalogue = { version: 1, ...(source ? { source } : {}), entries, skipped: keptSkips };
  await writeFile(path.join(examplesDir, 'catalogue.json'), JSON.stringify(catalogue, null, 1) + '\n');
  await writeFile(path.join(skill, 'references/video-effects.md'), effectsPage(catalogue, source) + '\n');
  if (browser) await browser.close();
  await rm(scratch, { recursive: true, force: true });
  const by = {};
  for (const s of keptSkips) by[s.reason.slice(0, 60)] = (by[s.reason.slice(0, 60)] ?? 0) + 1;
  console.log(JSON.stringify({ entries: entries.length, ported: entries.filter((e) => e.source).length, own: entries.filter((e) => !e.source).length, skipped: keptSkips.length, skippedBy: by }, null, 1));
};

await main();
