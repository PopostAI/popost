/**
 * `popost video source`: one source of the new video's content (a web page, a README, a local file) collected into a
 * directory of the project. Its text is saved, the pictures it references are downloaded (the logo first; badges,
 * counters and tracking pixels left out; within limits of size and number), and an inventory says what each picture is:
 * its file, what its alt text and the heading over it say, its pixel size and where it came from. The page itself is
 * the only page fetched: no link is followed. The inventory is kept beside the text (INVENTORY_FILE), so that the
 * checks can tell whether the project uses any of the pictures (used.ts).
 */
import { describePicture } from '../../core/image-info';
import { networkReason } from '../../core/error-text';
import { readCapped, userAgent } from '../../providers/api';
import { timeoutSignal } from '../../providers/time';
import type { Runtime } from '../../runtime';
import { mapLimit } from '../host';
import { hexOf, isBadge, isLogo, ownHosts, readSource, siteOf, svgColours, type FoundPicture } from './read';

export const INVENTORY_FILE = 'pictures.inventory.json';
export const MAX_PICTURES = 40;
const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const MAX_PICTURE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 80 * 1024 * 1024;
const PAGE_TIMEOUT_MS = 30_000;
const PICTURE_TIMEOUT_MS = 30_000;
/** A picture this small in both directions shows nothing: a tracking pixel or a spacer. */
const PIXEL = 3;
const EXT: Readonly<Record<string, string>> = { png: '.png', jpeg: '.jpg', webp: '.webp', gif: '.gif', svg: '.svg' };

/** A failure the caller can fix: the address, the file, the network. */
export class SourceError extends Error {
  override name = 'SourceError';
}

export interface SourcePicture {
  /** From the directory of the inventory. */
  file: string;
  /** What the source says of it: its alt text, and the heading it stands under. */
  says: string;
  heading: string;
  format: string;
  width?: number;
  height?: number;
  bytes: number;
  from: string;
  kind: FoundPicture['from'];
  logo?: true;
}

export interface SourceEntry {
  source: string;
  title: string;
  /** The saved text, from the directory of the inventory. */
  text: string;
  pictures: SourcePicture[];
  skipped: { badges: number; pixels: number; overLimit: number; failed: { from: string; why: string }[] };
  colours: { hex: string; from: string; neutral?: true }[];
  /** Links to what is most likely the product's own site, and the other hosts the source links to. */
  site: { hosts: string[]; links: { url: string; text: string }[] };
  otherHosts: string[];
}

export interface Inventory { sources: SourceEntry[] }

const isHttp = (s: string): boolean => /^https?:\/\//i.test(s);

/** A host on this machine or a private network: a page may not make the CLI fetch from there. */
const isPrivateHost = (host: string): boolean =>
  /^(localhost|.*\.(local|internal|localhost))$/i.test(host) || host.includes(':') || /^(0|10|127)\./.test(host) || /^169\.254\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);

const slugOf = (s: string, fallback: string): string => s.toLowerCase().replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || fallback;

const fetchBytes = async (rt: Runtime, url: string, limit: number, ms: number): Promise<{ bytes: Uint8Array; url: string; type: string }> => {
  let response: Response;
  try {
    response = await rt.fetch(url, { headers: { 'User-Agent': userAgent(), Accept: '*/*' }, signal: timeoutSignal(rt, ms) });
  } catch (error) {
    throw new SourceError(networkReason(error, url));
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new SourceError('HTTP ' + response.status);
  }
  const bytes = await readCapped(response, limit).catch(() => {
    throw new SourceError('larger than ' + Math.round(limit / 1048576) + ' MB');
  });
  return { bytes, url: response.url || url, type: (response.headers.get('content-type') ?? '').toLowerCase() };
};

interface Loaded { name: string; content: string; markdown: boolean; base?: URL; dir?: string }

