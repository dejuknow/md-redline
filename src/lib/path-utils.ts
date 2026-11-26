export function getPathBasename(path: string): string {
  if (!path) return '';
  const trimmed = path.replace(/[\\/]+$/, '');
  if (!trimmed) return path;
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

/**
 * Replace a leading home-directory prefix with `~` for compact display.
 * Returns the original path unchanged if it does not start with the home dir,
 * or if the home dir is empty. Only the leading prefix is substituted; later
 * occurrences of the home dir string are left alone.
 */
export function tildeShortenPath(path: string, homeDir: string): string {
  if (!path || !homeDir) return path;
  // Strip any trailing slash on the home dir before comparison so the
  // substitution works for both `/Users/dennisju` and `/Users/dennisju/`.
  const normalizedHome = homeDir.replace(/[\\/]+$/, '');
  if (!normalizedHome) return path;
  if (path === normalizedHome) return '~';
  if (path.startsWith(normalizedHome + '/')) {
    return '~' + path.slice(normalizedHome.length);
  }
  if (path.startsWith(normalizedHome + '\\')) {
    return '~' + path.slice(normalizedHome.length);
  }
  return path;
}

/**
 * Shorten a long path for display by eliding whole directory segments from the
 * middle: `/private/tmp/…/scratchpad` rather than a hard character cut, which
 * chops names in half and hides exactly the segment that identifies the folder.
 * The first and last segments always survive, so the result still reads as
 * "somewhere under /private/tmp, in scratchpad". Returns the path unchanged
 * when it already fits or has too few segments to elide anything.
 */
export function middleTruncatePath(path: string, maxLength = 44): string {
  if (!path || path.length <= maxLength) return path;
  // A path with no forward slash at all is Windows-style; anything else keeps
  // POSIX separators, including a mixed path, which is legal on Windows.
  const sep = path.includes('/') ? '/' : '\\';
  // Preserved verbatim (normalized to one separator style) so a UNC path keeps
  // both of its leading slashes: `\\fileserver\…` is a different machine from
  // `\fileserver\…`, and collapsing the prefix would claim the wrong one.
  const leadingMatch = /^[\\/]+/.exec(path);
  const leading = leadingMatch ? leadingMatch[0].replace(/[\\/]/g, sep) : '';
  const segments = path.split(/[\\/]+/).filter(Boolean);
  if (segments.length < 3) return path;

  // Two leading segments where there is room for them, since `/private/tmp/…`
  // places the folder in a way `/private/…` does not. The head shrinks too when
  // it is what blows the budget: `/Volumes/My Passport for Mac 4TB/…` cannot
  // pay for itself, and a head kept at any cost pushes the result back over
  // maxLength and hands the overflow to the caller's CSS.
  for (const headCount of [2, 1, 0]) {
    if (headCount >= segments.length) continue;
    const head = segments.slice(0, headCount);
    // Shrink the tail one segment at a time and stop at the first fit.
    for (let tailCount = segments.length - headCount - 1; tailCount >= 1; tailCount--) {
      const candidate = leading + [...head, '…', ...segments.slice(-tailCount)].join(sep);
      if (candidate.length <= maxLength) return candidate;
    }
  }
  // Even `…/name` overflows, so the final segment alone is over budget. Keep it
  // whole: half a folder name identifies nothing, and the caller clips.
  return leading + ['…', segments[segments.length - 1]].join(sep);
}

/**
 * Directory portion of a path, for both POSIX and Windows separators.
 * Returns an empty string when the path has no directory part, so callers can
 * tell "no parent" from "the root". A POSIX root (`/`) is its own parent; a
 * bare drive (`C:\`) has no parent and returns an empty string.
 */
export function getParentDir(path: string): string {
  if (!path) return '';
  const trimmed = path.replace(/[\\/]+$/, '');
  if (!trimmed) return path.slice(0, 1);
  const lastSep = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (lastSep < 0) return '';
  if (lastSep === 0) return trimmed.slice(0, 1);
  // A drive root keeps its separator: "C:\\file.md" -> "C:\\".
  const parent = trimmed.slice(0, lastSep);
  return /^[A-Za-z]:$/.test(parent) ? parent + trimmed[lastSep] : parent;
}

/** About what fits a tab's folder label (96px of 12px text). */
export const TAB_FOLDER_LABEL_CHARS = 14;

/**
 * For open tabs whose file names collide, a short label that tells each one
 * apart. Paths whose names are unique get no entry.
 *
 * The label is the folder that differs, not the run of shared folders under it:
 * `acme` and `globex` for `/acme/specs/docs/README.md` and
 * `/globex/specs/docs/README.md`. Where two labels would still match, each adds
 * the folder nearest the file that tells them apart, with `…` standing in for
 * shared folders between (`north/…/design`, `north/…/plan`). A label always
 * names its own file: never just a folder another same-named tab also sits
 * in. Labels do not repeat within any realistic group; one of hundreds of
 * tabs can outrun 14 characters, and the tooltip then tells them apart.
 *
 * A label longer than TAB_FOLDER_LABEL_CHARS is shortened around the part that
 * differs: the words every label in the group shares go first, then the rest
 * is cut off the end, in the middle, from the front, or folder by folder,
 * whichever first keeps the group apart at a glance. Dated
 * folders (`2026-01-05-alpha-rollout`) share long prefixes, so cutting their
 * ends would make every label read the same.
 */
export function tabDisambiguators(paths: string[]): Map<string, string> {
  const result = new Map<string, string>();
  const byName = new Map<string, string[]>();
  for (const path of paths) {
    const name = getPathBasename(path) || path;
    const group = byName.get(name);
    if (group) group.push(path);
    else byName.set(name, [path]);
  }
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const labels = groupLabels(group);
    const shown = fitTabLabels(labels);
    group.forEach((path, i) => {
      if (shown[i]) result.set(path, shown[i]);
    });
  }
  return result;
}

