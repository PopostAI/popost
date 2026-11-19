import type { DocIndex, Splice } from '../../contracts';

/** Break up serialized tags without touching attribute values, text nodes, or CSS declarations. */
export function readableCode(index: DocIndex): string {
  const { source, elements, order } = index;
  const edits: Splice[] = [];
  for (const id of order) {
    const el = elements.get(id);
    if (!el || el.startTagEnd <= el.start) continue;
    const parent = el.parent ? elements.get(el.parent) : undefined;
    if (source[el.start - 1] === '>' && (!parent || ['html', 'head', 'body'].includes(parent.tag))) {
      edits.push({ start: el.start, end: el.start, text: '\n' });
    }
    if (el.startTagEnd - el.start > 100 && el.attrs.length > 2) {
      const attrs = [...el.attrs].sort((a, b) => a.start - b.start);
      for (let i = 1; i < attrs.length; i++) {
        const start = attrs[i - 1]!.end;
        const end = attrs[i]!.start;
        if (/^ +$/.test(source.slice(start, end))) edits.push({ start, end, text: '\n  ' });
      }
    }
    if (el.tag === 'style' && el.endTagStart !== null && el.startTagEnd < el.endTagStart) {
      if (!/\s/.test(source[el.startTagEnd] ?? '')) edits.push({ start: el.startTagEnd, end: el.startTagEnd, text: '\n' });
      if (!/\s/.test(source[el.endTagStart - 1] ?? '')) edits.push({ start: el.endTagStart, end: el.endTagStart, text: '\n' });
    }
  }
  let formatted = source;
  for (const { start, end, text } of edits.sort((a, b) => b.start - a.start)) {
    formatted = formatted.slice(0, start) + text + formatted.slice(end);
  }
  return formatted;
}
