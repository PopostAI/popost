/**
 * The code panel shows long base64 payloads (embedded images and fonts) as short placeholders so CodeMirror stays
 * responsive, and puts the real data back on save.
 */
const LONG_DATA = /(data:[a-z0-9.+/-]*;base64,)([A-Za-z0-9+/=]{1500,})/gi;
const PLACEHOLDER = /\[\[popost-data-(\d+):[^\]]*\]\]/g;

export interface MaskedSource {
  text: string;
  /** Replace the placeholders of `edited` with the original data (unknown placeholders stay as typed). */
  restore(edited: string): string;
}

const fmtSize = (n: number): string => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function maskLongData(source: string): MaskedSource {
  const payloads: string[] = [];
  const text = source.replace(LONG_DATA, (_m, head: string, data: string) => {
    payloads.push(data);
    return `${head}[[popost-data-${payloads.length}:${fmtSize(data.length)}]]`;
  });
  return {
    text,
    restore: (edited) => edited.replace(PLACEHOLDER, (m, n: string) => payloads[Number(n) - 1] ?? m),
  };
}
