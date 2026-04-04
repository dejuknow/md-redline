import type { ReactNode, ButtonHTMLAttributes } from 'react';
import { variantClasses, type Variant } from './iconButtonVariants';

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  /** Visual variant: neutral (default muted), active (primary toggle), success (green toggle) */
  variant?: Variant;
  /** Whether the toggle is currently on — only relevant for 'active' and 'success' variants */
  active?: boolean;
  /** Icon size class — defaults to 'w-3.5 h-3.5' (tab bar), use 'w-4 h-4' for toolbar */
  size?: 'sm' | 'md';
  children: ReactNode;
}

const baseClasses =
  'p-1 rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

export function IconButton({
  variant = 'neutral',
  active = false,
  size = 'sm',
  children,
  ...rest
}: Props) {
  const v = variantClasses[variant];
  const stateClass = active ? v.on : v.off;

  return (
    <button className={`${baseClasses} ${stateClass}`} {...rest}>
      <span className={size === 'sm' ? 'block w-3.5 h-3.5' : 'block w-4 h-4'}>{children}</span>
    </button>
  );
}
