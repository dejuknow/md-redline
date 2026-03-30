import { useState, useRef, useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/* ──────────────────────────────────────────────────────────────────────────
 * DropdownMenu — reusable overflow / "more actions" menu.
 *
 * Renders a ··· trigger button that opens a floating menu via a portal.
 * Follows the same visual language as ContextMenu (shadow-xl, border,
 * context-menu-enter animation) but is designed for inline use inside
 * cards, toolbars, and footers.
 *
 * Usage:
 *   <DropdownMenu items={[
 *     { label: 'Edit', onClick: handleEdit },
 *     { type: 'divider' },
 *     { label: 'Delete', danger: true, onClick: handleDelete },
 *   ]} />
 * ────────────────────────────────────────────────────────────────────── */

export interface DropdownMenuItem {
  label: string;
  onClick: () => void;
  /** Render with danger (red) styling */
  danger?: boolean;
  /** Optional leading icon */
  icon?: ReactNode;
}

export interface DropdownMenuDivider {
  type: 'divider';
}

export type DropdownMenuEntry = DropdownMenuItem | DropdownMenuDivider;

function isDivider(entry: DropdownMenuEntry): entry is DropdownMenuDivider {
  return 'type' in entry && entry.type === 'divider';
}

interface Props {
  items: DropdownMenuEntry[];
  /** Horizontal alignment relative to trigger. Default: 'right' */
  align?: 'left' | 'right';
}

export function DropdownMenu({ items, align = 'right' }: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({});

  // Position the floating menu relative to the trigger
  useEffect(() => {
    if (!open || !triggerRef.current) return;

    const rect = triggerRef.current.getBoundingClientRect();
    const next: React.CSSProperties = {};

    // Horizontal alignment
    if (align === 'right') {
      next.right = window.innerWidth - rect.right;
    } else {
      next.left = rect.left;
    }

    // Vertical: prefer below, flip above if near viewport bottom
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceBelow < 100) {
      next.bottom = window.innerHeight - rect.top + 4;
    } else {
      next.top = rect.bottom + 4;
    }

    setStyle(next);
  }, [open, align]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        triggerRef.current && !triggerRef.current.contains(e.target as Node) &&
        menuRef.current && !menuRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        onClick={(e) => { e.stopPropagation(); setOpen((prev) => !prev); }}
        className="p-1 rounded text-content-muted hover:text-content-secondary hover:bg-tint transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        title="More actions"
        aria-haspopup="true"
        aria-expanded={open}
      >
        <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
          <path d="M6 10a2 2 0 11-4 0 2 2 0 014 0zM12 10a2 2 0 11-4 0 2 2 0 014 0zM18 10a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
      </button>

      {open && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[200] min-w-[120px] py-1 bg-surface-raised rounded-lg shadow-xl border border-border context-menu-enter"
          style={style}
        >
          {items.map((entry, idx) => {
            if (isDivider(entry)) {
              return <div key={`d-${idx}`} className="my-1 mx-2 h-px bg-border" />;
            }
            return (
              <button
                key={`i-${idx}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  entry.onClick();
                }}
                className={`w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2 ${
                  entry.danger
                    ? 'text-danger hover:bg-tint-danger cursor-default'
                    : 'text-content hover:bg-tint cursor-default'
                }`}
              >
                {entry.icon && <span className="w-3.5 h-3.5 shrink-0">{entry.icon}</span>}
                {entry.label}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
