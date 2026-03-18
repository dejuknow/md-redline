interface Tab {
  filePath: string;
  error: string | null;
}

interface Props {
  tabs: Tab[];
  activeFilePath: string | null;
  onSwitchTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onOpenFile: () => void;
}

export function TabBar({ tabs, activeFilePath, onSwitchTab, onCloseTab, onOpenFile }: Props) {
  return (
    <div className="h-9 bg-slate-50 border-b border-slate-200 flex items-stretch shrink-0 overflow-x-auto">
      {tabs.map((tab) => {
        const isActive = tab.filePath === activeFilePath;
        const fileName = tab.filePath.split('/').pop() || tab.filePath;
        return (
          <button
            key={tab.filePath}
            onClick={() => onSwitchTab(tab.filePath)}
            className={`group flex items-center gap-1.5 px-3 text-xs border-r border-slate-200 shrink-0 max-w-[200px] transition-colors ${
              isActive
                ? 'bg-white text-slate-800 font-medium border-b-2 border-b-indigo-500'
                : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
            }`}
            title={tab.filePath}
          >
            <span className="truncate">{fileName}</span>
            {tab.error && (
              <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
            )}
            <span
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(tab.filePath);
              }}
              className={`ml-1 p-0.5 rounded hover:bg-slate-300/50 shrink-0 transition-opacity ${
                isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              }`}
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </span>
          </button>
        );
      })}
      <button
        onClick={onOpenFile}
        className="px-2.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors shrink-0"
        title="Open file"
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
      </button>
    </div>
  );
}
