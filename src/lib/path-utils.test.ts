import { describe, expect, it } from 'vitest';
import {
  getParentDir,
  getPathBasename,
  middleTruncatePath,
  TAB_FOLDER_LABEL_CHARS,
  tabDisambiguators,
  tildeShortenPath,
} from './path-utils';

describe('middleTruncatePath', () => {
  it('leaves a path that already fits alone', () => {
    expect(middleTruncatePath('/tmp/notes', 44)).toBe('/tmp/notes');
  });

  it('elides middle segments and keeps the first and last', () => {
    const long =
      '/private/tmp/claude-503/-Users-dennisju-dev-buela-product-management-designer-jd/1a7f55ac-00f8-4f15-a8b2-4b820badf2a2/scratchpad';
    const out = middleTruncatePath(long, 44);
    expect(out.startsWith('/private/')).toBe(true);
    expect(out.endsWith('/scratchpad')).toBe(true);
    expect(out).toContain('…');
    expect(out.length).toBeLessThanOrEqual(44);
  });

  it('keeps as many trailing segments as fit', () => {
    expect(middleTruncatePath('/aaa/bbb/ccc/ddd/eee/fff', 20)).toBe('/aaa/bbb/…/eee/fff');
  });

  it('keeps two leading segments so the path stays placeable', () => {
    const out = middleTruncatePath(
      '/private/tmp/claude-503/-Users-dennisju-dev-buela-product-management-designer-jd/1a7f55ac-00f8-4f15-a8b2-4b820badf2a2/scratchpad',
      44,
    );
    expect(out).toBe('/private/tmp/…/scratchpad');
  });

  it('preserves a tilde-shortened prefix', () => {
    expect(middleTruncatePath('~/dev/some/deeply/nested/place/scratchpad', 24)).toBe(
      '~/dev/…/place/scratchpad',
    );
  });

  it('handles Windows separators', () => {
    expect(middleTruncatePath('C:\\Users\\dennisju\\dev\\projects\\notes', 20)).toBe(
      'C:\\Users\\…\\notes',
    );
  });

  it('never cuts the final segment, even when it alone overflows', () => {
    const out = middleTruncatePath('/a/b/an-extremely-long-single-folder-name-here', 20);
    expect(out).toBe('/…/an-extremely-long-single-folder-name-here');
  });

  it('drops the head rather than blowing the budget on a long leading segment', () => {
    const out = middleTruncatePath('/Volumes/My Passport for Mac 4TB/projects/notes', 28);
    expect(out.length).toBeLessThanOrEqual(28);
    expect(out.endsWith('/notes')).toBe(true);
  });

  it('stays within budget when every leading segment is oversized', () => {
    const out = middleTruncatePath(`/${'a'.repeat(30)}/${'b'.repeat(30)}/c/d`, 28);
    expect(out.length).toBeLessThanOrEqual(28);
    expect(out.endsWith('/d')).toBe(true);
  });

  it('keeps both leading slashes on a UNC path', () => {
    expect(middleTruncatePath('\\\\fileserver\\share\\team\\docs\\notes', 28)).toBe(
      '\\\\fileserver\\share\\…\\notes',
    );
  });

  it('returns paths with too few segments unchanged', () => {
    expect(middleTruncatePath('/a-very-long-folder-name-that-overflows', 10)).toBe(
      '/a-very-long-folder-name-that-overflows',
    );
  });
});

describe('getPathBasename', () => {
  it('returns the basename for POSIX paths', () => {
    expect(getPathBasename('/tmp/docs/spec.md')).toBe('spec.md');
  });

  it('returns the basename for Windows paths', () => {
    expect(getPathBasename('C:\\docs\\spec.md')).toBe('spec.md');
  });

  it('trims trailing separators before reading the basename', () => {
    expect(getPathBasename('/tmp/docs/')).toBe('docs');
    expect(getPathBasename('C:\\docs\\')).toBe('docs');
  });
});