/** The source as text: fetched (https; http only from this machine), or read from a file. */
const load = async (rt: Runtime, source: string): Promise<Loaded> => {
  if (!isHttp(source)) {
    const file = rt.path.resolve(rt.cwd, source);
    const content = await rt.fs.readText(file).catch(() => {
      throw new SourceError('The source "' + source + '" is neither an https address nor a file that can be read.');
    });
    return { name: rt.path.basename(file), content, markdown: !/\.html?$/i.test(file), dir: rt.path.dirname(file) };
  }
  const asked = new URL(source);
  if (asked.protocol !== 'https:' && !isPrivateHost(asked.hostname)) throw new SourceError('A source is fetched over https; "' + source + '" is not.');
  const got = await fetchBytes(rt, source, MAX_PAGE_BYTES, PAGE_TIMEOUT_MS).catch((e: unknown) => {
    throw new SourceError('The source ' + source + ' could not be fetched (' + (e instanceof Error ? e.message : String(e)) + '). Check the address, or save the page as a file and give the file.');
  });
  const base = new URL(got.url);
  const markdown = /\.(md|markdown|txt)$/i.test(base.pathname) || /text\/(markdown|plain)/.test(got.type);
  return { name: base.pathname.split('/').filter(Boolean).pop() ?? base.hostname, content: new TextDecoder().decode(got.bytes), markdown, base };
};

