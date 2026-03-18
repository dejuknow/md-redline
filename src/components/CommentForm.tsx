import { useState, useRef, useEffect } from 'react';
import type { SelectionInfo } from '../types';

interface Props {
  selection: SelectionInfo;
  onSubmit: (anchor: string, text: string) => void;
  onCancel: () => void;
  onLock: () => void;
}

export function CommentForm({
  selection,
  onSubmit,
  onCancel,
  onLock,
}: Props) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isExpanded && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isExpanded]);

  // Reset expanded state when selection changes
  useEffect(() => {
    setIsExpanded(false);
    setText('');
  }, [selection.text, selection.rect.top, selection.rect.left]);

  // Position the form near the selection
  const viewportHeight = window.innerHeight;
  const spaceBelow = viewportHeight - selection.rect.bottom;
  const showAbove = spaceBelow < 200;

  const style: React.CSSProperties = {
    position: 'fixed',
    left: `${Math.min(selection.rect.left, window.innerWidth - 320)}px`,
    ...(showAbove
      ? { bottom: `${viewportHeight - selection.rect.top + 8}px` }
      : { top: `${selection.rect.bottom + 8}px` }),
    zIndex: 50,
  };

  const handleSubmit = () => {
    if (!text.trim()) return;
    onSubmit(selection.text, text.trim());
    setText('');
    setIsExpanded(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  const handleExpand = () => {
    onLock(); // Lock the selection so mouseup events don't clear it
    setIsExpanded(true);
  };

  if (!isExpanded) {
    return (
      <div style={style} data-comment-form>
        <button
          onMouseDown={(e) => e.preventDefault()} // Prevent stealing focus/clearing selection
          onClick={handleExpand}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 text-white text-sm font-medium rounded-lg shadow-lg hover:bg-indigo-700 transition-colors"
        >
          <svg
            className="w-3.5 h-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 4.5v15m7.5-7.5h-15"
            />
          </svg>
          Comment
        </button>
      </div>
    );
  }

  return (
    <div
      style={style}
      data-comment-form
      className="w-80 bg-white rounded-xl shadow-xl border border-slate-200 overflow-hidden"
    >
      {/* Anchor preview */}
      <div className="px-3 pt-3 pb-2 border-b border-slate-100 bg-slate-50/50">
        <p className="text-xs text-slate-500 mb-1">Commenting on:</p>
        <p className="text-xs font-mono text-amber-700 bg-amber-50 rounded px-2 py-1 truncate border border-amber-200">
          &ldquo;{selection.text}&rdquo;
        </p>
      </div>

      {/* Input */}
      <div className="p-3">
        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Add your comment..."
          rows={3}
          className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent placeholder:text-slate-400"
        />
        <div className="flex items-center justify-between mt-2">
          <span className="text-xs text-slate-400">
            {navigator.platform.includes('Mac') ? '\u2318' : 'Ctrl'}+Enter to submit
          </span>
          <div className="flex gap-2">
            <button
              onClick={onCancel}
              className="text-xs px-3 py-1.5 text-slate-600 hover:bg-slate-100 rounded-md transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!text.trim()}
              className="text-xs px-3 py-1.5 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Comment
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
