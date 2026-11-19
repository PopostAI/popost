/**
 * Exact decimal arithmetic for prices (Python `decimal.Decimal` as the CLI used it): parse, multiply by an integer,
 * compare, print. Prices are credits, so JS floats would be fine for integers, but a quote must never be bound to a
 * rounded price, and the printed digits (`"12.50"`, `"25.0"`) match what the Python CLI wrote into quotes.
 */
export class Decimal {
  private constructor(
    private readonly int: bigint,
    private readonly scale: number,
  ) {}

  /** `null` when `text` is not a finite decimal number (callers tell NaN/Inf from garbage with `isNonFinite`). */
  static parse(text: string): Decimal | null {
    const m = /^([+-]?)(\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d+))?$/.exec(text.trim());
    if (!m) return null;
    const [whole = '0', frac = ''] = m[2]!.split('.');
    const exp = m[3] ? Number.parseInt(m[3], 10) : 0;
    let digits = BigInt(`${whole}${frac}` || '0');
    let scale = frac.length - exp;
    if (scale < 0) {
      digits *= 10n ** BigInt(-scale);
      scale = 0;
    }
    return new Decimal(m[1] === '-' ? -digits : digits, scale);
  }

  static isNonFinite = (text: string): boolean => /^[+-]?(inf|infinity|nan|snan)$/i.test(text.trim());

  times(count: number): Decimal {
    return new Decimal(this.int * BigInt(count), this.scale);
  }

  plus(other: Decimal): Decimal {
    const scale = Math.max(this.scale, other.scale);
    return new Decimal(this.int * 10n ** BigInt(scale - this.scale) + other.int * 10n ** BigInt(scale - other.scale), scale);
  }

  compare(other: Decimal): number {
    const scale = Math.max(this.scale, other.scale);
    const a = this.int * 10n ** BigInt(scale - this.scale);
    const b = other.int * 10n ** BigInt(scale - other.scale);
    return a < b ? -1 : a > b ? 1 : 0;
  }

  equals = (other: Decimal): boolean => this.compare(other) === 0;
  isZero = (): boolean => this.int === 0n;
  isNegative = (): boolean => this.int < 0n;

  toString(): string {
    const negative = this.int < 0n;
    const digits = (negative ? -this.int : this.int).toString().padStart(this.scale + 1, '0');
    const head = digits.slice(0, digits.length - this.scale);
    const tail = this.scale ? `.${digits.slice(digits.length - this.scale)}` : '';
    return `${negative ? '-' : ''}${head}${tail}`;
  }
}

/** `Decimal(str(value))` for a JSON value (number or string). */
export const decimalOf = (value: unknown): Decimal | null => (typeof value === 'string' || typeof value === 'number' ? Decimal.parse(String(value)) : null);
