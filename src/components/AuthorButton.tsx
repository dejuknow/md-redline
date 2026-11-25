import { useState, useRef, useEffect } from 'react';

interface Props {
  author: string;
  onAuthorChange: (name: string) => void;
}

/** Author name shown at the sidebar's foot; click to edit in place. */
export function AuthorButton({ author, onAuthorChange }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(author);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync draft when author changes externally (e.g. from Settings panel)
  useEffect(() => {
    if (!editing) setDraft(author);
  }, [author, editing]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commit = () => {
    onAuthorChange(draft.trim());
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            setDraft(author);
            setEditing(false);
          }
        }}
        className="h-7 text-[13px] w-28 px-2 rounded-md border border-primary bg-surface text-content focus:outline-none focus:ring-1 focus:ring-primary"
        placeholder="Your name"
      />
    );
  }

  const initial = Array.from(author.trim())[0]?.toUpperCase() ?? '';
  return (
    <button
      type="button"
      onClick={() => {
        setDraft(author);
        setEditing(true);
      }}
      className="h-7 px-2 rounded-md flex items-center gap-1.5 text-[13px] text-content-secondary hover:bg-tint transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      title="Click to change author name"
    >
      <span
        aria-hidden="true"
        className="w-5 h-5 shrink-0 rounded-full bg-surface-inset flex items-center justify-center text-[11px] font-medium"
      >
        {initial}
      </span>
      <span className="truncate max-w-[120px]">{author}</span>
    </button>
  );
}
