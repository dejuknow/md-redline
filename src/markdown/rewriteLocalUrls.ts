/**
 * Hand-rolled POSIX path helpers. The rewriter runs in the browser and must
 * not depend on Node's `path` module. Markdown URLs are POSIX-style by
 * convention; we don't try to interpret Windows backslash paths.
 */
export function posixDirname(p: string): string {
  if (p === '/' || p === '') return '/';
  // Strip a single trailing slash so '/foo/bar/' → '/foo'
  const stripped = p.endsWith('/') ? p.slice(0, -1) : p;
  const idx = stripped.lastIndexOf('/');
  if (idx < 0) return '.';
  if (idx === 0) return '/';
  return stripped.slice(0, idx);
}

/**
 * Resolve `target` against `base` using POSIX semantics. If `target` is
 * absolute, it's returned as-is. Otherwise we join with `base`, split into
 * segments, and collapse `.` and `..` (without climbing above root).
 */
export function posixResolve(base: string, target: string): string {
  if (target.startsWith('/')) {
    return collapseSegments(target);
  }
  if (base === '') {
    return collapseSegments(target);
  }
  const joined = base.endsWith('/') ? `${base}${target}` : `${base}/${target}`;
  return collapseSegments(joined);
}

function collapseSegments(p: string): string {
  const isAbsolute = p.startsWith('/');
  const out: string[] = [];
  for (const segment of p.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return (isAbsolute ? '/' : '') + out.join('/');
}

export type ClassifiedUrl =
  | { kind: 'external' }
  | { kind: 'fragment' }
  | { kind: 'absolute'; path: string; fragment: string | undefined }
  | { kind: 'relative'; path: string; fragment: string | undefined };

/**
 * Classify a URL string from a markdown link or image. Returns the kind
 * plus the decoded filesystem path and fragment for local kinds.
 */
export function classifyUrl(url: string): ClassifiedUrl {
  if (url === '') return { kind: 'external' };
  if (url.startsWith('#')) return { kind: 'fragment' };
  if (url.startsWith('//')) return { kind: 'external' };

  // file:// URLs become absolute filesystem paths.
  // file:///abs/path → path starts with '/' (valid absolute).
  // file://host/path → UNC-style; path does not start with '/'; treat as external.
  if (url.startsWith('file://')) {
    const stripped = url.slice('file://'.length);
    const { path, fragment } = splitFragment(stripped);
    const { path: noQuery } = splitQuery(path);
    const decoded = safeDecode(noQuery);
    if (!decoded.startsWith('/')) return { kind: 'external' };
    return { kind: 'absolute', path: decoded, fragment };
  }

  // Any other scheme (https:, mailto:, data:, tel:, etc.) is external.
  // Match a leading "scheme:" before the first slash.
  const schemeMatch = url.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:/);
  if (schemeMatch) return { kind: 'external' };

  // Windows backslash paths fall through here. Left alone.
  if (url.includes('\\')) return { kind: 'external' };

  const { path, fragment } = splitFragment(url);
  const { path: noQuery } = splitQuery(path);
  const decoded = safeDecode(noQuery);

  // Re-check for a scheme on the decoded path. A markdown link like
  // `[x](javascript%3aalert%281%29)` is not detected as having a scheme by
  // the pre-decode regex above (because `:` is encoded as `%3a`), but the
  // browser will decode it on click. Treat anything that decodes to a
  // scheme-prefixed string as external so the rewriter does not stamp our
  // own data attrs onto it. The HTML sanitizer's URL allowlist will then
  // strip the dangerous href on its way out.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(decoded)) {
    return { kind: 'external' };
  }

  if (decoded.startsWith('/')) {
    return { kind: 'absolute', path: decoded, fragment };
  }
  return { kind: 'relative', path: decoded, fragment };
}

function splitFragment(s: string): { path: string; fragment: string | undefined } {
  const idx = s.indexOf('#');
  if (idx < 0) return { path: s, fragment: undefined };
  return { path: s.slice(0, idx), fragment: s.slice(idx + 1) || undefined };
}

function splitQuery(s: string): { path: string; query: string | undefined } {
  const idx = s.indexOf('?');
  if (idx < 0) return { path: s, query: undefined };
  return { path: s.slice(0, idx), query: s.slice(idx + 1) || undefined };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

import type { Plugin } from 'unified';
import type { Root, Element } from 'hast';
import { visit } from 'unist-util-visit';

interface Options {
  filePath?: string;
}

const IMAGE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.avif',
  '.ico',
  '.bmp',
]);

export function getExt(p: string): string {
  const idx = p.lastIndexOf('.');
  // Reject "no extension" (idx < 0) and pure dotfiles like ".hidden" (idx === 0)
  if (idx <= 0) return '';
  // Guard against a dot in a directory segment
  if (p.lastIndexOf('/') > idx) return '';
  return p.slice(idx).toLowerCase();
}

function buildAssetUrl(absPath: string): string {
  return `/api/asset?path=${encodeURIComponent(absPath)}`;
}

function resolveAgainstBase(
  classified: Extract<ClassifiedUrl, { kind: 'absolute' | 'relative' }>,
  baseDir: string | null,
): string | null {
  if (classified.kind === 'absolute') return classified.path;
  if (baseDir == null) return null;
  return posixResolve(baseDir, classified.path);
}

function rewriteImg(node: Element, baseDir: string | null): void {
  const props = node.properties ?? {};
  const src = props['src'];
  if (typeof src !== 'string') return;

  const classified = classifyUrl(src);
  if (classified.kind !== 'absolute' && classified.kind !== 'relative') return;

  const ext = getExt(classified.path);
  if (!IMAGE_EXTS.has(ext)) return;

  const abs = resolveAgainstBase(classified, baseDir);
  if (abs == null) return;

  props['src'] = buildAssetUrl(abs);
  node.properties = props;
}

function rewriteAnchor(node: Element, baseDir: string | null): void {
  const props = node.properties ?? {};
  const href = props['href'];
  if (typeof href !== 'string') return;

  const classified = classifyUrl(href);

  // External http(s) and protocol-relative links open in a new tab.
  // mailto:, tel:, data:, etc. are left alone. A new tab makes no sense for them.
  if (classified.kind === 'external') {
    if (/^(https?:\/\/|\/\/)/i.test(href)) {
      props['target'] = '_blank';
      props['rel'] = 'noopener noreferrer';
      node.properties = props;
    }
    return;
  }

  if (classified.kind !== 'absolute' && classified.kind !== 'relative') return;

  const ext = getExt(classified.path);
  if (ext !== '.md') return;

  const abs = resolveAgainstBase(classified, baseDir);
  if (abs == null) return;

  props['href'] = '#';
  props['dataMdrLocalMd'] = abs;
  if (classified.fragment) {
    props['dataMdrFragment'] = classified.fragment;
  }
  node.properties = props;
}

export const rewriteLocalUrls: Plugin<[Options?], Root> = (options) => {
  const filePath = options?.filePath;
  const baseDir = filePath ? posixDirname(filePath) : null;

  return (tree) => {
    visit(tree, 'element', (node: Element) => {
      if (node.tagName === 'img') {
        rewriteImg(node, baseDir);
      } else if (node.tagName === 'a') {
        rewriteAnchor(node, baseDir);
      }
    });
  };
};
