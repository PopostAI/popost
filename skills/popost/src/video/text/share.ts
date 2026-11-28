/** A share of the caption lines in words a person keeps in mind: 0.25 is "about 1 line in 4". */
export const oneIn = (share: number): string => {
  if (share >= 0.85) return 'nearly every line';
  if (share >= 0.6) return 'about 2 lines in 3';
  if (share >= 0.42) return 'about every second line';
  return 'about 1 line in ' + Math.max(3, Math.round(1 / Math.max(0.01, share)));
};
