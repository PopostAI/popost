/**
 * Reading a source of the new video's content: a web page or a README, as text. From its HTML tags and, in a Markdown
 * file, its Markdown syntax, in the order of the document: the pictures it references (each with its alt text and the
 * heading it stands under), the links that leave it, its title, and the colours a page declares for itself. Pure: no
 * network, no files. What is a badge, a tracker or a logo is decided here too, from the address and the alt text.
 */
import { Parser } from 'htmlparser2';

export interface FoundPicture {
  /** As written in the source: an address, or a path beside a local file. */
  src: string;
  alt: string;
  /** The heading the picture stands under ('' before the first one). */
  heading: string;
  /** img: a picture of the content; icon: the page's own icon; social: the picture a page gives link previews. */
  from: 'img' | 'icon' | 'social';
}

export interface FoundLink { url: string; text: string }

export interface SourceReading {
  title: string;
  /** The readable text: a Markdown file as it is, a page without its tags, scripts and styles. */
  text: string;
  pictures: FoundPicture[];
  links: FoundLink[];
  /** Colours the page declares for itself (theme-color), as written. */
  colours: { value: string; from: string }[];
  headings: string[];
}

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
/** Their content is never text of the page. */
const SKIPPED = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head']);
const BLOCKS = new Set(['p', 'div', 'section', 'article', 'li', 'tr', 'br', 'ul', 'ol', 'table', 'header', 'footer', 'main', 'nav', 'blockquote', 'pre', 'figure', 'figcaption', ...HEADINGS]);

const MD_IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const MD_LINK = /\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const MD_HEADING = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/;

