import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import type { SelectionInfo } from '../types';
import { useAutoResize } from '../hooks/useAutoResize';
import { useSettings } from '../contexts/SettingsContext';
import { getPrimaryModifierLabel } from '../lib/platform';

interface Props {
  selection: SelectionInfo;
  autoExpand?: boolean;
  onSubmit: (
    anchor: string,
    text: string,
    contextBefore: string,
    contextAfter: string,
    hintOffset: number,
  ) => void;
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
  const [showTemplates, setShowTemplates] = useState(
    settings.quickComment ? settings.showTemplatesByDefault : false,
  );
  const [showPillMenu, setShowPillMenu] = useState(false);
  // The selection rect is a snapshot from selection time; on scroll the pill
  // follows its text instead of floating over whatever scrolled underneath.
  // Preferred source is the live DOM selection; when that has been collapsed
  // (locked selections survive as SelectionInfo only), fall back to shifting
  // the snapshot by how far the document scroller moved since capture.
  const [liveRect, setLiveRect] = useState<{ top: number; bottom: number; left: number } | null>(
    null,
  );
  const scrollBaselineRef = useRef<number | null>(null);
  const getDocScroller = () =>
    (document.querySelector('[data-doc-page]')?.parentElement as HTMLElement | null) ?? null;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const [formSize, setFormSize] = useState<{ height: number; width: number } | null>(null);
  useAutoResize(inputRef, text);

