/**
 * What a `popost video` command may spend on popost.ai speech, transcription and music, as images are paid: the command first
 * prices everything it will ask for (quotes are free); without --confirm it charges nothing and stops with exit code 3
 * and the price (PriceNotAgreed); with --confirm --max-credits N it goes on, and a call whose quote is above what is
 * left of N is refused before anything is made. The wallet is that N, counted down call by call.
 */
import { ToolError } from './tool';

/** One thing a command will pay for. */
export interface PriceItem {
  kind: 'speech' | 'transcription' | 'music';
  /** What it is, for the user: the line spoken, the sound transcribed, or the music described. */
  what: string;
  credits: number;
  /** Seconds of sound, for a transcription or a music track. */
  seconds?: number;
}

/** The price a command printed instead of charging: { confirm: { credits, balance?, items }, next }, exit code 3. */
export interface PriceToAgree {
  credits: number;
  balance?: number;
  items: PriceItem[];
  /** The --max-credits the price is above, when it was given. */
  maxCredits?: number;
}

/** Nothing was made or charged: the user has to agree to the price first. */
export class PriceNotAgreed extends Error {
  override name = 'PriceNotAgreed';
  constructor(readonly confirm: PriceToAgree, readonly next: string) {
    super('This costs ' + confirm.credits + ' credits; nothing was charged.');
  }
}

/** The exit code of a command that asks for the user's agreement to a price. */
export const CONFIRM_EXIT = 3;

/** The ceiling of a command (--max-credits after --confirm; 0 without), and what it has spent. */
export class Wallet {
  spent = 0;
  constructor(readonly max: number) {}

  get left(): number {
    return Math.max(0, this.max - this.spent);
  }

  /** Throws, before anything is sent, when `credits` is more than what is left. what: the call, for the message. */
  check(credits: number, what: string): void {
    if (credits <= this.left) return;
    throw new ToolError(
      what + ' costs ' + credits + ' credits and ' + (this.max === 0 ? 'no spending was confirmed for this command' : this.left + ' of the --max-credits ' + this.max + ' of this command are left') +
        '; nothing was charged. Run the command without --confirm to see its price, and again with --confirm --max-credits N once the user agrees.',
    );
  }

  pay(credits: number): void {
    this.spent += Math.max(0, credits);
  }
}

/** A wallet that pays nothing: what a hosted call gets when its command confirmed no spending. */
export const NOTHING = (): Wallet => new Wallet(0);
