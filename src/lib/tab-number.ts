/**
 * The tab a desktop "go to tab N" key picks (Cmd+1 to Cmd+9 on macOS, Ctrl+1
 * to Ctrl+9 elsewhere), as browsers do: 1 to 8 pick that tab, 9 always picks
 * the last one. Returns its index, or null when there is no such tab, so the
 * key does nothing.
 */
export function tabIndexForNumber(n: number, count: number): number | null {
  if (!Number.isInteger(n) || n < 1 || n > 9 || count < 1) return null;
  if (n === 9) return count - 1;
  return n <= count ? n - 1 : null;
}
