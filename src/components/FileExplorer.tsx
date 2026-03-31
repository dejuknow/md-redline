import { useState, useEffect, useCallback, useRef } from 'react';
import { getApiErrorMessage, readJsonResponse, type ApiErrorPayload } from '../lib/http';
import { getPathBasename } from '../lib/path-utils';

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
  activeFilePath: string | null;
  onOpenFile: (path: string) => void;
  onClose: () => void;
  onContextMenu?: (info: ExplorerContextMenuInfo) => void;
  hideHeader?: boolean;
}

export function FileExplorer({ initialDir, activeFilePath, onOpenFile, onClose, onContextMenu: onCtxMenu, hideHeader }: Props) {
  const [data, setData] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const browse = useCallback(async (dir?: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    try {
      const params = dir ? `?dir=${encodeURIComponent(dir)}` : '';
      const res = await fetch(`/api/browse${params}`, { signal: controller.signal });
      const result = await readJsonResponse<BrowseResponse>(res);
      if (!res.ok || !result) {
        throw new Error(getApiErrorMessage(res, result, 'Failed to browse'));
      }
      setData(result);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Failed to browse');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    browse(initialDir);
  }, [browse, initialDir]);

  const dirName = getPathBasename(data?.dir || '') || data?.dir || 'Files';

  return (
    <div className="flex flex-col h-full">
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
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
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
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
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

      {/* Error */}
      {error && !data && (
        <div className="flex-1 flex items-center justify-center text-xs text-danger px-3 text-center">
          {error}
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
            onCtxMenu({ type: 'blank', path: data.dir, name: getPathBasename(data.dir) || data.dir, x: e.clientX, y: e.clientY });
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
                onCtxMenu({ type: 'directory', path: dir.path, name: dir.name, x: e.clientX, y: e.clientY });
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
                onClick={() => onOpenFile(file.path)}
                onContextMenu={(e) => {
                  if (!onCtxMenu) return;
                  e.preventDefault();
                  onCtxMenu({ type: 'file', path: file.path, name: file.name, x: e.clientX, y: e.clientY });
                }}
                className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition-colors ${
                  isActive
                    ? 'bg-primary-bg text-primary-text font-medium'
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
