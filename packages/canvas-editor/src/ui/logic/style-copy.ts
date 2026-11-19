/** Copy / paste style: the text-relevant properties of a block and the ops that apply them. */
import type { EditOp, NodeId } from '../../contracts';

export const STYLE_COPY_PROPS: readonly string[] = [
  'color',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-decoration-line',
  'text-transform',
  'text-align',
  'line-height',
  'letter-spacing',
  'opacity',
];

export type CopiedStyle = Readonly<Record<string, string>>;

/** Keep the copy-set properties that have a value (computed styles of the copied block). */
export function pickCopiedStyle(styles: Readonly<Record<string, string>>): CopiedStyle {
  const out: Record<string, string> = {};
  for (const prop of STYLE_COPY_PROPS) {
    const v = styles[prop];
    if (v !== undefined && v.trim() !== '') out[prop] = v.trim();
  }
  return out;
}

/** One `setStyle` op per target; applied in one batch they are one undo step. */
export function pasteStyleOps(targets: readonly NodeId[], copied: CopiedStyle): EditOp[] {
  if (Object.keys(copied).length === 0) return [];
  return targets.map((id): EditOp => ({ kind: 'setStyle', id, props: { ...copied } }));
}
