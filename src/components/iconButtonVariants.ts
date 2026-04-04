export type Variant = 'neutral' | 'active' | 'success';

export const variantClasses: Record<Variant, { on: string; off: string; coordinated: string }> = {
  neutral: {
    on: 'text-content-muted hover:text-content-secondary hover:bg-tint',
    off: 'text-content-muted hover:text-content-secondary hover:bg-tint',
    coordinated: 'text-content-secondary bg-tint',
  },
  active: {
    on: 'text-primary-text bg-primary-bg',
    off: 'text-content-muted hover:text-content-secondary hover:bg-tint',
    coordinated: 'text-content-secondary bg-tint',
  },
  success: {
    on: 'text-success-text hover:text-success hover:bg-tint-success',
    off: 'text-content-muted hover:text-content-secondary hover:bg-tint',
    coordinated: 'text-content-secondary bg-tint',
  },
};
