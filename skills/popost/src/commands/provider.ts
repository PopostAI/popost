/** `popost provider …`: the provider adapter (check, quote, confirm, manual, host-import) and `provider cli …`, the low-level two-step CLI. */
import type { CommandMain } from '../runtime';
import { adapterMain } from '../providers/adapter';

export const main: CommandMain = (argv, rt) => adapterMain(argv, rt);
