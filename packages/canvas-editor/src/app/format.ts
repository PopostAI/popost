import type { EditOp, NodeId, TextFormat } from '../contracts';

export type StyleReader = (id: NodeId, props: string[]) => Record<string, string>;

const CLEAR_PROPS = [
  'color',
  'font-size',
  'font-family',
  'font-weight',
  'font-style',
  'text-decoration',
  'text-decoration-line',
  'text-transform',
];

const isBold = (weight: string | undefined): boolean => {
  if (!weight) return false;
  if (weight === 'bold' || weight === 'bolder') return true;
  const n = Number.parseInt(weight, 10);
  return Number.isFinite(n) && n >= 600;
};

const lineTokens = (value: string | undefined): string[] =>
  (value ?? '').split(/\s+/).filter((t) => t !== '' && t !== 'none');

/** Coalesce key for repeated colour / size changes on the same targets. */
export function formatCoalesceKey(format: TextFormat, targets: readonly NodeId[]): string | undefined {
  return format.command === 'color' || format.command === 'fontSize'
    ? `format:${format.command}:${targets.join(',')}`
    : undefined;
}

/**
 * `setStyle` ops that apply a text format to whole blocks. Toggles follow the computed style of the
 * targets: the command turns on unless every target already has it.
 */
export function buildFormatOps(format: TextFormat, targets: readonly NodeId[], styles: StyleReader): EditOp[] {
  const each = (props: (id: NodeId) => Record<string, string | null>): EditOp[] =>
    targets.map((id) => ({ kind: 'setStyle', id, props: props(id) }));
  const read = (id: NodeId, prop: string): string | undefined => styles(id, [prop])[prop];

  switch (format.command) {
    case 'bold': {
      const on = !targets.every((id) => isBold(read(id, 'font-weight')));
      return each(() => ({ 'font-weight': on ? '700' : '400' }));
    }
    case 'italic': {
      const on = !targets.every((id) => /^(italic|oblique)/.test(read(id, 'font-style') ?? ''));
      return each(() => ({ 'font-style': on ? 'italic' : 'normal' }));
    }
    case 'underline':
    case 'strike': {
      const token = format.command === 'underline' ? 'underline' : 'line-through';
      const lines = (id: NodeId): string[] => lineTokens(read(id, 'text-decoration-line'));
      const on = !targets.every((id) => lines(id).includes(token));
      return each((id) => {
        const rest = lines(id).filter((t) => t !== token);
        const next = on ? [...rest, token] : rest;
        return { 'text-decoration-line': next.length ? next.join(' ') : 'none' };
      });
    }
    case 'uppercase': {
      const on = !targets.every((id) => read(id, 'text-transform') === 'uppercase');
      return each(() => ({ 'text-transform': on ? 'uppercase' : 'none' }));
    }
    case 'color':
      return each(() => ({ color: format.value }));
    case 'fontSize':
      return each(() => ({ 'font-size': format.value }));
    case 'fontFamily':
      return each(() => ({ 'font-family': format.value }));
    case 'clear':
      return each(() => Object.fromEntries(CLEAR_PROPS.map((p) => [p, null])));
  }
}
