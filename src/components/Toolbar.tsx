export type ViewMode = 'rendered' | 'raw';

interface Props {
  filePath: string;
  lastSaved: Date | null;
  error: string | null;
  isLoading: boolean;
  commentCount: number;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  onReload: () => void;
}

export function Toolbar({
  filePath,
  lastSaved,
  error,
  isLoading,
  commentCount,
  viewMode,
  onViewModeChange,
  onReload,
}: Props) {
  const fileName = filePath.split('/').pop() || filePath;

  return (
    <div className="h-12 border-b border-slate-200 bg-white flex items-center px-4 gap-3 shrink-0">
      {/* App logo */}
      <div className="flex items-center gap-2">
        <svg className="w-5 h-5 text-indigo-600" viewBox="0 0 32 32" fill="none">
          <rect
            x="4"
            y="2"
            width="18"
            height="24"
            rx="2"
            fill="currentColor"
            opacity="0.15"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <line x1="8" y1="8" x2="18" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <line x1="8" y1="12" x2="16" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <line x1="8" y1="16" x2="18" y2="16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <path
            d="M18 18h8a2 2 0 012 2v6a2 2 0 01-2 2h-4l-3 3v-3h-1a2 2 0 01-2-2v-6a2 2 0 012-2z"
            fill="#f59e0b"
            stroke="#d97706"
            strokeWidth="1"
          />
        </svg>
        <span className="text-sm font-semibold text-slate-700">md-commenter</span>
      </div>

      {/* Separator */}
      <div className="h-5 w-px bg-slate-200" />

      {/* File info */}
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <span className="text-sm text-slate-600 truncate font-medium" title={filePath}>
          {fileName}
        </span>
        {commentCount > 0 && (
          <span className="text-xs bg-indigo-100 text-indigo-600 px-1.5 py-0.5 rounded-full font-medium">
            {commentCount}
          </span>
        )}
      </div>

      {/* Status */}
      <div className="flex items-center gap-2">
        {error && (
          <span className="text-xs text-red-500 font-medium">{error}</span>
        )}
        {isLoading && (
          <span className="text-xs text-slate-400">Loading...</span>
        )}
        {lastSaved && !error && !isLoading && (
          <span className="text-xs text-slate-400">
            Saved {lastSaved.toLocaleTimeString()}
          </span>
        )}

        {/* Raw markdown toggle */}
        <button
          onClick={() => onViewModeChange(viewMode === 'raw' ? 'rendered' : 'raw')}
          className={`p-1 rounded transition-colors ${
            viewMode === 'raw'
              ? 'text-indigo-600 bg-indigo-50'
              : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'
          }`}
          title={viewMode === 'raw' ? 'Switch to rendered view' : 'View raw markdown'}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
          </svg>
        </button>

        {/* Reload button */}
        <button
          onClick={onReload}
          className="text-slate-400 hover:text-slate-600 transition-colors p-1 rounded hover:bg-slate-100"
          title="Reload file"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