describe('tildeShortenPath', () => {
  it('replaces a leading POSIX home dir prefix with ~', () => {
    expect(tildeShortenPath('/Users/dennisju/dev/temp', '/Users/dennisju')).toBe('~/dev/temp');
  });

  it('returns the path unchanged when it does not start with the home dir', () => {
    expect(tildeShortenPath('/tmp/scratch.md', '/Users/dennisju')).toBe('/tmp/scratch.md');
  });

  it('returns just ~ when the path equals the home dir', () => {
    expect(tildeShortenPath('/Users/dennisju', '/Users/dennisju')).toBe('~');
  });

  it('returns the path unchanged when home dir is empty', () => {
    expect(tildeShortenPath('/Users/dennisju/dev', '')).toBe('/Users/dennisju/dev');
  });

  it('returns the path unchanged when path is empty', () => {
    expect(tildeShortenPath('', '/Users/dennisju')).toBe('');
  });

  it('handles a trailing slash on the home dir', () => {
    expect(tildeShortenPath('/Users/dennisju/dev', '/Users/dennisju/')).toBe('~/dev');
  });

  it('does not match a path that merely contains the home dir as a substring', () => {
    expect(tildeShortenPath('/var/Users/dennisju', '/Users/dennisju')).toBe('/var/Users/dennisju');
  });

  it('does not match a path that starts with the home dir but lacks a separator boundary', () => {
    expect(tildeShortenPath('/Users/dennisjustmore', '/Users/dennisju')).toBe(
      '/Users/dennisjustmore',
    );
  });

  it('replaces a leading Windows-style home dir prefix with ~', () => {
    expect(tildeShortenPath('C:\\Users\\dennisju\\dev', 'C:\\Users\\dennisju')).toBe('~\\dev');
  });
});

describe('getParentDir', () => {
  it('returns the directory for a POSIX path', () => {
    expect(getParentDir('/Users/dennis/docs/spec.md')).toBe('/Users/dennis/docs');
  });

  it('returns the root for a file directly under it', () => {
    expect(getParentDir('/spec.md')).toBe('/');
  });

  it('handles Windows separators', () => {
    expect(getParentDir('C:\\docs\\spec.md')).toBe('C:\\docs');
  });

  it('keeps the separator on a drive root', () => {
    expect(getParentDir('C:\\spec.md')).toBe('C:\\');
  });

  it('returns an empty string when there is no directory part', () => {
    expect(getParentDir('spec.md')).toBe('');
    expect(getParentDir('')).toBe('');
  });

  it('ignores a trailing separator', () => {
    expect(getParentDir('/Users/dennis/docs/')).toBe('/Users/dennis');
  });
});

