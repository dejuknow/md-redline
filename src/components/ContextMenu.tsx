import { useRef, useEffect, useState } from 'react';

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  /** Optional danger styling (red text) */
  danger?: boolean;
  /** Optional disabled state */
  disabled?: boolean;
}

export interface ContextMenuDivider {
  type: 'divider';
}

export interface ContextMenuSubmenu {
  label: string;
  items: ContextMenuItem[];
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuDivider | ContextMenuSubmenu;

function isDivider(entry: ContextMenuEntry): entry is ContextMenuDivider {
  return 'type' in entry && entry.type === 'divider';
}

function isSubmenu(entry: ContextMenuEntry): entry is ContextMenuSubmenu {
  return 'items' in entry;
}

interface Props {
  items: ContextMenuEntry[];
  position: { x: number; y: number };
  onClose: () => void;
}

export function ContextMenu({ items, position, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [adjustedPos, setAdjustedPos] = useState(position);
  const [openSubmenuIdx, setOpenSubmenuIdx] = useState<number | null>(null);
  const [submenuPos, setSubmenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const submenuRef = useRef<HTMLDivElement>(null);

  // Adjust position to keep menu within viewport
  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;

    // Let the browser lay out the element first, then measure
    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let x = position.x;
      let y = position.y;

      if (x + rect.width > vw - 8) {
        x = vw - rect.width - 8;
      }
      if (y + rect.height > vh - 8) {
        y = vh - rect.height - 8;
      }
      if (x < 8) x = 8;
      if (y < 8) y = 8;

      setAdjustedPos({ x, y });
    });
  }, [position]);

  // Close on click outside
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        (!submenuRef.current || !submenuRef.current.contains(e.target as Node))
      ) {
        onClose();
      }
    };

    // Use mousedown so the menu closes before the click is processed
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [onClose]);

  // Close on window blur
  useEffect(() => {
    const handleBlur = () => onClose();
    window.addEventListener('blur', handleBlur);
    return () => window.removeEventListener('blur', handleBlur);
  }, [onClose]);

  const handleItemClick = (item: ContextMenuItem) => {
    if (item.disabled) return;
    onClose();
    item.onClick();
  };

  const handleSubmenuHover = (idx: number, e: React.MouseEvent) => {
    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const menuRect = menuRef.current?.getBoundingClientRect();
    const vw = window.innerWidth;

    // Default: open to the right
    let x = rect.right;
    let y = rect.top;

    // If not enough space on the right, open to the left
    if (menuRect && x + 180 > vw - 8) {
      x = menuRect.left - 180;
    }

    setSubmenuPos({ x, y });
    setOpenSubmenuIdx(idx);
  };

  return (
    <>
      <div
        ref={menuRef}
        className="fixed z-[200] min-w-[160px] max-w-[240px] py-1 bg-surface-raised rounded-lg shadow-xl border border-border context-menu-enter"
        style={{ left: adjustedPos.x, top: adjustedPos.y }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((entry, idx) => {
          if (isDivider(entry)) {
            return (
              <div
                key={`divider-${idx}`}
                className="my-1 mx-2 h-px bg-border"
              />
            );
          }

          if (isSubmenu(entry)) {
            return (
              <div
                key={`submenu-${idx}`}
                className="relative"
                onMouseEnter={(e) => handleSubmenuHover(idx, e)}
                onMouseLeave={() => setOpenSubmenuIdx(null)}
              >
                <div className="flex items-center justify-between px-3 py-1.5 text-xs text-content hover:bg-surface-inset cursor-default transition-colors">
                  <span>{entry.label}</span>
                  <svg
                    className="w-3 h-3 text-content-muted ml-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M8.25 4.5l7.5 7.5-7.5 7.5"
                    />
                  </svg>
                </div>

                {openSubmenuIdx === idx && (
                  <div
                    ref={submenuRef}
                    className="fixed z-[201] min-w-[160px] max-w-[240px] py-1 bg-surface-raised rounded-lg shadow-xl border border-border"
                    style={{ left: submenuPos.x, top: submenuPos.y }}
                    onMouseEnter={() => setOpenSubmenuIdx(idx)}
                    onMouseLeave={() => setOpenSubmenuIdx(null)}
                  >
                    {entry.items.map((subItem, subIdx) => (
                      <button
                        key={`sub-${subIdx}`}
                        onClick={() => handleItemClick(subItem)}
                        disabled={subItem.disabled}
                        className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                          subItem.disabled
                            ? 'text-content-muted cursor-not-allowed'
                            : subItem.danger
                              ? 'text-danger hover:bg-danger-bg cursor-default'
                              : 'text-content hover:bg-surface-inset cursor-default'
                        }`}
                      >
                        {subItem.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          }

          // Regular menu item
          return (
            <button
              key={`item-${idx}`}
              onClick={() => handleItemClick(entry)}
              disabled={entry.disabled}
              className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                entry.disabled
                  ? 'text-content-muted cursor-not-allowed'
                  : entry.danger
                    ? 'text-danger hover:bg-danger-bg cursor-default'
                    : 'text-content hover:bg-surface-inset cursor-default'
              }`}
            >
              {entry.label}
            </button>
          );
        })}
      </div>
    </>
  );
}
