interface Tab {
  filePath: string;
  error: string | null;
}

interface Props {
  tabs: Tab[];
  activeFilePath: string | null;
  commentCounts: Map<string, number>;
  onSwitchTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onOpenFile: () => void;
}

export function TabBar({
  tabs,
  activeFilePath,
  commentCounts,
  onSwitchTab,
  onCloseTab,
  onOpenFile,
}: Props) {
  return (
    <div className="h-9 bg-surface-secondary border-b border-border flex items-stretch shrink-0 overflow-x-auto">
      {tabs.map((tab) => {
        const isActive = tab.filePath === activeFilePath;
        const fileName = tab.filePath.split('/').pop() || tab.filePath;
        const count = commentCounts.get(tab.filePath) ?? 0;
        return (
          <button
            key={tab.filePath}
            onClick={() => onSwitchTab(tab.filePath)}
            className={`group flex items-center gap-1.5 px-3 text-xs border-r border-border shrink-0 max-w-[200px] transition-colors ${
              isActive
                ? 'bg-surface text-content font-medium border-b-2 border-b-primary'
                : 'text-content-secondary hover:text-content hover:bg-surface-inset'
            }`}
            title={tab.filePath}
          >
            <span className="truncate">{fileName}</span>
            {count > 0 && (
              <span
                className={`text-[10px] font-medium px-1 min-w-[16px] text-center rounded-full shrink-0 ${
                  isActive ? 'bg-primary-bg-strong text-primary-text' : 'bg-surface-inset text-content-secondary'
                }`}
              >
                {count}
              </span>
            )}
            {tab.error && <span className="w-1.5 h-1.5 rounded-full bg-danger shrink-0" />}
            <span
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(tab.filePath);
              }}
              className={`ml-1 p-0.5 rounded hover:bg-surface-inset shrink-0 transition-opacity ${
                isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              }`}
            >
              <svg
                className="w-3 h-3"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </span>
          </button>
        );
      })}
      <button
        onClick={onOpenFile}
        className="px-2.5 text-content-muted hover:text-content-secondary hover:bg-surface-inset transition-colors shrink-0"
        title="Open file"
      >
        <svg
          className="w-4 h-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
      </button>
    </div>
  );
}
