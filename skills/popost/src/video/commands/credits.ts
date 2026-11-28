/**
 * --confirm --max-credits N of the `popost video` commands that may pay popost.ai (transcript, describe, readback,
 * retarget --speak, template fill --speak, plan --voice, voice speak, music make; materials and generate for clips and pictures),
 * as images are paid: the price first (free quotes), then the user's agreement, then the work within N. N is what is
 * left of the one budget the user agreed to for the whole video; every paid command prints chargedCredits.
 */
import type { OptionSpec, ParsedArgs } from '../../args';
import type { Runtime } from '../../runtime';
import { accountBalance } from '../hosted-api';
import { PriceNotAgreed, Wallet, type PriceItem } from '../wallet';
import { VideoCommandError } from './shared';

export const CREDIT_OPTIONS: readonly OptionSpec[] = [
  { flag: '--confirm', kind: 'flag', help: 'the user agreed to the price this command printed without it (exit code 3), or it fits what is left of the budget they agreed to for this video: popost.ai may charge, within --max-credits' },
  { flag: '--max-credits', kind: 'int', metavar: 'N', help: 'with --confirm: the most this whole command may spend, in credits (what is left of the budget of the video)' },
];

const NEXT =
  'Nothing was charged. When these credits fit what is left of the budget the user agreed to for this video, run the same command again with --confirm --max-credits <what is left>; otherwise show the user the credits (and the balance) and run it so once they agree.';

export const OVER =
  'This costs more than --max-credits, what is left of the agreed budget; nothing was charged. Show the user the credits (and the balance), and run the same command again with --confirm --max-credits N (N at least the credits) only once they agree to more.';

/** The ceiling of a command: --max-credits after --confirm; undefined without --confirm. Checks the two go together. */
export const ceilingOf = (args: ParsedArgs): number | undefined => {
  const confirmed = args.flag('confirm');
  const max = args.number('max-credits');
  if (max !== undefined && max < 0) throw new VideoCommandError('--max-credits is a number of credits, 0 or more.');
  if (confirmed && max === undefined) throw new VideoCommandError('--confirm needs --max-credits N: the most this command may spend, in credits.');
  return confirmed ? max : undefined;
};

/**
 * The wallet of a command that will ask for `items`. Nothing to pay: a wallet of --max-credits (0 without --confirm).
 * Else, in this order: a balance known to be short is INSUFFICIENT_CREDITS; without --confirm, or above --max-credits,
 * PriceNotAgreed (exit code 3, nothing charged). Nothing has been made then.
 */
export const walletFor = async (rt: Runtime, args: ParsedArgs, items: readonly PriceItem[]): Promise<Wallet> => {
  const max = ceilingOf(args);
  const credits = items.reduce((n, i) => n + i.credits, 0);
  if (credits === 0) return new Wallet(max ?? 0);
  const balance = await accountBalance(rt);
  if (balance !== undefined && balance < credits)
    throw new VideoCommandError('Not enough credits: this needs ' + credits + ' credits and the balance is ' + balance + '. Nothing was charged; popost account shows the balance and where to buy more. [INSUFFICIENT_CREDITS]');
  const price = { credits, ...(balance !== undefined ? { balance } : {}), items: [...items] };
  if (max === undefined) throw new PriceNotAgreed(price, NEXT);
  if (credits > max) throw new PriceNotAgreed({ ...price, maxCredits: max }, OVER);
  return new Wallet(max);
};