/** Each path's folders, nearest the file first. */
function foldersNearestFirst(path: string): string[] {
  return path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .slice(0, -1)
    .filter(Boolean)
    .reverse();
}

/** The chosen folder depths (1 = the file's own folder), far to near, with `…` over gaps. */
function renderDepths(folders: string[], depths: Set<number>): string {
  const ordered = [...depths].sort((a, b) => b - a);
  const out: string[] = [];
  ordered.forEach((depth, i) => {
    if (i > 0 && ordered[i - 1] - depth > 1) out.push('…');
    out.push(folders[depth - 1] ?? '');
  });
  return out.join('/');
}

function groupLabels(group: string[]): string[] {
  const folders = group.map(foldersNearestFirst);
  const suffix = (i: number, depth: number) => folders[i].slice(0, depth).join('\u0000');
  const maxDepth = Math.max(...folders.map((f) => f.length));
  // The shallowest depth at which a path's run of folders is its own; the
  // folder at that depth is the one that differs.
  const own = group.map((_, i) => {
    let depth = 1;
    while (
      depth < maxDepth &&
      group.some((_, j) => j !== i && suffix(j, depth) === suffix(i, depth))
    ) {
      depth += 1;
    }
    return Math.min(depth, folders[i].length);
  });
  const chosen = own.map((depth) => new Set(depth > 0 ? [depth] : []));
  const differs = (i: number, j: number, depth: number) =>
    folders[i][depth - 1] !== folders[j][depth - 1];
  // A label has to name the file, not a folder another tab also sits in:
  // `/w/a/R.md` beside `/w/b/R.md` and `/x/a/R.md` is `w/a`, since "w" alone
  // fits both w files. Each label takes, for every other tab, a folder that
  // differs from it, adding the nearest one where it has none yet.
  group.forEach((_, i) => {
    group.forEach((_, j) => {
      if (j === i || [...chosen[i]].some((depth) => differs(i, j, depth))) return;
      for (let depth = 1; depth <= own[i]; depth++) {
        if (differs(i, j, depth)) {
          chosen[i].add(depth);
          return;
        }
      }
    });
  });
  // Each round, tabs whose labels still match add the nearest folder that
  // differs from another tab in the match. One that has none left to add
  // keeps its label; the others move away from it. A match where nobody can
  // add anything falls back to the full run, which is always distinct.
  for (let round = 0; round < 64; round++) {
    const byText = new Map<string, number[]>();
    group.forEach((_, i) => {
      const text = renderDepths(folders[i], chosen[i]);
      byText.set(text, [...(byText.get(text) ?? []), i]);
    });
    let changed = false;
    for (const match of byText.values()) {
      if (match.length < 2) continue;
      let grew = false;
      for (const i of match) {
        for (let depth = 1; depth <= own[i]; depth++) {
          if (chosen[i].has(depth)) continue;
          if (match.some((j) => j !== i && folders[j][depth - 1] !== folders[i][depth - 1])) {
            chosen[i].add(depth);
            grew = true;
            break;
          }
        }
      }
      if (!grew) {
        for (const i of match) for (let depth = 1; depth <= own[i]; depth++) chosen[i].add(depth);
      }
      changed = true;
    }
    if (!changed) break;
  }
  return group.map((_, i) => renderDepths(folders[i], chosen[i]));
}

