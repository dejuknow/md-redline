import { useState, useEffect, useCallback, useRef } from 'react';
import { getApiErrorMessage, readJsonResponse, type ApiErrorPayload } from '../lib/http';
import { getParentDir, getPathBasename } from '../lib/path-utils';
import { AccessRequest } from './AccessRequest';

interface BrowseResult {
  dir: string;
  parent: string | null;
  directories: { name: string; path: string }[];
  files: { name: string; path: string }[];
}

type BrowseResponse = BrowseResult & ApiErrorPayload;

export interface ExplorerContextMenuInfo {
  type: 'file' | 'directory' | 'blank';
  path: string;
  name: string;
  x: number;
  y: number;
}

interface Props {
  initialDir?: string;
  /**
   * Bumped by the app on an explicit reveal. Forces a re-browse of `initialDir`
   * even when it did not change, since the user may have navigated the panel
   * somewhere else in the meantime.
   */
  revealNonce?: number;
  /** File to scroll to on a reveal; falls back to the active file. */
  revealPath?: string;
  /**
   * Nonce already consumed by an earlier mount. The panel unmounts whenever the
   * sidebar is toggled, the Outline tab is selected, or focus mode is entered,
   * so consumption has to be owned above this component or a spent reveal
   * re-fires on every remount.
   */
  revealConsumedNonce?: number | null;
  /** Reports the nonce this panel just consumed, so it survives the unmount. */
  onRevealConsumed?: (nonce: number) => void;
  activeFilePath: string | null;
  /** User's home directory; used to tilde-shorten the path in the trust prompt. */
  homeDir?: string;
  onOpenFile: (path: string) => void;
  onClose: () => void;
  onContextMenu?: (info: ExplorerContextMenuInfo) => void;
  hideHeader?: boolean;
  /** Resolves true only when a folder was actually granted. */
  onTrustFolder?: (deniedDir: string) => Promise<boolean>;
  /**
   * True while any surface owns the native picker. Shared rather than local so
   * this panel's button does not keep inviting clicks while the document
   * area's dialog is up; a click that lands then is swallowed by the app's
   * re-entrancy guard and spends this panel's retry on a still-denied folder.
   */
  trustPending?: boolean;
  /**
   * Bumped by the app on every completed grant, including grants made from
   * the document area's card. Both surfaces are usually refused by the same
   * folder, so the panel has to re-browse on someone else's grant or it sits
   * on a stale refusal whose only affordance reopens the picker for a folder
   * that is already trusted.
   */
  grantNonce?: number;
}