  useEffect(() => {
    if (isExpanded && inputRef.current) {
      const el = inputRef.current;
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
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

  // Reset expanded state when selection changes
  const selectionKey = `${selection.text}:${selection.rect.top}:${selection.rect.left}`;
  const prevSelectionKeyRef = useRef(selectionKey);
  useEffect(() => {
    if (prevSelectionKeyRef.current !== selectionKey) {
      prevSelectionKeyRef.current = selectionKey;
      if (!settings.quickComment) setIsExpanded(false);
      setText('');
      setShowTemplates(settings.quickComment ? settings.showTemplatesByDefault : false);
      setShowPillMenu(false);
      setLiveRect(null);
      scrollBaselineRef.current = getDocScroller()?.scrollTop ?? null;
      setFormSize(null);
    }
  }, [selectionKey, settings.quickComment, settings.showTemplatesByDefault]);

  // Baseline for the scroll-delta fallback, captured once per mount (the
  // selection-change effect above refreshes it for subsequent selections).
  useEffect(() => {
    scrollBaselineRef.current = getDocScroller()?.scrollTop ?? null;
  }, []);

  // Follow the selection while the pill is showing. Capture-phase listener
  // catches the document panel's inner scroll container without needing a ref
  // to it.
  useEffect(() => {
    if (isExpanded) return;
    const remeasure = () => {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
        const r = sel.getRangeAt(0).getBoundingClientRect();
        setLiveRect((prev) =>
          prev && prev.top === r.top && prev.bottom === r.bottom && prev.left === r.left
            ? prev
            : { top: r.top, bottom: r.bottom, left: r.left },
        );
        return;
      }
      const scroller = getDocScroller();
      if (!scroller || scrollBaselineRef.current === null) return;
      const delta = scroller.scrollTop - scrollBaselineRef.current;
      const next = {
        top: selection.rect.top - delta,
        bottom: selection.rect.bottom - delta,
        left: selection.rect.left,
      };
      setLiveRect((prev) =>
        prev && prev.top === next.top && prev.bottom === next.bottom && prev.left === next.left
          ? prev
          : next,
      );
    };
    document.addEventListener('scroll', remeasure, { capture: true, passive: true });
    return () =>
      document.removeEventListener('scroll', remeasure, { capture: true } as EventListenerOptions);
  }, [isExpanded, selection.rect]);

  useLayoutEffect(() => {
    const node = formRef.current;
    if (!node) return;

    const nextSize = {
      height: Math.ceil(node.getBoundingClientRect().height),
      width: Math.ceil(node.getBoundingClientRect().width),
    };

    setFormSize((current) =>
      current?.height === nextSize.height && current?.width === nextSize.width ? current : nextSize,
    );
  }, [isExpanded, showTemplates, text, selectionKey]);

  // Position the form near the selection (the live rect when the pill has
  // been following a scroll, the snapshot otherwise).
  const anchorRect = liveRect ?? selection.rect;
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
  const viewportPadding = 12;
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  const formHeight = formSize?.height ?? (isExpanded ? (showTemplates ? 280 : 220) : 44);
  const formWidth = formSize?.width ?? (isExpanded ? 320 : 300);
  const belowTop = anchorRect.bottom + 8;
  const aboveTop = anchorRect.top - formHeight - 8;
  const showAbove =
    belowTop + formHeight > viewportHeight - viewportPadding && aboveTop >= viewportPadding;
  const top = clamp(
    showAbove ? aboveTop : belowTop,
    viewportPadding,
    Math.max(viewportPadding, viewportHeight - formHeight - viewportPadding),
  );
  const left = clamp(
    anchorRect.left,
    viewportPadding,
    Math.max(viewportPadding, viewportWidth - formWidth - viewportPadding),
  );
  // Hide (do not unmount) while the selection is scrolled out of view; it
  // reappears when the text scrolls back in.
  const anchorOffscreen = anchorRect.bottom < 0 || anchorRect.top > viewportHeight;

  const style: React.CSSProperties = {
    position: 'fixed',
    left: `${left}px`,
    top: `${top}px`,
    maxHeight: `${Math.max(0, viewportHeight - viewportPadding * 2)}px`,
    zIndex: 50,
    visibility: anchorOffscreen ? 'hidden' : undefined,
  };

  const handleSubmit = () => {
    if (!text.trim() || text.length > COMMENT_MAX_LENGTH) return;
    onSubmit(
      selection.text,
      text.trim(),
      selection.contextBefore,
      selection.contextAfter,
      selection.offset,
    );
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

  const handlePillTemplate = (templateText: string) => {
    onLock();
    setText(templateText);
    setShowTemplates(false);
    setIsExpanded(true);
  };

  const handlePillOverflow = () => {
    onLock();
    setShowPillMenu((prev) => !prev);
  };

  if (!isExpanded) {
    const pillTemplates = TEMPLATES.slice(0, 2);
    const menuTemplates = TEMPLATES.slice(2);
    return (
      <div ref={formRef} style={style} data-comment-form>
        {showPillMenu && menuTemplates.length > 0 && (
          <div
            data-pill-template-menu
            className={`absolute right-0 z-10 min-w-40 max-w-64 py-1 bg-surface-raised border border-border rounded-lg shadow-lg ${
              showAbove ? 'bottom-full mb-1.5' : 'top-full mt-1.5'
            }`}
          >
            {menuTemplates.map((t) => (
              <button
                key={t.label}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setShowPillMenu(false);
                  handlePillTemplate(t.text);
                }}
                className="block w-full text-left px-3 py-1.5 text-xs text-content-secondary hover:bg-tint hover:text-content transition-colors truncate"
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
        <div className="selection-pill-enter flex items-center gap-0.5 px-1.5 py-1 bg-surface-raised border border-border rounded-full shadow-lg">
          <button
            onMouseDown={(e) => e.preventDefault()} // Prevent stealing focus/clearing selection
            onClick={handleExpand}
            className="flex items-center gap-1.5 pl-2.5 pr-2 py-1 rounded-full text-sm font-medium text-primary-text hover:bg-tint-primary transition-colors"
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
                d="M20 4H4a1 1 0 00-1 1v11a1 1 0 001 1h3v4l5-4h8a1 1 0 001-1V5a1 1 0 00-1-1z"
              />
            </svg>
            Comment
          </button>
          {pillTemplates.length > 0 && <span className="w-px self-stretch my-1 bg-border" />}
          {pillTemplates.map((t) => (
            <button
              key={t.label}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => handlePillTemplate(t.text)}
              className="px-2.5 py-1 rounded-full text-xs text-content-secondary hover:bg-tint transition-colors max-w-36 truncate"
            >
              {t.label}
            </button>
          ))}
          {TEMPLATES.length > 2 && (
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={handlePillOverflow}
              aria-label="More templates"
              aria-expanded={showPillMenu}
              className={`px-2 py-1 rounded-full text-xs transition-colors ${
                showPillMenu
                  ? 'bg-surface-inset text-content'
                  : 'text-content-secondary hover:bg-tint'
              }`}
            >
              &#8943;
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={formRef}
      style={style}
      data-comment-form
      className="w-80 bg-surface-raised rounded-xl shadow-xl border border-border overflow-x-hidden overflow-y-auto"
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
                className="text-[10px] px-2 py-1 rounded-md bg-surface border border-border-subtle text-content-secondary hover:bg-tint-primary hover:text-primary-text hover:border-primary-border transition-colors"
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
          className="w-full text-sm border border-border-subtle rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent placeholder:text-content-muted bg-surface text-content overflow-hidden"
        />
        {text.length > COMMENT_MAX_LENGTH * 0.8 && (
          <p
            className={`text-right text-xs mt-1 ${
              text.length >= COMMENT_MAX_LENGTH ? 'text-danger font-medium' : 'text-content-muted'
            }`}
          >
            {text.length}/{COMMENT_MAX_LENGTH}
          </p>
        )}
        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-content-muted">{modLabel}+Enter</span>
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