const MAX = TAB_FOLDER_LABEL_CHARS;
const cutEnd = (t: string) => (t.length > MAX ? t.slice(0, MAX - 1) + '…' : t);
const cutMiddle = (t: string) => (t.length > MAX ? t.slice(0, 5) + '…' + t.slice(-(MAX - 6)) : t);
const cutFront = (t: string) => (t.length > MAX ? '…' + t.slice(-(MAX - 1)) : t);
const cutEachFolder = (t: string) => {
  if (t.length <= MAX || !t.includes('/')) return cutMiddle(t);
  const parts = t.split('/');
  const named = parts.filter((p) => p !== '…').length;
  // Separators and the `…` placeholders take a character each.
  const fixed = parts.length - 1 + (parts.length - named);
  const each = Math.max(4, Math.floor((MAX - fixed) / named));
  return parts
    .map((p) => (p === '…' || p.length <= each ? p : p.slice(0, each - 1) + '…'))
    .join('/');
};

/**
 * Drops the words every label shares at the same folder position, counted from
 * the file end: `dev-frontend-patterns` and `dev-backend-patterns` become
 * `frontend` and `backend`. Only cuts at `-`, `_`, `.` or a space.
 */
function trimSharedWords(labels: string[]): string[] {
  const split = labels.map((t) => t.split('/'));
  const out = split.map((parts) => [...parts]);
  const shortest = Math.min(...split.map((parts) => parts.length));
  for (let k = 1; k <= shortest; k++) {
    const segs = split.map((parts) => parts[parts.length - k]);
    if (new Set(segs).size < 2 || segs.includes('…')) continue;
    const words = segs.map((seg) => seg.split(/(?<=[-_. ])/));
    let head = 0;
    while (words.every((w) => head < w.length - 1 && w[head] === words[0][head])) head++;
    let tail = 0;
    while (
      words.every(
        (w) =>
          tail < w.length - 1 - head &&
          w[w.length - 1 - tail] === words[0][words[0].length - 1 - tail],
      )
    ) {
      tail++;
    }
    words.forEach((w, i) => {
      const core = w
        .slice(head, w.length - tail)
        .join('')
        .replace(/[-_. ]+$/, '');
      if (core) out[i][out[i].length - k] = core;
    });
  }
  return out.map((parts) => parts.join('/'));
}

/**
 * Whether a group's shortened labels can be told apart: no two the same, and
 * none cut off at the end that reads as the start of another
 * (`alpha-rollou…` beside `alpha-rollout`).
 */
function distinctAtAGlance(shown: string[]): boolean {
  if (new Set(shown).size !== shown.length) return false;
  return !shown.some(
    (a, i) => a.endsWith('…') && shown.some((b, j) => j !== i && b.startsWith(a.slice(0, -1))),
  );
}

/**
 * Shortens a group's long labels the first way that keeps the group apart.
 * Labels that fit stay as they are. For the long ones, the words they all
 * share go first (a common date prefix says nothing), then each cut is tried
 * in turn.
 */
function fitTabLabels(labels: string[]): string[] {
  const long = labels.map((t) => t.length > MAX);
  if (!long.some(Boolean)) return labels;
  const longOnly = labels.filter((_, i) => long[i]);
  const trimmedLong = trimSharedWords(longOnly);
  const trimmed = labels.map((t, i) => (long[i] ? trimmedLong[longOnly.indexOf(t)] : t));
  const fits = (shown: string[]) => distinctAtAGlance(shown) && shown.every((t) => t.length <= MAX);
  for (const source of [trimmed, labels]) {
    for (const cut of [cutEnd, cutMiddle, cutFront, cutEachFolder]) {
      const shown = source.map((t, i) => (long[i] ? cut(t) : t));
      if (fits(shown)) return shown;
    }
  }
  // Only a group too big for this many characters to separate (hundreds of
  // tabs) gets here; the tooltip carries the full path.
  return labels.map((t, i) => (long[i] ? cutMiddle(t) : t));
}
