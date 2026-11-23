/**
 * The HTML the server sends: the shell (its script, shell/main.ts, bundled ahead of time into shell-bundle.ts by
 * bundles/build-video.mjs; its style inlined) and the plain page that lists a project's problems when it has errors.
 */
import type { Problem } from '../types';
import { SHELL_BUNDLE } from './shell-bundle';
import { SHELL_CSS } from './shell/style';

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const shellHtml = (): string => {
  const js = SHELL_BUNDLE.replace(/<\/script/gi, '<\\/script');
  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="color-scheme" content="light dark"><title>Video preview</title><style>' + SHELL_CSS + '</style></head>' +
    '<body><div id="app"></div><script>' + js + '</script></body></html>\n';
};

const ERROR_CSS = ':root{color-scheme:light dark;--fg:#1d1f23;--bg:#f6f6f4;--line:#d4d4cf;--err:#b42318;--warn:#8a5a00;--muted:#5d6068}' +
  '@media (prefers-color-scheme:dark){:root{--fg:#e6e6e3;--bg:#17181b;--line:#34363b;--err:#f97066;--warn:#e9b44c;--muted:#9a9ca3}}' +
  'body{margin:0;padding:16px 20px;font:14px/1.45 system-ui,sans-serif;color:var(--fg);background:var(--bg)}' +
  'h1{font-size:16px;margin:0 0 12px}li{margin:0 0 10px;padding:8px 10px;border:1px solid var(--line);border-radius:4px;list-style:none}' +
  'ul{padding:0;margin:0}code{font:12px/1.4 ui-monospace,monospace}.error{color:var(--err)}.warning{color:var(--warn)}.muted{color:var(--muted)}';

const problemHtml = (p: Problem): string =>
  '<li><div><b class="' + p.level + '">' + p.level + '</b> <code>' + escapeHtml(p.at) + '</code></div><div>' + escapeHtml(p.message) + '</div>' +
  (p.allowed?.length ? '<div class="muted">Allowed: ' + p.allowed.map((a) => '<code>' + escapeHtml(a) + '</code>').join(', ') + '</div>' : '') +
  (p.fix ? '<div>Fix: ' + escapeHtml(p.fix) + '</div>' : '') + '</li>';

/** The page /page sends instead of the video when the project has errors. */
export const errorPageHtml = (problems: readonly Problem[], dir: string): string => {
  const errors = problems.filter((p) => p.level === 'error').length;
  const sorted = [...problems].sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
  return '<!doctype html>\n<html><head><meta charset="utf-8"><title>Project has errors</title><style>' + ERROR_CSS + '</style></head><body>' +
    '<h1>The project has ' + errors + ' error' + (errors === 1 ? '' : 's') + ', so it cannot be shown.</h1>' +
    '<p class="muted"><code>' + escapeHtml(dir) + '/video.json</code>. Fix the errors and save; the preview reloads by itself.</p>' +
    '<ul>' + sorted.map(problemHtml).join('') + '</ul></body></html>\n';
};
