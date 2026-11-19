/** Shared browser export for the local Skill and the web workbench. */
export const EXPORT_FORMATS = ['png', 'jpg', 'svg', 'psd', 'html', 'pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export interface ExportOptions {
  html: string;
  name: string;
  pages: number[];
  format: ExportFormat;
  scale: number;
}

const STAGE_STYLE = 'position:fixed;left:-20000px;top:0;width:4000px;height:4000px;border:0;';

export const topLevelSlides = (doc: ParentNode): HTMLElement[] =>
  [...doc.querySelectorAll<HTMLElement>('.slide')].filter((element) => !element.parentElement?.closest('.slide'));

const safeName = (name: string): string => name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim() || 'deck';

const downloadBlob = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
};

export const loadExportStage = async (html: string, local = false): Promise<{ frame: HTMLIFrameElement; doc: Document }> => {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText = STAGE_STYLE;
  const loaded = new Promise<void>((resolve) => {
    frame.onload = () => resolve();
  });
  frame.srcdoc = local ? html.replace(/<head>/i, `<head><base href="${location.origin}/pages/"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; base-uri 'self'">`) : html;
  document.body.append(frame);
  await loaded;
  const doc = frame.contentDocument;
  if (!doc) {
    frame.remove();
    throw new Error('stage unavailable');
  }
  await doc.fonts.ready;
  await Promise.all([...doc.images].map((image) => image.decode().catch(() => undefined)));
  return { frame, doc };
};

const MAX_RENDER_PIXELS = 64_000_000;

export type ExportProgress = (completed: number, total: number, fraction: number) => void;

const dataFromUrl = async (url: string): Promise<string> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Export resource unavailable');
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
};

const standaloneHtml = async (source: string, local: boolean): Promise<string> => {
  const resources = local ? /(?:\.\.\/|\/)(?:assets|fonts|css)\/[^"'()\s<>,]+/g : /\/(?:api\/assets|fonts)\/[^"'()\s<>]+/g;
  const paths = [...new Set(source.match(resources) ?? [])];
  const assets = await Promise.all(paths.map(async (url) => [url, await dataFromUrl(local ? new URL(url, location.origin + '/pages/').href : url)] as const));
  const map = new Map(assets);
  return source.replace(resources, (url) => map.get(url) ?? url);
};

export const exportDeck = async (options: ExportOptions, progress: ExportProgress = () => {}, local = false): Promise<void> => {
  const [{ toCanvas, toSvg }, { default: JSZip }] = await Promise.all([import('html-to-image'), import('jszip')]);
  const { frame, doc } = await loadExportStage(options.html, local);
  try {
    const slides = topLevelSlides(doc);
    const indices = [...new Set(options.pages)].sort((a, b) => a - b);
    if (!indices.length || indices.some((index) => !slides[index])) throw new Error('Invalid export pages');
    const base = safeName(options.name);
    const zip = new JSZip();
    const pdf = options.format === 'pdf' ? await (await import('pdf-lib')).PDFDocument.create() : null;
    const psd = options.format === 'psd' ? await import('ag-psd') : null;
    for (const [i, index] of indices.entries()) {
      const slide = slides[index]!;
      const file = `${base}-${index + 1}.${options.format}`;
      const width = slide.offsetWidth;
      const height = slide.offsetHeight;
      if (options.format === 'html') {
        const clone = doc.documentElement.cloneNode(true) as HTMLElement;
        clone.querySelector('base')?.remove();
        topLevelSlides(clone).forEach((page, at) => {
          if (index !== at) page.remove();
        });
        zip.file(file, await standaloneHtml(`<!doctype html>${clone.outerHTML}`, local));
      } else {
        if (!width || !height || width * height * options.scale ** 2 > MAX_RENDER_PIXELS)
          throw new Error('Export dimensions exceed the browser limit');
        const render = {
          pixelRatio: options.scale,
          skipAutoScale: true,
          cacheBust: false,
          style: { margin: '0' },
          width,
          height,
        };
        if (options.format === 'svg') {
          const svg = await toSvg(slide, render);
          const markup = decodeURIComponent(svg.slice(svg.indexOf(',') + 1));
          const svgDocument = new DOMParser().parseFromString(markup, 'image/svg+xml');
          const root = svgDocument.documentElement;
          if (root.localName !== 'svg') throw new Error('Invalid SVG export');
          root.setAttribute('width', String(width * options.scale));
          root.setAttribute('height', String(height * options.scale));
          root.setAttribute('viewBox', `0 0 ${width} ${height}`);
          zip.file(file, new XMLSerializer().serializeToString(root));
        } else {
          const canvas = await toCanvas(
            slide,
            options.format === 'jpg' || pdf ? { ...render, backgroundColor: '#ffffff' } : render,
          );
          if (canvas.width !== width * options.scale || canvas.height !== height * options.scale)
            throw new Error('Unexpected export resolution');
          if (psd) {
            const imageData = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height);
            if (!imageData) throw new Error('Could not read canvas pixels');
            zip.file(
              file,
              psd.writePsd({
                width: canvas.width,
                height: canvas.height,
                imageData,
                children: [{ name: 'Artwork', imageData, opacity: 1 }],
              }),
            );
          } else {
            const jpg = options.format === 'jpg' || pdf !== null;
            const data = canvas.toDataURL(jpg ? 'image/jpeg' : 'image/png', 0.95);
            if (pdf) {
              const image = await pdf.embedJpg(data);
              const page = pdf.addPage([width * 0.75, height * 0.75]);
              page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
            } else zip.file(file, data.slice(data.indexOf(',') + 1), { base64: true });
          }
        }
      }
      progress(i + 1, indices.length, ((i + 1) / indices.length) * 0.9);
    }
    if (pdf) zip.file(`${base}.pdf`, await pdf.save());
    downloadBlob(
      await zip.generateAsync({ type: 'blob' }, ({ percent }) =>
        progress(indices.length, indices.length, 0.9 + percent / 1000),
      ),
      `${base}.zip`,
    );
  } finally {
    frame.remove();
  }
};
