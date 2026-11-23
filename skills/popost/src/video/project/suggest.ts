/** Edit distance and the nearest allowed word, for "did you mean" fixes. */

export const editDistance = (a: string, b: string): number => {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost));
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
};

/** The allowed word nearest to s, when it is close enough to be a likely typo (at most a third of its letters differ). */
export const closest = (s: string, allowed: readonly string[]): string | undefined => {
  const lower = s.toLowerCase();
  const ranked = allowed.map((w) => ({ w, d: editDistance(lower, w.toLowerCase()) })).sort((x, y) => x.d - y.d);
  const best = ranked[0];
  return best && best.d <= Math.max(1, Math.floor(best.w.length / 3)) ? best.w : undefined;
};
