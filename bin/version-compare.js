/**
 * Strict x.y.z compare: true only when candidate is a plain three-part
 * numeric version strictly newer than current. Prerelease tags, missing
 * segments, or non-string input return false, conservatively suppressing
 * an update notice rather than risking a bogus one. mdr publishes plain
 * x.y.z only.
 *
 * @param {unknown} candidate
 * @param {unknown} current
 * @returns {boolean}
 */
export function isNewerVersion(candidate, current) {
  const a = parseTriple(candidate);
  const b = parseTriple(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

/**
 * @param {unknown} value
 * @returns {[number, number, number] | null}
 */
function parseTriple(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
