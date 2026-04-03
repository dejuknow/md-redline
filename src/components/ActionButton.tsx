import { forwardRef } from 'react';
import type { ReactNode, ButtonHTMLAttributes } from 'react';

type Intent = 'neutral' | 'primary' | 'success' | 'danger' | 'submit';
type Size = 'xs' | 'sm';

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  /** Color intent */
  intent?: Intent;
  /** Text size — 'xs' for comment card actions, 'sm' for form buttons */
  size?: Size;
  children: ReactNode;
}

const intentClasses: Record<Intent, string> = {
  neutral: 'text-content-secondary hover:text-content hover:bg-tint',
  primary: 'text-primary-text hover:bg-tint-primary',
  success: 'text-success-text hover:bg-tint-success',
  danger: 'text-danger hover:bg-tint-danger',
  submit: 'bg-primary text-on-primary hover:bg-primary-hover disabled:opacity-40',
};

const sizeClasses: Record<Size, string> = {
  xs: 'text-xs px-2 py-0.5',
  sm: 'text-xs px-2 py-1',
};

export const ActionButton = forwardRef<HTMLButtonElement, Props>(function ActionButton(
  { intent = 'neutral', size = 'xs', children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={`rounded transition-colors ${sizeClasses[size]} ${intentClasses[intent]}`}
      {...rest}
    >
      {children}
    </button>
  );
});
