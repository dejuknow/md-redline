import { useState, useRef, useEffect, type ReactNode } from 'react';

type Variant = 'neutral' | 'active' | 'success';

interface MenuItem {
  label: string;
  onClick: () => void;
}

interface BaseProps {
  /** Icon element for the primary button */
  icon: ReactNode;
  /** Primary click handler */
  onClick: () => void;
  /** Tooltip for the primary button */
  title: string;
  /** Visual variant — matches IconButton */
  variant?: Variant;
  /** Whether the toggle is on (for active/success variants) */
  active?: boolean;
  /** Tooltip for the chevron */
  chevronTitle?: string;
  /** Called when the dropdown opens */
  onOpen?: () => void;
  /** data-testid for the primary button */
  testId?: string;
  /** data-testid for the chevron button */
  chevronTestId?: string;
}

type Props = BaseProps &
  (
    | { menu: MenuItem[]; dropdown?: never }
    | { menu?: never; dropdown: (close: () => void) => ReactNode }
  );

const baseClasses =
  'transition-[color,background-color,border-radius] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

const variantClasses: Record<Variant, { on: string; off: string; coordinated: string }> = {
  neutral: {
    on: 'text-content-muted hover:text-content-secondary hover:bg-tint',
    off: 'text-content-muted hover:text-content-secondary hover:bg-tint',
    coordinated: 'text-content-secondary bg-surface-inset',
  },
  active: {
    on: 'text-primary-text bg-primary-bg',
    off: 'text-content-muted hover:text-content-secondary hover:bg-tint',
    coordinated: 'text-content-secondary bg-surface-inset',
  },
  success: {
    on: 'text-success-text hover:text-success hover:bg-tint-success',
    off: 'text-content-muted hover:text-content-secondary hover:bg-tint',
    coordinated: 'text-content-secondary bg-surface-inset',
  },
};

export function SplitIconButton({
  icon,
  onClick,
  title,
  variant = 'neutral',
  active = false,
  menu,
  dropdown,
  chevronTitle,
  onOpen,
  testId,
  chevronTestId,
}: Props) {
  const [open, setOpen] = useState(false);
  const [chevronHover, setChevronHover] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const close = () => setOpen(false);
  const v = variantClasses[variant];
  const stateClass = active ? v.on : v.off;

  return (
    <div className="relative flex items-center" ref={ref}>
      {/* Primary button */}
      <button
        onClick={onClick}
        title={title}
        data-testid={testId}
        className={`p-1 rounded-l ${baseClasses} ${chevronHover ? v.coordinated : stateClass}`}
      >
        <span className="block w-3.5 h-3.5">{icon}</span>
      </button>

      {/* Chevron */}
      <button
        onClick={() => {
          setOpen((p) => {
            if (!p) onOpen?.();
            return !p;
          });
        }}
        onMouseEnter={() => setChevronHover(true)}
        onMouseLeave={() => setChevronHover(false)}
        title={chevronTitle}
        data-testid={chevronTestId ?? (testId ? `${testId}-chevron` : undefined)}
        className={`pl-0 pr-0.5 self-stretch flex items-center rounded-r ${baseClasses} ${
          open ? v.coordinated : 'text-content-muted hover:text-content-secondary hover:bg-tint'
        }`}
      >
        <svg
          className="w-2 h-2"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={3}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {/* Dropdown */}
      {open &&
        (dropdown ? (
          dropdown(close)
        ) : (
          <div className="absolute right-0 top-full mt-1 z-50 bg-surface border border-border rounded-lg shadow-lg py-1 min-w-[160px]">
            {menu!.map((item) => (
              <button
                key={item.label}
                onClick={() => {
                  item.onClick();
                  close();
                }}
                className="w-full px-3 py-1.5 text-xs text-left text-content hover:bg-tint transition-colors"
              >
                {item.label}
              </button>
            ))}
          </div>
        ))}
    </div>
  );
}