/** The bytes of one picture: downloaded, or copied from beside a local source (never from outside its directory). */
const pictureBytes = async (rt: Runtime, src: string, l: Loaded): Promise<{ bytes: Uint8Array; from: string }> => {
  if (l.base || isHttp(src)) {
    const url = new URL(src, l.base);
    if (!/^https?:$/.test(url.protocol)) throw new SourceError('not an http address');
    if (isPrivateHost(url.hostname) && url.hostname !== l.base?.hostname) throw new SourceError('a private address');
    return { bytes: (await fetchBytes(rt, url.href, MAX_PICTURE_BYTES, PICTURE_TIMEOUT_MS)).bytes, from: url.href };
  }
  const file = rt.path.resolve(l.dir ?? rt.cwd, decodeURIComponent(src.split(/[?#]/)[0] ?? ''));
  const inside = rt.path.relative(l.dir ?? rt.cwd, file);
  if (inside.startsWith('..') || rt.path.isAbsolute(inside)) throw new SourceError('outside the directory of the source');
  const stat = await rt.fs.stat(file);
  if (!stat?.isFile) throw new SourceError('no such file');
  if (stat.size > MAX_PICTURE_BYTES) throw new SourceError('larger than ' + Math.round(MAX_PICTURE_BYTES / 1048576) + ' MB');
  return { bytes: await rt.fs.readFile(file), from: inside.split(rt.path.sep).join('/') };
};

/** The names a repository page gives its product: owner and repository of a GitHub address. */
const namesOf = (l: Loaded): string[] => {
  const m = l.base && /(^|\.)(github\.com|githubusercontent\.com)$/i.test(l.base.hostname) ? l.base.pathname.split('/').filter(Boolean).slice(0, 2) : [];
  return m;
};

const readInventory = (rt: Runtime, dir: string): Promise<Inventory> =>
  rt.fs.readText(rt.path.join(dir, INVENTORY_FILE)).then((t) => JSON.parse(t) as Inventory, (): Inventory => ({ sources: [] })).then((i) => (Array.isArray(i?.sources) ? i : { sources: [] }));

/**
 * Collects a source into outDir: <slug>.md or .txt (its text), pictures/<slug>/NN-name.ext, and its entry in the
 * inventory (an entry of the same source is replaced, its pictures written again).
 */
export const collectSource = async (rt: Runtime, o: { source: string; outDir: string; maxPictures?: number }): Promise<SourceEntry> => {
  const l = await load(rt, o.source);
  const read = readSource(l.content, { markdown: l.markdown });
  const inventory = await readInventory(rt, o.outDir);
  const others = inventory.sources.filter((s) => s.source !== o.source);
  const taken = new Set(others.map((s) => s.text.replace(/\.[a-z]+$/, '')));
  let slug = slugOf(l.name, 'source');
  for (let n = 2; taken.has(slug); n++) slug = slugOf(l.name, 'source') + '-' + n;
  const textFile = slug + (l.markdown ? '.md' : '.txt');
  await rt.fs.mkdir(o.outDir);
  await rt.fs.writeFile(rt.path.join(o.outDir, textFile), read.text);
  const picturesDir = rt.path.join(o.outDir, 'pictures', slug);
  await rt.fs.rm(picturesDir);
  // Once each, badges out by their address, the logo first, the page's own icon and preview picture last.
  const seen = new Set<string>();
  const unique = read.pictures.filter((p) => !seen.has(p.src) && seen.add(p.src));
  const resolved = (p: FoundPicture): URL | undefined => { try { return l.base || isHttp(p.src) ? new URL(p.src, l.base) : undefined; } catch { return undefined; } };
  const badge = (p: FoundPicture): boolean => { const u = resolved(p); return u ? isBadge(u, p.alt) : false; };
  const content = unique.filter((p) => !badge(p));
  const rank = (p: FoundPicture): number => (p.from !== 'img' ? 2 : isLogo(p.src, p.alt) ? 0 : 1);
  const ordered = content.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).map((x) => x.p);
  const max = o.maxPictures ?? MAX_PICTURES;
  const wanted = ordered.slice(0, max);
  const skipped: SourceEntry['skipped'] = { badges: unique.length - content.length, pixels: 0, overLimit: ordered.length - wanted.length, failed: [] };
  const got = await mapLimit(wanted, 4, async (p) => pictureBytes(rt, p.src, l).then((r) => ({ p, ...r }), (e: unknown) => ({ p, why: e instanceof Error ? e.message : String(e) })));
  const pictures: SourcePicture[] = [];
  const colours: SourceEntry['colours'] = [];
  let total = 0;
  for (const g of got) {
    if ('why' in g) { skipped.failed.push({ from: g.p.src, why: g.why }); continue; }
    let info: ReturnType<typeof describePicture>;
    try { info = describePicture(g.bytes, g.p.src); } catch { skipped.failed.push({ from: g.from, why: 'not a picture' }); continue; }
    if (info.width !== undefined && info.height !== undefined && info.width <= PIXEL && info.height <= PIXEL) { skipped.pixels++; continue; }
    if (total + g.bytes.length > MAX_TOTAL_BYTES) { skipped.overLimit++; continue; }
    total += g.bytes.length;
    const logo = g.p.from === 'img' && isLogo(g.p.src, g.p.alt);
    const file = 'pictures/' + slug + '/' + String(pictures.length + 1).padStart(2, '0') + '-' + slugOf(g.from.split(/[?#]/)[0]?.split('/').pop() ?? '', 'picture') + (EXT[info.format] ?? '');
    await rt.fs.mkdir(picturesDir);
    await rt.fs.writeFile(rt.path.join(o.outDir, file), g.bytes);
    pictures.push({ file, says: g.p.alt, heading: g.p.heading, format: info.format, ...(info.width !== undefined && info.height !== undefined ? { width: info.width, height: info.height } : {}), bytes: g.bytes.length, from: g.from, kind: g.p.from, ...(logo ? { logo: true as const } : {}) });
    // A logo or an icon drawn as SVG says the brand's colours in its fills.
    if (info.format === 'svg' && (logo || g.p.from === 'icon')) for (const c of svgColours(new TextDecoder().decode(g.bytes)).slice(0, 6)) colours.push({ hex: c.hex, from: file, ...(c.neutral ? { neutral: true as const } : {}) });
  }
  for (const c of read.colours) { const hex = hexOf(c.value); if (hex) colours.push({ hex, from: c.from }); }
  // Links that leave the source, once each; which of their hosts is the product's own site is a guess from the addresses.
  const links = read.links.flatMap((k) => { try { const u = new URL(k.url, l.base); return /^https?:$/.test(u.protocol) && u.hostname !== l.base?.hostname ? [{ url: u.href, text: k.text, host: u.hostname.toLowerCase() }] : []; } catch { return []; } });
  const pictureHosts = pictures.flatMap((p) => (isHttp(p.from) && p.kind === 'img' ? [new URL(p.from).hostname] : []));
  const own = ownHosts(links.map((k) => k.host), { ...(l.base ? { page: l.base.hostname } : {}), pictureHosts, names: namesOf(l) });
  const once = new Set<string>();
  const ownLinks = links.filter((k) => own.some((h) => siteOf(h) === siteOf(k.host)) && !once.has(k.url) && once.add(k.url)).slice(0, 30).map((k) => ({ url: k.url, text: k.text }));
  const entry: SourceEntry = {
    source: o.source, title: read.title, text: textFile, pictures, skipped: { ...skipped, failed: skipped.failed.slice(0, 20) },
    colours: colours.filter((c, i) => colours.findIndex((x) => x.hex === c.hex) === i),
    site: { hosts: [...new Set(own.map(siteOf))], links: ownLinks },
    otherHosts: [...new Set(links.map((k) => k.host))].filter((h) => !own.some((x) => siteOf(x) === siteOf(h))).slice(0, 30),
  };
  await rt.fs.writeFile(rt.path.join(o.outDir, INVENTORY_FILE), JSON.stringify({ sources: [...others, entry] }, null, 1) + '\n');
  return entry;
};
