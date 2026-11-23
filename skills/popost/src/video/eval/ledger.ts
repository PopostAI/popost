/**
 * The loop's ledger: one JSON line per run. A line is never edited afterwards; a later run adds a new line.
 */
import type { Runtime } from '../../runtime';

export interface LedgerRow {
  /** ISO time of the run. */
  at: string;
  /** 'roundtrip' (synthetic truth), 'floor' (model-free draft against a real reference), or 'decision': what was
   *  decided about the runs before it, and why. A decision is its own line because lines are never edited. */
  kind: 'roundtrip' | 'floor' | 'decision';
  /** One sentence: what was changed and what was expected. 'baseline' for a baseline run. */
  hypothesis: string;
  /** git commit of the code that ran, with '+dirty' when the tree had changes. */
  commit: string;
  /** What was run on: the seeds, or the dataset's name and version. */
  data: string;
  cases: number;
  /** Mean score per dimension over the cases that had something to compare. */
  scores: Record<string, number>;
  /** Anything else worth a number: per-kind accuracy, error in frames. */
  detail: Record<string, number | string>;
  seconds: number;
  /** 'baseline', 'accepted', 'rejected' or 'open'; with the reason. */
  decision: string;
}

/** Adds one line at the end. The file system has no append: the lines already there are read and written back unchanged. */
export const appendLedger = async (rt: Runtime, file: string, row: LedgerRow): Promise<void> => {
  const before = await rt.fs.readText(file).catch(() => '');
  await rt.fs.writeFile(file, before + JSON.stringify(row) + '\n');
};
