import { useState, useRef, useEffect } from 'react';
import type { SelectionInfo } from '../types';
import { useAutoResize } from '../hooks/useAutoResize';
import { useSettings } from '../contexts/SettingsContext';
import { getPrimaryModifierLabel } from '../lib/platform';

interface Props {
  selection: SelectionInfo;
  autoExpand?: boolean;
  onSubmit: (anchor: string, text: string, contextBefore: string, contextAfter: string, hintOffset: number) => void;
  onCancel: () => void;
  onLock: () => void;
}

export function CommentForm({ selection, autoExpand, onSubmit, onCancel, onLock }: Props) {
  const { settings } = useSettings();
  const TEMPLATES = settings.templates;
  const COMMENT_MAX_LENGTH = settings.commentMaxLength;
  const modLabel = getPrimaryModifierLabel();
  const [isExpanded, setIsExpanded] = useState(!!settings.quickComment);
  const [text, setText] = useState('');
  const [showTemplates, setShowTemplates] = useState(settings.showTemplatesByDefault);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useAutoResize(inputRef, text);

  useEffect(() => {
    if (isExpanded && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isExpanded]);

  // Auto-expand when triggered by keyboard shortcut
  useEffect(() => {
    if (autoExpand && !isExpanded) {
      onLock();
      setIsExpanded(true);
    }
  }, [autoExpand, isExpanded, onLock]);

  // Quick comment: lock selection on mount when starting expanded
  useEffect(() => {
    if (settings.quickComment) {
      onLock();
    }
    // Only run on mount — quickComment won't change mid-lifecycle of this instance
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Click outside: dismiss if expanded with empty text.
  const formRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isExpanded) return;
    const handler = (e: MouseEvent) => {
      if (formRef.current && !formRef.current.contains(e.target as Node) && !text.trim()) {
        onCancel();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isExpanded, text, onCancel]);

  // Reset expanded state when selection changes — derive from selection identity
  const selectionKey = `${selection.text}:${selection.rect.top}:${selection.rect.left}`;
  const [prevSelectionKey, setPrevSelectionKey] = useState(selectionKey);
  if (prevSelectionKey !== selectionKey) {
    setPrevSelectionKey(selectionKey);
    if (!settings.quickComment && isExpanded) setIsExpanded(false);
    if (text) setText('');
    if (showTemplates !== settings.showTemplatesByDefault) setShowTemplates(settings.showTemplatesByDefault);
  }

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
    if (!text.trim() || text.length > COMMENT_MAX_LENGTH) return;
    onSubmit(selection.text, text.trim(), selection.contextBefore, selection.contextAfter, selection.offset);
    setText('');
    setIsExpanded(false);
    setShowTemplates(false);
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

  const handleTemplateClick = (template: string) => {
    setText(template);
    setShowTemplates(false);
    inputRef.current?.focus();
  };

  if (!isExpanded) {
    return (
      <div ref={formRef} style={style} data-comment-form>
        <button
          onMouseDown={(e) => e.preventDefault()} // Prevent stealing focus/clearing selection
          onClick={handleExpand}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-on-primary text-sm font-medium rounded-lg shadow-lg hover:bg-primary-hover transition-colors"
        >
          <svg
            className="w-3.5 h-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Comment
        </button>
      </div>
    );
  }

  return (
    <div
      ref={formRef}
      style={style}
      data-comment-form
      className="w-80 bg-surface-raised rounded-xl shadow-xl border border-border overflow-hidden"
    >
      {/* Anchor preview */}
      <div className="px-3 pt-3 pb-2 border-b border-border-subtle bg-surface-secondary">
        <p className="text-xs text-content-secondary mb-1">Commenting on:</p>
        <p className="text-xs font-mono text-comment-anchor-text bg-comment-anchor-bg rounded px-2 py-1 truncate border border-comment-anchor-border">
          &ldquo;{selection.text}&rdquo;
        </p>
      </div>

      {/* Templates */}
      {showTemplates && (
        <div className="px-3 pt-2 pb-1 border-b border-border-subtle bg-surface-secondary">
          <p className="text-xs text-content-secondary mb-1.5">Quick templates:</p>
          <div className="flex flex-wrap gap-1 mb-1">
            {TEMPLATES.map((t) => (
              <button
                key={t.label}
                onClick={() => handleTemplateClick(t.text)}
                className="text-[10px] px-2 py-1 rounded-md bg-surface border border-border text-content-secondary hover:bg-tint-primary hover:text-primary-text hover:border-primary-border transition-colors"
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Input */}
      <div className="p-3">
        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Add your comment..."
          rows={1}
          maxLength={COMMENT_MAX_LENGTH}
          className="w-full text-sm border border-border rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent placeholder:text-content-muted bg-surface text-content overflow-hidden"
        />
        {text.length > COMMENT_MAX_LENGTH * 0.8 && (
          <p className={`text-right text-xs mt-1 ${
            text.length >= COMMENT_MAX_LENGTH ? 'text-danger font-medium' : 'text-content-muted'
          }`}>
            {text.length}/{COMMENT_MAX_LENGTH}
          </p>
        )}
        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-content-muted">
              {modLabel}+Enter
            </span>
            <button
              onClick={() => setShowTemplates(!showTemplates)}
              className={`text-xs px-1.5 py-0.5 rounded transition-colors ${
                showTemplates
                  ? 'bg-primary-bg-strong text-primary-text'
                  : 'text-content-muted hover:text-primary-text hover:bg-tint-primary'
              }`}
              title="Quick templates"
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
                  d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12"
                />
              </svg>
            </button>
          </div>
          <div className="flex gap-2">
            <button
              onClick={onCancel}
              className="text-xs px-3 py-1.5 text-content-secondary hover:bg-tint rounded-md transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!text.trim() || text.length > COMMENT_MAX_LENGTH}
              className="text-xs px-3 py-1.5 bg-primary text-on-primary rounded-md hover:bg-primary-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Comment
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