const tidy = (s: string): string => s.replace(/\s+/g, ' ').trim();
/** A Markdown line as its words: pictures as their alt text, links as their text, no emphasis marks. */
const plainMarkdown = (line: string): string => tidy(line.replace(MD_IMAGE, '$1').replace(MD_LINK, '$1').replace(/[*_`]+/g, ''));

/**
 * markdown: the text between the tags is Markdown, so its pictures, links and headings count too (outside fenced code).
 * A README mixes both: `<img>` tags and `![alt](src)`.
 */
export const readSource = (content: string, o: { markdown: boolean }): SourceReading => {
  const out: SourceReading = { title: '', text: '', pictures: [], links: [], colours: [], headings: [] };
  let heading = '';
  let skipped = 0;
  let inHead = false;
  let capture: { tag: string; text: string } | undefined;
  let anchor: { url: string; text: string } | undefined;
  let fenced = false;
  const text: string[] = [];
  const picture = (src: string | undefined, alt: string | undefined, from: FoundPicture['from']): void => {
    if (src && src.trim() && !src.trim().startsWith('data:')) out.pictures.push({ src: src.trim(), alt: tidy(alt ?? ''), heading, from });
  };
  const markdown = (chunk: string): void => {
    for (const line of chunk.split('\n')) {
      if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
      if (fenced) continue;
      const h = MD_HEADING.exec(line);
      if (h) {
        heading = plainMarkdown(h[1] ?? '');
        if (heading) out.headings.push(heading);
      }
      for (const m of line.matchAll(MD_IMAGE)) picture(m[2], m[1], 'img');
      for (const m of line.replace(MD_IMAGE, '$1').matchAll(MD_LINK)) out.links.push({ url: (m[2] ?? '').trim(), text: tidy(m[1] ?? '') });
    }
  };
  const parser = new Parser({
    onopentag: (name, a) => {
      if (name === 'head') inHead = true;
      if (name === 'title' && inHead) capture = { tag: 'title', text: '' };
      if (name === 'meta') {
        const key = (a.name ?? a.property ?? '').toLowerCase();
        if (key === 'theme-color' && a.content) out.colours.push({ value: a.content.trim(), from: 'theme-color' });
        if ((key === 'og:image' || key === 'twitter:image') && a.content) picture(a.content, key, 'social');
        if (key === 'og:title' && a.content && !out.title) out.title = tidy(a.content);
      }
      if (name === 'link' && /(^|\s)(icon|apple-touch-icon|mask-icon)(\s|$)/i.test(a.rel ?? '')) picture(a.href, a.rel, 'icon');
      if (SKIPPED.has(name) && name !== 'head') skipped++;
      if (skipped) return;
      if (HEADINGS.has(name)) capture = { tag: name, text: '' };
      // A page that proxies its pictures keeps the real address beside the proxied one.
      if (name === 'img') picture(a['data-canonical-src'] ?? a.src ?? a['data-src'], a.alt ?? a.title, 'img');
      if (name === 'a' && a.href) anchor = { url: a.href.trim(), text: '' };
      if (BLOCKS.has(name)) text.push('\n');
    },
    ontext: (chunk) => {
      if (capture) capture.text += chunk;
      if (skipped || inHead) return;
      if (anchor) anchor.text += chunk;
      text.push(chunk);
      if (o.markdown) markdown(chunk);
    },
    onclosetag: (name) => {
      if (name === 'head') inHead = false;
      if (capture && capture.tag === name) {
        const said = tidy(capture.text);
        if (name === 'title') out.title = out.title || said;
        else if (said) {
          heading = said;
          out.headings.push(said);
        }
        capture = undefined;
      }
      if (SKIPPED.has(name) && name !== 'head' && skipped > 0) skipped--;
      if (name === 'a' && anchor) {
        out.links.push({ url: anchor.url, text: tidy(anchor.text) });
        anchor = undefined;
        text.push(' ');
      }
      if (BLOCKS.has(name)) text.push('\n');
    },
  }, { decodeEntities: true });
  parser.write(content);
  parser.end();
  out.text = o.markdown ? content : text.join('').replace(/[ \t]+/g, ' ').replace(/ *\n\s*/g, '\n').trim() + '\n';
  if (!out.title) out.title = out.headings[0] ?? '';
  return out;
};

/** Hosts that serve status badges, counters and trackers: pictures of a build's state or of a visit, never of the product. */
const BADGE_HOSTS = /(^|\.)(shields\.io|badgen\.net|badge\.fury\.io|forthebadge\.com|badges\.gitter\.im|badgesize\.io|codecov\.io|coveralls\.io|codacy\.com|codeclimate\.com|travis-ci\.(org|com)|circleci\.com|appveyor\.com|snyk\.io|sonarcloud\.io|deepscan\.io|packagephobia\.com|bundlephobia\.com|hits\.dwyl\.com|komarev\.com|visitor-badge\.[a-z.]+|star-history\.com|contrib\.rocks|opencollective\.com|api\.netlify\.com|deploy\.workers\.cloudflare\.com|vercel\.com|herokucdn\.com|google-analytics\.com|googletagmanager\.com|doubleclick\.net|scorecard\.dev)$/i;
const BADGE_PATH = /\/(workflows|actions)\/.*badge\.svg$|\/badge\.(svg|png)$|\/badges?\//i;

/** A status badge, a counter or a tracker, by its address; and what the alt text of a badge usually says. */
export const isBadge = (url: URL, alt: string): boolean =>
  BADGE_HOSTS.test(url.hostname) || BADGE_PATH.test(url.pathname) || /^(build|ci|coverage|license|licence|npm( version)?|downloads|version|stars|status|tests?)( status| badge)?$/i.test(alt.trim());

/** A picture that calls itself the logo: in its alt text or its file name. */
export const isLogo = (src: string, alt: string): boolean => /logo|wordmark|brand[-_ ]?mark/i.test(alt) || /logo|wordmark/i.test(src.split(/[?#]/)[0]?.split('/').pop() ?? '');

/** Hosts of code, packages and social platforms: a link there is not the product's own site. */
const PLATFORMS = /(^|\.)(github\.com|githubusercontent\.com|github\.io|gitlab\.com|bitbucket\.org|npmjs\.com|pypi\.org|crates\.io|x\.com|twitter\.com|youtube\.com|youtu\.be|discord\.gg|discord\.com|linkedin\.com|facebook\.com|instagram\.com|tiktok\.com|t\.me|medium\.com|reddit\.com|producthunt\.com|weibo\.com|bilibili\.com|zhihu\.com|xiaohongshu\.com)$/i;

/** The last two labels of a host: enough to say that static.example.com and www.example.com are one site. */
export const siteOf = (host: string): string => host.toLowerCase().split('.').slice(-2).join('.');

/**
 * Which hosts are most likely the product's own site, among the hosts a source links to: the source's own site when
 * it is a page of its own, a site its pictures come from, or a host that carries one of the names (a repository's
 * owner and name). A guess from the addresses: the caller reads the list.
 */
export const ownHosts = (hosts: readonly string[], o: { page?: string; pictureHosts: readonly string[]; names: readonly string[] }): string[] => {
  const mine = new Set([...(o.page && !PLATFORMS.test(o.page) ? [siteOf(o.page)] : []), ...o.pictureHosts.filter((h) => !PLATFORMS.test(h) && !BADGE_HOSTS.test(h)).map(siteOf)]);
  const names = o.names.map((n) => n.toLowerCase().replace(/[^a-z0-9]/g, '')).filter((n) => n.length >= 3);
  const label = (h: string): string => (siteOf(h).split('.')[0] ?? '').replace(/[^a-z0-9]/g, '');
  return [...new Set(hosts.map((h) => h.toLowerCase()))].filter((h) => !PLATFORMS.test(h) && !BADGE_HOSTS.test(h) && (mine.has(siteOf(h)) || names.some((n) => label(h).includes(n) || n.includes(label(h)) && label(h).length >= 4)));
};

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** "#abc", "#AABBCC" or "rgb(1, 2, 3)" as "#rrggbb"; undefined for anything else (a name, a gradient, none). */
export const hexOf = (value: string): string | undefined => {
  const v = value.trim();
  if (HEX.test(v)) return '#' + (v.length === 4 ? [...v.slice(1)].map((c) => c + c).join('') : v.slice(1)).toLowerCase();
  const rgb = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/i.exec(v);
  if (!rgb) return undefined;
  const parts = rgb.slice(1, 4).map(Number);
  return parts.every((n) => n <= 255) ? '#' + parts.map((n) => n.toString(16).padStart(2, '0')).join('') : undefined;
};

/** The colours an SVG paints with (fill, stroke, gradient stops), most used first; neutral: white, black or a gray. */
export const svgColours = (svg: string): { hex: string; uses: number; neutral: boolean }[] => {
  const uses = new Map<string, number>();
  for (const m of svg.matchAll(/(?:fill|stroke|stop-color|color)\s*[:=]\s*["']?\s*(#[0-9a-f]{3,6}\b|rgba?\([^)]*\))/gi)) {
    const hex = hexOf(m[1] ?? '');
    if (hex) uses.set(hex, (uses.get(hex) ?? 0) + 1);
  }
  const neutral = (hex: string): boolean => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
    return Math.max(r, g, b) - Math.min(r, g, b) < 24;
  };
  return [...uses].map(([hex, n]) => ({ hex, uses: n, neutral: neutral(hex) })).sort((a, b) => Number(a.neutral) - Number(b.neutral) || b.uses - a.uses);
};
