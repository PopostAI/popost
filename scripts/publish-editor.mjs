// Publish the built canvas editor (packages/canvas-editor/dist) to the Skill (skills/popost/assets/canvas/).
// Run after `npm run build:editor`. The target is written into a temp folder next to it and
// swapped in by rename, so it is never left half-written. Files are copied one by one with
// readFileSync/writeFileSync (fs.cpSync is unreliable on some virtual file systems) and every
// written file is re-read and hash-checked.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'packages/canvas-editor/dist');
const targets = [path.join(root, 'skills/popost/assets/canvas')];
// npm packages that end up in the editor bundle (verified from the rollup module graph).
const BUNDLED = ['react', 'react-dom', 'scheduler', 'parse5', 'entities', 'codemirror', 'html-to-image', 'jszip', 'pdf-lib', '@pdf-lib/standard-fonts', '@pdf-lib/upng', 'ag-psd',
  'base64-js', 'immediate', 'isarray', 'lie', 'pako', 'readable-stream', 'safe-buffer', 'string_decoder',
  'tslib', 'setimmediate', 'util-deprecate', 'core-util-is', 'inherits', 'process-nextick-args'];

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, base, out);
    else out.push(path.relative(base, file).split(path.sep).join('/'));
  }
  return out;
}

if (!fs.existsSync(path.join(source, 'index.html'))) {
  console.error('packages/canvas-editor/dist/index.html not found: run `npm run build:editor` first.');
  process.exit(1);
}

const version = /EDITOR_VERSION\s*=\s*'([^']+)'/.exec(fs.readFileSync(path.join(root, 'packages/canvas-editor/src/version.ts'), 'utf8'))?.[1];
if (!version) throw new Error('cannot read packages/canvas-editor/src/version.ts');

const files = new Map(); // rel path -> Buffer
for (const rel of walk(source)) files.set(rel, fs.readFileSync(path.join(source, rel)));

const licenseParts = [...BUNDLED, 'pdf-lib/node_modules/pako'].map((name) => {
  const dir = path.join(root, 'node_modules', name);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const file = fs.readdirSync(dir).find((f) => /^licen[sc]e(\.|$)/i.test(f));
  const text = file ? fs.readFileSync(path.join(dir, file), 'utf8') :
    pkg.name === 'isarray' ? fs.readFileSync(path.join(dir, 'README.md'), 'utf8').split('## License\n')[1] : undefined;
  if (!text) throw new Error(`no licence file for ${name}`);
  const notice = pkg.name === 'tslib' ? fs.readFileSync(path.join(dir, 'CopyrightNotice.txt'), 'utf8') + '\n' : '';
  return `${pkg.name}@${pkg.version} (${pkg.license || 'see text'})\n${'-'.repeat(60)}\n${(notice + text.trim()).replace(/\r\n/g, '\n')}\n`;
});
files.set(
  'THIRD_PARTY_LICENSES.txt',
  Buffer.from(`Third-party packages bundled into the Popost canvas editor\n\n${licenseParts.join('\n\n')}`),
);
const hashes = {};
for (const [rel, buf] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) hashes[rel] = sha(buf);
files.set('build-info.json', Buffer.from(JSON.stringify({ name: 'popost-canvas-editor', version, files: hashes }, null, 2) + '\n'));

function publish(target) {
  const tmp = `${target}.tmp-${process.pid}`;
  const old = `${target}.old-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [rel, buf] of files) {
    const dest = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    if (sha(fs.readFileSync(dest)) !== sha(buf)) throw new Error(`verification failed for ${dest}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const had = fs.existsSync(target);
  if (had) fs.renameSync(target, old);
  fs.renameSync(tmp, target);
  if (had) fs.rmSync(old, { recursive: true, force: true });
  for (const [rel, buf] of files) {
    if (sha(fs.readFileSync(path.join(target, rel))) !== sha(buf)) throw new Error(`post-rename verification failed: ${rel}`);
  }
  console.log(`Published ${files.size} editor files (v${version}) to ${path.relative(root, target)}`);
}

for (const target of targets) publish(target);