export function FileExplorer({
  initialDir,
  revealNonce = 0,
  revealPath,
  revealConsumedNonce = null,
  onRevealConsumed,
  activeFilePath,
  homeDir = '',
  onOpenFile,
  onClose,
  onContextMenu: onCtxMenu,
  hideHeader,
  onTrustFolder,
  trustPending,
  grantNonce = 0,
}: Props) {
  const [data, setData] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<'access-denied' | 'generic' | null>(null);
  const [accessDeniedDir, setAccessDeniedDir] = useState<string | null>(null);
  const [flashPath, setFlashPath] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const activeFileRef = useRef<HTMLButtonElement | null>(null);
  const revealFileRef = useRef<HTMLButtonElement | null>(null);
  // A reveal applies once. The app keeps `revealPath` set after the reveal
  // lands, so without this the revealed row would keep winning every later
  // scroll-into-view and re-flash whenever the active file changed. Seeded from
  // the caller so a remount does not resurrect a spent reveal.
  const consumedRevealRef = useRef<number | null>(revealConsumedNonce);
  // Which reveal the listing in `data` was fetched for. A reveal into the
  // directory already on screen runs the effect below against the stale
  // listing first, and retiring on that would drop a reveal of a file the
  // refresh is about to add.
  const dataRevealNonceRef = useRef<number | null>(null);

  const browse = useCallback(async (dir?: string, forRevealNonce?: number) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    setErrorKind(null);
    setAccessDeniedDir(null);
    try {
      const params = dir ? `?dir=${encodeURIComponent(dir)}` : '';
      const res = await fetch(`/api/browse${params}`, { signal: controller.signal });
      const result = await readJsonResponse<BrowseResponse>(res);
      if (!res.ok || !result) {
        throw new Error(getApiErrorMessage(res, result, 'Failed to browse'));
      }
      setData(result);
      dataRevealNonceRef.current = forRevealNonce ?? null;
    } catch (err) {
      if (controller.signal.aborted) return;
      const msg = err instanceof Error ? err.message : 'Failed to browse';
      setError(msg);
      if (err instanceof Error && err.message.startsWith('Access denied')) {
        setErrorKind('access-denied');
        setAccessDeniedDir(dir ?? '');
      } else {
        setErrorKind('generic');
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    browse(initialDir, revealNonce);
    return () => {
      abortRef.current?.abort();
    };
  }, [browse, initialDir, revealNonce]);

  // Retry a refused browse when a grant lands anywhere in the app, which covers
  // the grant made from the document area's card. Gated on this panel actually
  // being refused so an unrelated grant does not re-fetch a healthy listing.
  const deniedDirRef = useRef<string | null>(null);
  deniedDirRef.current = errorKind === 'access-denied' ? accessDeniedDir : null;
  const firstGrantNonceRef = useRef(grantNonce);
  useEffect(() => {
    if (grantNonce === firstGrantNonceRef.current) return;
    const denied = deniedDirRef.current;
    if (denied !== null) browse(denied);
  }, [grantNonce, browse]);

  // Keep the open file visible when the listing changes or a reveal lands, so
  // it is not stranded below the fold in a long directory. A revealed file that
  // is not the active one gets a brief flash so the eye can find it.
  useEffect(() => {
    if (!data) return;
    const revealPending = revealNonce !== consumedRevealRef.current;
    const revealed = revealPending ? revealFileRef.current : null;
    const target = revealed ?? activeFileRef.current;
    target?.scrollIntoView({ block: 'nearest' });
    if (!revealed) {
      // The listing for the revealed file's own directory has arrived without
      // it (deleted, filtered out), so the request is spent. Retiring it here
      // stops a long-dead reveal from firing if that row ever appears later.
      // A listing for some other directory means the browse is still in
      // flight, so the reveal stays pending.
      // Only retire against the listing this reveal actually fetched: the
      // effect also runs against whatever was already on screen, which for a
      // newly created file does not contain it yet.
      const listingIsForThisReveal = dataRevealNonceRef.current === revealNonce;
      if (
        revealPending &&
        revealPath &&
        listingIsForThisReveal &&
        data.dir === getParentDir(revealPath)
      ) {
        consumedRevealRef.current = revealNonce;
        onRevealConsumed?.(revealNonce);
      }
      return;
    }
    consumedRevealRef.current = revealNonce;
    onRevealConsumed?.(revealNonce);
    setFlashPath(revealPath === activeFilePath ? null : (revealPath ?? null));
  }, [data, activeFilePath, revealPath, revealNonce, onRevealConsumed]);

  // The flash expires on its own clock. Owning the timer here rather than in
  // the reveal effect above means an interruption (the user opening another
  // file mid-flash) re-arms the timer instead of tearing it down and leaving
  // the row highlighted for good.
  useEffect(() => {
    if (!flashPath) return;
    const timer = window.setTimeout(() => setFlashPath(null), 1600);
    return () => window.clearTimeout(timer);
  }, [flashPath]);

  // One boolean rather than a predicate and its hand-written negation below,
  // which desync into either a blank panel or two stacked error states the
  // moment one of the five terms is edited.
  const showAccessRequest = Boolean(
    error && !data && errorKind === 'access-denied' && onTrustFolder && accessDeniedDir,
  );

  const dirName = getPathBasename(data?.dir || '') || data?.dir || 'Files';

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Header */}
      {!hideHeader && (
        <div className="h-10 border-b border-border flex items-center justify-between pl-1 pr-2 shrink-0">
          <span className="px-2.5 py-1.5 rounded text-xs font-medium text-content truncate">
            Explorer
          </span>
          <button
            onClick={onClose}
            className="shrink-0 p-1 rounded-md text-content-muted hover:text-content-secondary hover:bg-tint transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            title="Close panel"
            aria-label="Close panel"
          >
            <svg
              className="w-3.5 h-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Breadcrumb navigation */}
      {data && (
        <div className="px-1.5 py-1 border-b border-border-subtle flex items-center gap-0.5">
          {data.parent && (
            <button
              onClick={() => browse(data.parent!)}
              className="p-1 rounded text-content-muted hover:text-content-secondary hover:bg-tint transition-colors shrink-0"
              title="Go up"
            >
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          )}
          <span className="text-xs text-content-secondary truncate px-1" title={data.dir}>
            {dirName}
          </span>
        </div>
      )}

      {/* Loading */}
      {loading && !data && (
        <div className="flex-1 flex items-center justify-center text-xs text-content-muted">
          Loading...
        </div>
      )}

      {/* A refused folder is a permission ask, not a failure, so it gets the
          same card as the document area rather than red error text. */}
      {showAccessRequest && (
        <AccessRequest
          variant="panel"
          dir={accessDeniedDir}
          homeDir={homeDir}
          pending={trustPending}
          onAllow={async () => {
            // Only re-browse on an actual grant. A cancelled dialog leaves the
            // folder exactly as refused as it was, so refetching costs a round
            // trip and a card flash that reads like the grant failed.
            if (await onTrustFolder!(accessDeniedDir!)) browse(accessDeniedDir!);
          }}
        />
      )}
      {error && !data && !showAccessRequest && (
        <div className="flex-1 flex items-center justify-center text-xs text-danger px-3 text-center">
          <span className="break-all">{error}</span>
        </div>
      )}

      {/* File listing */}
      {data && (
        <div
          className="flex-1 overflow-y-auto py-1"
          onContextMenu={(e) => {
            // Fire on blank space — skip if a file/dir button already handled it
            if (!onCtxMenu || !data) return;
            // If the target is inside a button (file/dir item), let that handler take over
            if ((e.target as HTMLElement).closest('button')) return;
            e.preventDefault();
            onCtxMenu({
              type: 'blank',
              path: data.dir,
              name: getPathBasename(data.dir) || data.dir,
              x: e.clientX,
              y: e.clientY,
            });
          }}
        >
          {/* Directories */}
          {data.directories.map((dir) => (
            <button
              key={dir.path}
              onClick={() => browse(dir.path)}
              onContextMenu={(e) => {
                if (!onCtxMenu) return;
                e.preventDefault();
                onCtxMenu({
                  type: 'directory',
                  path: dir.path,
                  name: dir.name,
                  x: e.clientX,
                  y: e.clientY,
                });
              }}
              className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-tint transition-colors"
            >
              <svg
                className="w-3.5 h-3.5 text-warning shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"
                />
              </svg>
              <span className="text-content truncate">{dir.name}</span>
            </button>
          ))}

          {/* Files */}
          {data.files.map((file) => {
            const isActive = file.path === activeFilePath;
            return (
              <button
                key={file.path}
                ref={(el) => {
                  // A row can be both the reveal target and the active file, so
                  // claim each ref independently. An either/or ternary left
                  // activeFileRef null for that row, and the effect above then
                  // had nothing to scroll to for the rest of the session.
                  if (file.path === revealPath) revealFileRef.current = el;
                  if (isActive) activeFileRef.current = el;
                }}
                onClick={() => onOpenFile(file.path)}
                onContextMenu={(e) => {
                  if (!onCtxMenu) return;
                  e.preventDefault();
                  onCtxMenu({
                    type: 'file',
                    path: file.path,
                    name: file.name,
                    x: e.clientX,
                    y: e.clientY,
                  });
                }}
                className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition-colors ${
                  isActive
                    ? 'bg-primary-bg text-primary-text font-medium'
                    : file.path === flashPath
                      ? 'bg-tint text-content font-medium'
                      : 'text-content hover:bg-tint'
                }`}
                title={file.path}
              >
                <svg
                  className={`w-3.5 h-3.5 shrink-0 ${isActive ? 'text-primary-text' : 'text-content-muted'}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
                  />
                </svg>
                <span className="truncate">{file.name}</span>
              </button>
            );
          })}

          {/* Empty state */}
          {data.directories.length === 0 && data.files.length === 0 && (
            <div className="px-3 py-6 text-center text-[10px] text-content-muted">
              No markdown files
            </div>
          )}
        </div>
      )}
    </div>
  );
}
