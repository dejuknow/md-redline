import { useState, useCallback } from 'react';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

/** Semantic kind drives the toast's color + icon. `success` reads green,
 * `error` reads red, `info` is a neutral confirmation. Keeping these separate
 * from the crimson brand accent is what stops a success message from looking
 * like an error. */
export type ToastKind = 'success' | 'error' | 'info';

export type ShowToast = (message: string, kind?: ToastKind, action?: ToastAction) => void;

export interface ToastState {
  message: string;
  visible: boolean;
  kind: ToastKind;
  action?: ToastAction;
}

export function useToast() {
  const [toast, setToast] = useState<ToastState>({
    message: '',
    visible: false,
    kind: 'info',
  });
  const showToast = useCallback<ShowToast>((message, kind = 'info', action) => {
    setToast({ message, visible: true, kind, action });
  }, []);
  const dismissToast = useCallback(() => {
    setToast((prev) => ({ ...prev, visible: false }));
  }, []);

  return { toast, showToast, dismissToast };
}