describe('tabDisambiguators', () => {
  const labels = (paths: string[]) => {
    const m = tabDisambiguators(paths);
    return paths.map((p) => m.get(p));
  };

  it('leaves unique names alone', () => {
    expect(tabDisambiguators(['/a/spec.md', '/b/plan.md']).size).toBe(0);
  });

  it('labels colliding names with their nearest folder when that tells them apart', () => {
    expect(labels(['/p/docs/README.md', '/p/README.md', '/p/plan.md'])).toEqual([
      'docs',
      'p',
      undefined,
    ]);
  });

  it('shows only the folder that differs, not the shared folders under it', () => {
    expect(
      labels(['/work/acme/specs/docs/README.md', '/work/globex/specs/docs/README.md']),
    ).toEqual(['acme', 'globex']);
  });

  it('only walks as far as each path needs', () => {
    expect(
      labels(['/one/docs/README.md', '/two/docs/README.md', '/three/specs/README.md']),
    ).toEqual(['one', 'two', 'specs']);
  });

  it('adds the folder that tells two labels apart when the first ones match', () => {
    // The folders that differ first are m, n and m; the two m tabs then
    // differ one folder down.
    expect(labels(['/m/k/d/R.md', '/n/k/d/R.md', '/k/m/d/R.md'])).toEqual(['m/k', 'n', 'm']);
  });

  it('elides shared folders between the two that differ', () => {
    expect(
      labels([
        '/w/north/spec/feature/design/R.md',
        '/w/north/spec/feature/plan/R.md',
        '/w/south/spec/feature/design/R.md',
        '/w/south/spec/feature/plan/R.md',
      ]),
    ).toEqual(['north/…/design', 'north/…/plan', 'south/…/design', 'south/…/plan']);
  });

  it('never repeats a label in a group', () => {
    const paths = [
      '/a/README.md',
      '/x/a/README.md',
      '/m/k/d/README.md',
      '/n/k/d/README.md',
      '/k/m/d/README.md',
      '/m/kz/d/README.md',
    ];
    const shown = labels(paths);
    expect(new Set(shown).size).toBe(paths.length);
  });

  it('shortens long labels around the part that differs, not off the end', () => {
    // Dated folders share a long prefix, so cutting the end would leave
    // every label reading "2026-01-05-al…".
    const shown = labels([
      '/specs/2026-01-05-alpha-rollout/plan.md',
      '/specs/2026-01-05-alpha-rollout-notes/plan.md',
      '/specs/2026-01-05-beta-signup/plan.md',
    ]);
    for (const text of shown) expect(text!.length).toBeLessThanOrEqual(TAB_FOLDER_LABEL_CHARS);
    expect(new Set(shown).size).toBe(3);
    // The date every label shares goes first; it tells none of them apart.
    expect(shown.some((text) => text!.startsWith('2026'))).toBe(false);
    // And no label reads as the cut-off start of another.
    for (const a of shown)
      for (const b of shown)
        if (a !== b && a!.endsWith('…')) expect(b!.startsWith(a!.slice(0, -1))).toBe(false);
  });

  it('keeps labels that fit whole, even when they share words', () => {
    expect(labels(['/a/dev-front/R.md', '/a/dev-back/R.md'])).toEqual(['dev-front', 'dev-back']);
  });

  it('keeps shortened multi-folder labels distinct', () => {
    const shown = labels([
      '/w/.local/skills/frontend-patterns/rules/R.md',
      '/w/shared-skills/skills/frontend-patterns/rules/R.md',
      '/w/shared-skills/skills/backend-patterns/rules/R.md',
      '/w/.local/skills/backend-patterns/rules/R.md',
    ]);
    for (const text of shown) expect(text!.length).toBeLessThanOrEqual(TAB_FOLDER_LABEL_CHARS);
    expect(new Set(shown).size).toBe(4);
  });

  it('drops shared words when folders differ only in the middle of their names', () => {
    const shown = labels([
      '/w/.local/skills/dev-frontend-patterns/guides/R.md',
      '/w/shared-skills/skills/dev-frontend-patterns/guides/R.md',
      '/w/shared-skills/skills/dev-backend-patterns/guides/R.md',
      '/w/.local/skills/dev-backend-patterns/guides/R.md',
    ]);
    for (const text of shown) expect(text!.length).toBeLessThanOrEqual(TAB_FOLDER_LABEL_CHARS);
    expect(new Set(shown).size).toBe(4);
    expect(shown.some((text) => text!.includes('front'))).toBe(true);
  });

  it('names the file, not a folder another tab also sits in', () => {
    // /w/b/R.md is in w too, so "w" alone would not say which file this is.
    expect(labels(['/w/a/R.md', '/w/b/R.md', '/x/a/R.md'])).toEqual(['w/a', 'b', 'x']);
  });

  it('trims shared words from the long labels even when a short one shares none', () => {
    const paths = [
      '/a/project-alpha-workspace-one/R.md',
      '/a/project-alpha-workspace-two/R.md',
      '/a/project-beta-workspace-one/R.md',
      '/a/project-beta-workspace-two/R.md',
      '/b/project-alpha-workspace-one/R.md',
    ];
    const shown = labels(paths);
    expect(new Set(shown).size).toBe(paths.length);
    for (const text of shown) expect(text!.length).toBeLessThanOrEqual(TAB_FOLDER_LABEL_CHARS);
  });

  it('leaves labels that fit alone when another in the group is shortened', () => {
    const shown = labels(['/a/dev-front/R.md', '/a/dev-backend-services-extra/R.md']);
    expect(shown[0]).toBe('dev-front');
    expect(shown[1]!.length).toBeLessThanOrEqual(TAB_FOLDER_LABEL_CHARS);
  });

  it('reads Windows separators', () => {
    expect(labels(['C:\\one\\spec.md', 'C:\\two\\spec.md'])).toEqual(['one', 'two']);
  });
});
