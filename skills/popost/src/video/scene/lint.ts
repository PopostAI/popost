/**
 * What can be said about a scene's HTML without opening it: the rules that keep a scene on the engine's clock,
 * reproducible, and inside the project. A scene is written by a model at run time, so every rule comes with the
 * reason and one fix. Text only: this file runs anywhere.
 */
import type { Problem } from '../types';

export const MAX_SCENE_BYTES = 1024 * 1024;

interface Rule { pattern: RegExp; level: Problem['level']; message: string; fix: string }

const RULES: Rule[] = [
  { pattern: /\b(?:src|href|poster)\s*=\s*["']?\s*(?:https?:)?\/\//i, level: 'error', message: 'It loads something from the network; a scene uses only what is in the project.', fix: 'Put the file in the project (assets/) and write its path relative to the scene file, or draw it with HTML, CSS and SVG.' },
  { pattern: /url\(\s*["']?\s*(?:https?:)?\/\//i, level: 'error', message: 'Its CSS loads something from the network (url(...)).', fix: 'Use a file of the project with a relative path, or a gradient or an inline SVG.' },
  { pattern: /@import\b/i, level: 'error', message: 'It imports a stylesheet; a scene is one file.', fix: 'Write the CSS inside a <style> element of the scene.' },
  { pattern: /<(?:video|audio|iframe|object|embed)\b/i, level: 'error', message: 'It has a video, audio or embedded page; those run on their own clock, which the renderer does not control.', fix: 'Show footage as a material of the project (a video item or a base), not inside the scene.' },
  { pattern: /\b(?:setTimeout|setInterval|requestAnimationFrame)\s*\(/, level: 'error', message: 'It drives something with a timer or requestAnimationFrame; the renderer draws frames in any order and at its own speed, so such motion comes out different every time.', fix: 'Use a CSS animation (@keyframes with animation-delay) or element.animate(...), or put the drawing in window.__popostScene = { render(seconds) { ... } }.' },
  { pattern: /\b(?:Date\.now|performance\.now)\s*\(|\bnew\s+Date\s*\(/, level: 'error', message: 'It reads the real clock; a frame must depend on its time in the video only.', fix: 'Use the "seconds" given to window.__popostScene.render(seconds).' },
  { pattern: /\bMath\.random\s*\(/, level: 'error', message: 'It uses random numbers, so two renders differ.', fix: 'Write the values out, or compute them from an index (for example (i * 37) % 100).' },
  { pattern: /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\b/, level: 'error', message: 'It talks to the network from a script.', fix: 'Remove it: a scene has everything it shows in its own file.' },
  { pattern: /\b(?:window\.)?(?:parent|top|opener)\s*\.|\bwindow\.open\s*\(|\blocation\s*(?:\.\s*\w+\s*)?=[^=]/, level: 'error', message: 'It reaches outside its own page (parent, top, location).', fix: 'Remove it: a scene only draws itself.' },
  { pattern: /\btransition\s*:/i, level: 'warning', message: 'It has a CSS transition; a transition starts when a style changes, not at a time of the video, so the renderer cannot place it.', fix: 'Use a CSS animation with animation-delay instead.' },
];

/** The names a scene marks for new content: every data-slot="name" of its source, in order, once each. */
export const slotNames = (html: string): string[] =>
  [...new Set([...html.matchAll(/\bdata-slot\s*=\s*["']([^"']+)["']/g)].map((m) => m[1] as string))];

/** The places on <img> elements: their slot takes a picture path, relative to the scene file, not a text. */
export const pictureSlotNames = (html: string): string[] =>
  [...new Set([...html.matchAll(/<img\b[^>]*?\bdata-slot\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1] as string))];

/** Slot values a project gives that the scene has no place for. */
export const slotProblems = (html: string, slots: Record<string, string> | undefined, at: string): Problem[] => {
  const names = slotNames(html);
  return Object.keys(slots ?? {}).filter((k) => !names.includes(k)).map((k): Problem => ({
    level: 'error', at: at + '.' + k, message: 'The scene has no place called "' + k + '".' + (names.length ? '' : ' It marks none: an element takes new content only when it has data-slot="name".'),
    ...(names.length ? { allowed: names } : {}), fix: names.length ? 'Use one of its names, or remove "' + k + '".' : 'Add data-slot="' + k + '" to the element in the scene, or remove "slots".',
  }));
};

/** Problems of a scene's source. at: where to report them (the scene's path in the project). */
export const lintScene = (html: string, at: string): Problem[] => {
  const out: Problem[] = [];
  if (Buffer.byteLength(html) > MAX_SCENE_BYTES) out.push({ level: 'error', at, message: 'The scene is ' + Math.round(Buffer.byteLength(html) / 1024) + ' KB; the limit is ' + MAX_SCENE_BYTES / 1024 + ' KB.', fix: 'Move pictures out of the file into assets/ and link them by a relative path.' });
  if (!/<body[\s>]/i.test(html)) out.push({ level: 'error', at, message: 'It has no <body>; a scene is a whole HTML page.', fix: 'Write <!doctype html><html><head><style>...</style></head><body>...</body></html>.' });
  for (const r of RULES) {
    const m = r.pattern.exec(html);
    if (m) out.push({ level: r.level, at, message: r.message + ' Found: "' + html.slice(Math.max(0, m.index - 10), m.index + 50).replace(/\s+/g, ' ').trim() + '".', fix: r.fix });
  }
  return out;
};
