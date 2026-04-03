import { useState, useRef, useEffect, useCallback } from 'react';
import { useThemePersistence } from '../hooks/useThemePersistence';
import { useSettings } from '../contexts/SettingsContext';
import type { CommentTemplate } from '../lib/settings';
import { DEFAULT_TEMPLATES } from '../lib/settings';
import { LIGHT_THEMES, DARK_THEMES } from '../lib/themes';

type Section = 'templates' | 'general' | 'theme';

interface Props {
  open: boolean;
  onClose: () => void;
  author: string;
  onAuthorChange: (name: string) => void;
}

export function SettingsPanel({ open, onClose, author, onAuthorChange }: Props) {
  const {
    settings,
    updateTemplates,
    updateCommentMaxLength,
    updateShowTemplatesByDefault,
    updateEnableResolve,
    updateQuickComment,
    resetTemplates,
  } = useSettings();
  const { theme, setTheme } = useThemePersistence();
  const [activeSection, setActiveSection] = useState<Section>('general');
  const panelRef = useRef<HTMLDivElement>(null);

  // Local draft state for templates editing
  const [draftTemplates, setDraftTemplates] = useState<CommentTemplate[]>(settings.templates);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editText, setEditText] = useState('');
  const [addingNew, setAddingNew] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newText, setNewText] = useState('');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // Local draft state for general settings
  const [draftAuthor, setDraftAuthor] = useState(author);
  const [draftMaxLength, setDraftMaxLength] = useState(String(settings.commentMaxLength));

  const authorInputRef = useRef<HTMLInputElement>(null);
  const newLabelRef = useRef<HTMLInputElement>(null);

  // Sync drafts when panel opens (not during editing to avoid discarding in-progress changes)
  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setDraftTemplates(settings.templates);
      setDraftAuthor(author);
      setDraftMaxLength(String(settings.commentMaxLength));
      setEditingIndex(null);
      setAddingNew(false);
    }
    prevOpenRef.current = open;
  }, [open, settings.templates, author, settings.commentMaxLength]);

  // Focus new template label input when adding
  useEffect(() => {
    if (addingNew && newLabelRef.current) {
      newLabelRef.current.focus();
    }
  }, [addingNew]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // --- Template operations ---
  const handleDeleteTemplate = useCallback(
    (index: number) => {
      const next = draftTemplates.filter((_, i) => i !== index);
      setDraftTemplates(next);
      updateTemplates(next);
      if (editingIndex === index) setEditingIndex(null);
    },
    [draftTemplates, editingIndex, updateTemplates],
  );

  const handleStartEdit = useCallback(
    (index: number) => {
      setEditingIndex(index);
      setEditLabel(draftTemplates[index].label);
      setEditText(draftTemplates[index].text);
      setAddingNew(false);
    },
    [draftTemplates],
  );

  const handleSaveEdit = useCallback(() => {
    if (editingIndex === null || !editLabel.trim() || !editText.trim()) return;
    const next = [...draftTemplates];
    next[editingIndex] = { label: editLabel.trim(), text: editText.trim() };
    setDraftTemplates(next);
    updateTemplates(next);
    setEditingIndex(null);
  }, [editingIndex, editLabel, editText, draftTemplates, updateTemplates]);

  const handleAddTemplate = useCallback(() => {
    if (!newLabel.trim() || !newText.trim()) return;
    const next = [...draftTemplates, { label: newLabel.trim(), text: newText.trim() }];
    setDraftTemplates(next);
    updateTemplates(next);
    setNewLabel('');
    setNewText('');
    setAddingNew(false);
  }, [newLabel, newText, draftTemplates, updateTemplates]);

  const handleResetTemplates = useCallback(() => {
    resetTemplates();
    setDraftTemplates(DEFAULT_TEMPLATES);
    setEditingIndex(null);
    setAddingNew(false);
  }, [resetTemplates]);

  const handleDragStart = useCallback((index: number) => {
    setDragIndex(index);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    setDragOverIndex(index);
  }, []);

  const handleDrop = useCallback(
    (targetIndex: number) => {
      if (dragIndex === null || dragIndex === targetIndex) {
        setDragIndex(null);
        setDragOverIndex(null);
        return;
      }
      const next = [...draftTemplates];
      const [moved] = next.splice(dragIndex, 1);
      const adjustedTarget = targetIndex > dragIndex ? targetIndex - 1 : targetIndex;
      next.splice(adjustedTarget, 0, moved);
      setDraftTemplates(next);
      updateTemplates(next);
      if (editingIndex === dragIndex) setEditingIndex(adjustedTarget);
      setDragIndex(null);
      setDragOverIndex(null);
    },
    [dragIndex, draftTemplates, editingIndex, updateTemplates],
  );

  const handleDragEnd = useCallback(() => {
    setDragIndex(null);
    setDragOverIndex(null);
  }, []);

  // --- General settings ---
  const handleAuthorBlur = useCallback(() => {
    const trimmed = draftAuthor.trim() || 'User';
    setDraftAuthor(trimmed);
    onAuthorChange(trimmed);
  }, [draftAuthor, onAuthorChange]);

  const handleMaxLengthBlur = useCallback(() => {
    const num = parseInt(draftMaxLength);
    const valid = !isNaN(num) && num > 0 ? num : 1000;
    setDraftMaxLength(String(valid));
    updateCommentMaxLength(valid);
  }, [draftMaxLength, updateCommentMaxLength]);

  if (!open) return null;

  const sections: { key: Section; label: string; icon: React.ReactNode }[] = [
    {
      key: 'general',
      label: 'General',
      icon: (
        <svg
          className="w-4 h-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z"
          />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      ),
    },
    {
      key: 'templates',
      label: 'Templates',
      icon: (
        <svg
          className="w-4 h-4"
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
      ),
    },
    {
      key: 'theme',
      label: 'Theme',
      icon: (
        <svg
          className="w-4 h-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M4.098 19.902a3.75 3.75 0 005.304 0l6.401-6.402M6.75 21A3.75 3.75 0 013 17.25V4.125C3 3.504 3.504 3 4.125 3h5.25c.621 0 1.125.504 1.125 1.125v4.072M6.75 21a3.75 3.75 0 003.75-3.75V8.197M6.75 21h13.125c.621 0 1.125-.504 1.125-1.125v-5.25c0-.621-.504-1.125-1.125-1.125h-4.072M10.5 8.197l2.88-2.88c.438-.439 1.15-.439 1.59 0l3.712 3.713c.44.44.44 1.152 0 1.59l-2.879 2.88M6.75 17.25h.008v.008H6.75v-.008z"
          />
        </svg>
      ),
    },
  ];

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" onClick={onClose}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" />

      {/* Panel */}
      <div
        ref={panelRef}
        className="relative w-full max-w-3xl max-h-[85vh] bg-surface-raised rounded-xl shadow-2xl border border-border overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <h2 className="text-sm font-semibold text-content">Settings</h2>
          <button
            onClick={onClose}
            className="p-1 rounded text-content-muted hover:text-content-secondary hover:bg-tint transition-colors"
          >
            <svg
              className="w-4 h-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex h-[580px]">
          {/* Sidebar navigation */}
          <div className="w-40 border-r border-border bg-surface-secondary shrink-0 py-2">
            {sections.map((s) => (
              <button
                key={s.key}
                onClick={() => setActiveSection(s.key)}
                className={`w-full text-left px-4 py-2 flex items-center gap-2.5 text-sm transition-colors ${
                  activeSection === s.key
                    ? 'bg-primary-bg text-primary-text font-medium'
                    : 'text-content-secondary hover:bg-tint hover:text-content'
                }`}
              >
                {s.icon}
                {s.label}
              </button>
            ))}
          </div>

          {/* Content area */}
          <div className="flex-1 overflow-y-auto p-5">
            {activeSection === 'templates' && (
              <div>
                {/* Show templates by default — standalone preference */}
                <label className="flex items-center justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-semibold text-content">
                      Show templates by default
                    </h3>
                    <p className="text-xs text-content-muted mt-0.5">
                      Automatically show the template picker when adding a new comment.
                    </p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={settings.showTemplatesByDefault}
                    onClick={() => updateShowTemplatesByDefault(!settings.showTemplatesByDefault)}
                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                      settings.showTemplatesByDefault ? 'bg-primary' : 'bg-border'
                    }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${
                        settings.showTemplatesByDefault ? 'translate-x-[18px]' : 'translate-x-[3px]'
                      }`}
                    />
                  </button>
                </label>

                {/* Divider */}
                <div className="border-t border-border-subtle my-4" />

                {/* Template list header */}
                <div className="flex items-center justify-between mb-1">
                  <h3 className="text-sm font-semibold text-content">Templates</h3>
                  <button
                    onClick={handleResetTemplates}
                    className="text-xs px-2.5 py-1 rounded-md border border-border-subtle text-content-secondary hover:bg-tint transition-colors"
                  >
                    Reset to defaults
                  </button>
                </div>
                <p className="text-xs text-content-muted mb-3">
                  Drag to reorder. The order here matches the template picker.
                </p>

                {/* Template list */}
                <div className="space-y-1">
                  {draftTemplates.map((t, i) => (
                    <div
                      key={`${t.label}-${t.text}`}
                      draggable={editingIndex !== i}
                      onDragStart={() => handleDragStart(i)}
                      onDragOver={(e) => handleDragOver(e, i)}
                      onDrop={() => handleDrop(i)}
                      onDragEnd={handleDragEnd}
                    >
                      {editingIndex === i ? (
                        /* Editing inline */
                        <div className="rounded-lg border border-primary-border bg-primary-bg p-3 space-y-2">
                          <input
                            value={editLabel}
                            onChange={(e) => setEditLabel(e.target.value)}
                            placeholder="Label"
                            className="w-full text-sm px-2.5 py-1.5 rounded-md border border-border-subtle bg-surface text-content focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                          />
                          <textarea
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            placeholder="Template text"
                            rows={2}
                            className="w-full text-sm px-2.5 py-1.5 rounded-md border border-border-subtle bg-surface text-content resize-none focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                          />
                          <div className="flex gap-2 justify-end">
                            <button
                              onClick={() => setEditingIndex(null)}
                              className="text-xs px-2.5 py-1 rounded-md text-content-secondary hover:bg-tint transition-colors"
                            >
                              Cancel
                            </button>
                            <button
                              onClick={handleSaveEdit}
                              disabled={!editLabel.trim() || !editText.trim()}
                              className="text-xs px-2.5 py-1 rounded-md bg-primary text-on-primary hover:bg-primary-hover transition-colors disabled:opacity-40"
                            >
                              Save
                            </button>
                          </div>
                        </div>
                      ) : (
                        /* Display row */
                        <div
                          className={`group flex items-center gap-2 rounded-lg px-3 py-2 transition-colors ${
                            dragOverIndex === i && dragIndex !== i
                              ? 'border-t-2 border-primary'
                              : 'border-t-2 border-transparent'
                          } ${dragIndex === i ? 'opacity-40' : 'hover:bg-tint'}`}
                        >
                          {/* Drag handle */}
                          <span className="shrink-0 cursor-grab active:cursor-grabbing text-content-faint hover:text-content-muted">
                            <svg
                              className="w-4 h-4"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                              strokeWidth={2}
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M3.75 9h16.5m-16.5 6.75h16.5"
                              />
                            </svg>
                          </span>

                          {/* Label + text preview */}
                          <div className="flex-1 min-w-0">
                            <span className="text-sm text-content font-medium">{t.label}</span>
                            <p className="text-xs text-content-muted truncate">{t.text}</p>
                          </div>

                          {/* Actions */}
                          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                            <button
                              onClick={() => handleStartEdit(i)}
                              className="p-1 rounded text-content-muted hover:text-primary-text hover:bg-tint-primary transition-colors"
                              title="Edit"
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
                                  d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487z"
                                />
                              </svg>
                            </button>
                            <button
                              onClick={() => handleDeleteTemplate(i)}
                              className="p-1 rounded text-content-muted hover:text-danger-text hover:bg-tint-danger transition-colors"
                              title="Delete"
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
                                  d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"
                                />
                              </svg>
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* Add new template */}
                {addingNew ? (
                  <div className="mt-3 rounded-lg border border-primary-border bg-primary-bg p-3 space-y-2">
                    <input
                      ref={newLabelRef}
                      value={newLabel}
                      onChange={(e) => setNewLabel(e.target.value)}
                      placeholder="Label (e.g. Clarify)"
                      className="w-full text-sm px-2.5 py-1.5 rounded-md border border-border-subtle bg-surface text-content focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          setAddingNew(false);
                          setNewLabel('');
                          setNewText('');
                        }
                      }}
                    />
                    <textarea
                      value={newText}
                      onChange={(e) => setNewText(e.target.value)}
                      placeholder="Template text (e.g. Please clarify this section.)"
                      rows={2}
                      className="w-full text-sm px-2.5 py-1.5 rounded-md border border-border-subtle bg-surface text-content resize-none focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          setAddingNew(false);
                          setNewLabel('');
                          setNewText('');
                        }
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          handleAddTemplate();
                        }
                      }}
                    />
                    <div className="flex gap-2 justify-end">
                      <button
                        onClick={() => {
                          setAddingNew(false);
                          setNewLabel('');
                          setNewText('');
                        }}
                        className="text-xs px-2.5 py-1 rounded-md text-content-secondary hover:bg-tint transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleAddTemplate}
                        disabled={!newLabel.trim() || !newText.trim()}
                        className="text-xs px-2.5 py-1 rounded-md bg-primary text-on-primary hover:bg-primary-hover transition-colors disabled:opacity-40"
                      >
                        Add
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => {
                      setAddingNew(true);
                      setEditingIndex(null);
                    }}
                    className="mt-3 w-full text-left px-3 py-2 rounded-lg border border-dashed border-border-subtle text-sm text-content-muted hover:text-primary-text hover:border-primary-border hover:bg-tint-primary transition-colors flex items-center gap-2"
                  >
                    <svg
                      className="w-4 h-4"
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
                    Add template
                  </button>
                )}
              </div>
            )}

            {activeSection === 'general' && (
              <div className="space-y-6">
                {/* Author Name */}
                <div>
                  <h3 className="text-sm font-semibold text-content mb-1">Author Name</h3>
                  <p className="text-xs text-content-muted mb-2">
                    Name attached to your comments and replies.
                  </p>
                  <input
                    ref={authorInputRef}
                    value={draftAuthor}
                    onChange={(e) => setDraftAuthor(e.target.value)}
                    onBlur={handleAuthorBlur}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAuthorBlur();
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                    className="w-60 text-sm px-3 py-1.5 rounded-md border border-border-subtle bg-surface text-content focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                    placeholder="Your name"
                  />
                </div>

                {/* Enable Resolve */}
                <div>
                  <label className="flex items-center justify-between gap-4">
                    <div>
                      <h3 className="text-sm font-semibold text-content">
                        Enable resolve workflow
                      </h3>
                      <p className="text-xs text-content-muted mt-0.5">
                        Adds resolve and reopen actions for reviewing with humans. Leave off when
                        working with AI agents.
                      </p>
                    </div>
                    <button
                      role="switch"
                      aria-checked={settings.enableResolve}
                      onClick={() => updateEnableResolve(!settings.enableResolve)}
                      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                        settings.enableResolve ? 'bg-primary' : 'bg-border'
                      }`}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${
                          settings.enableResolve ? 'translate-x-[18px]' : 'translate-x-[3px]'
                        }`}
                      />
                    </button>
                  </label>
                </div>

                {/* Quick Comment */}
                <div>
                  <label className="flex items-center justify-between gap-4">
                    <div>
                      <h3 className="text-sm font-semibold text-content">Quick comment</h3>
                      <p className="text-xs text-content-muted mt-0.5">
                        Open the comment form immediately when text is selected, skipping the
                        "Comment" button.
                      </p>
                    </div>
                    <button
                      role="switch"
                      aria-checked={settings.quickComment}
                      onClick={() => updateQuickComment(!settings.quickComment)}
                      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                        settings.quickComment ? 'bg-primary' : 'bg-border'
                      }`}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${
                          settings.quickComment ? 'translate-x-[18px]' : 'translate-x-[3px]'
                        }`}
                      />
                    </button>
                  </label>
                </div>

                {/* Comment Max Length */}
                <div>
                  <h3 className="text-sm font-semibold text-content mb-1">Comment Max Length</h3>
                  <p className="text-xs text-content-muted mb-2">
                    Maximum characters per comment. Long inline markers can confuse AI agents
                    parsing the file.
                  </p>
                  <input
                    type="number"
                    min="50"
                    max="10000"
                    value={draftMaxLength}
                    onChange={(e) => setDraftMaxLength(e.target.value)}
                    onBlur={handleMaxLengthBlur}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleMaxLengthBlur();
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                    className="w-32 text-sm px-3 py-1.5 rounded-md border border-border-subtle bg-surface text-content focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                  />
                  <span className="text-xs text-content-muted ml-2">characters</span>
                </div>
              </div>
            )}

            {activeSection === 'theme' && (
              <div>
                <h3 className="text-sm font-semibold text-content mb-1">Theme</h3>
                <p className="text-xs text-content-muted mb-4">
                  Choose a color theme for the interface.
                </p>

                {/* System theme */}
                <button
                  onClick={() => setTheme('system')}
                  className={`w-full text-left px-4 py-3 rounded-lg border-2 transition-colors mb-5 flex items-center gap-3 ${
                    theme === 'system'
                      ? 'border-primary bg-primary-bg'
                      : 'border-border hover:border-primary-border hover:bg-tint'
                  }`}
                >
                  <svg
                    className={`w-5 h-5 ${theme === 'system' ? 'text-primary-text' : 'text-content-muted'}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.5}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25A2.25 2.25 0 015.25 3h13.5A2.25 2.25 0 0121 5.25z"
                    />
                  </svg>
                  <div>
                    <span
                      className={`text-sm font-medium ${theme === 'system' ? 'text-primary-text' : 'text-content'}`}
                    >
                      System
                    </span>
                    <p className="text-xs text-content-muted">Follows your OS appearance setting</p>
                  </div>
                  {theme === 'system' && (
                    <svg
                      className="w-3.5 h-3.5 ml-auto text-primary-text"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M4.5 12.75l6 6 9-13.5"
                      />
                    </svg>
                  )}
                </button>

                {/* Light themes */}
                <p className="text-xs font-medium text-content-muted uppercase tracking-wider mb-2">
                  Light
                </p>
                <div className="grid grid-cols-2 gap-3 mb-5">
                  {LIGHT_THEMES.map((t) => (
                    <button
                      key={t.key}
                      onClick={() => setTheme(t.key)}
                      className={`text-left px-4 py-3 rounded-lg border-2 transition-colors ${
                        theme === t.key
                          ? 'border-primary bg-primary-bg'
                          : 'border-border hover:border-primary-border hover:bg-tint'
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1.5">
                        <div className="flex gap-1">
                          {t.colors.map((c, i) => (
                            <div
                              key={i}
                              className="w-4 h-4 rounded-full border border-border-subtle"
                              style={{ backgroundColor: c }}
                            />
                          ))}
                        </div>
                      </div>
                      <span
                        className={`text-sm font-medium ${
                          theme === t.key ? 'text-primary-text' : 'text-content'
                        }`}
                      >
                        {t.label}
                      </span>
                      {theme === t.key && (
                        <svg
                          className="inline-block w-3.5 h-3.5 ml-1.5 text-primary-text"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M4.5 12.75l6 6 9-13.5"
                          />
                        </svg>
                      )}
                    </button>
                  ))}
                </div>

                {/* Dark themes */}
                <p className="text-xs font-medium text-content-muted uppercase tracking-wider mb-2">
                  Dark
                </p>
                <div className="grid grid-cols-2 gap-3">
                  {DARK_THEMES.map((t) => (
                    <button
                      key={t.key}
                      onClick={() => setTheme(t.key)}
                      className={`text-left px-4 py-3 rounded-lg border-2 transition-colors ${
                        theme === t.key
                          ? 'border-primary bg-primary-bg'
                          : 'border-border hover:border-primary-border hover:bg-tint'
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1.5">
                        <div className="flex gap-1">
                          {t.colors.map((c, i) => (
                            <div
                              key={i}
                              className="w-4 h-4 rounded-full border border-border-subtle"
                              style={{ backgroundColor: c }}
                            />
                          ))}
                        </div>
                      </div>
                      <span
                        className={`text-sm font-medium ${
                          theme === t.key ? 'text-primary-text' : 'text-content'
                        }`}
                      >
                        {t.label}
                      </span>
                      {theme === t.key && (
                        <svg
                          className="inline-block w-3.5 h-3.5 ml-1.5 text-primary-text"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M4.5 12.75l6 6 9-13.5"
                          />
                        </svg>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
