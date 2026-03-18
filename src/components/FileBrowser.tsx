import { useState, useEffect, useCallback } from 'react';

interface BrowseResult {
  dir: string;
  parent: string | null;
  directories: { name: string; path: string }[];
  files: { name: string; path: string }[];
  home: string;
}

interface Props {
  onOpenFile: (path: string) => void;
  initialDir?: string;
}

export function FileBrowser({ onOpenFile, initialDir }: Props) {
  const [data, setData] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const browse = useCallback(async (dir?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = dir ? `?dir=${encodeURIComponent(dir)}` : '';
      const res = await fetch(`/api/browse${params}`);
      const result = await res.json();
      if (!res.ok) throw new Error(result.error);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to browse');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    browse(initialDir);
  }, [browse, initialDir]);

  if (loading && !data) {
    return (
      <div className="text-sm text-slate-400 py-4 text-center">Loading...</div>
    );
  }

  if (error && !data) {
    return (
      <div className="text-sm text-red-500 py-4 text-center">{error}</div>
    );
  }

  if (!data) return null;

  // Build breadcrumb segments from the current dir
  const segments = data.dir.split('/').filter(Boolean);

  return (
    <div>
      {/* Breadcrumb path */}
      <div className="flex items-center gap-1 text-xs text-slate-500 mb-2 overflow-x-auto pb-1">
        <button
          onClick={() => browse('/')}
          className="hover:text-indigo-600 shrink-0"
        >
          /
        </button>
        {segments.map((seg, i) => {
          const path = '/' + segments.slice(0, i + 1).join('/');
          const isLast = i === segments.length - 1;
          return (
            <span key={path} className="flex items-center gap-1">
              <span className="text-slate-300">/</span>
              {isLast ? (
                <span className="font-medium text-slate-700">{seg}</span>
              ) : (
                <button
                  onClick={() => browse(path)}
                  className="hover:text-indigo-600"
                >
                  {seg}
                </button>
              )}
            </span>
          );
        })}

        {/* Quick nav to home */}
        {data.home && data.dir !== data.home && (
          <button
            onClick={() => browse(data.home)}
            className="ml-auto shrink-0 text-xs text-slate-400 hover:text-indigo-600 px-1.5 py-0.5 rounded hover:bg-indigo-50 transition-colors"
            title={data.home}
          >
            ~ Home
          </button>
        )}
      </div>

      {/* Directory listing */}
      <div className="border border-slate-200 rounded-lg overflow-hidden max-h-64 overflow-y-auto">
        {/* Parent directory */}
        {data.parent && (
          <button
            onClick={() => browse(data.parent!)}
            className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-slate-50 transition-colors border-b border-slate-100"
          >
            <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            <span className="text-slate-500">..</span>
          </button>
        )}

        {/* Directories */}
        {data.directories.map((dir) => (
          <button
            key={dir.path}
            onClick={() => browse(dir.path)}
            className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-slate-50 transition-colors border-b border-slate-100 last:border-b-0"
          >
            <svg className="w-4 h-4 text-amber-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
            </svg>
            <span className="text-slate-700 truncate">{dir.name}</span>
          </button>
        ))}

        {/* Markdown files */}
        {data.files.map((file) => (
          <button
            key={file.path}
            onClick={() => onOpenFile(file.path)}
            className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-indigo-50 hover:text-indigo-700 transition-colors border-b border-slate-100 last:border-b-0"
          >
            <svg className="w-4 h-4 text-indigo-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
            <span className="truncate">{file.name}</span>
          </button>
        ))}

        {/* Empty state */}
        {data.directories.length === 0 && data.files.length === 0 && (
          <div className="px-3 py-6 text-center text-sm text-slate-400">
            No markdown files in this directory
          </div>
        )}
      </div>
    </div>
  );
}
