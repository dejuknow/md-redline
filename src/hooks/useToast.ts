import { useState, useCallback, useRef } from 'react';

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
  /** New on every showToast call, even one repeating the last message. */
  id: number;
  message: string;
  visible: boolean;
  kind: ToastKind;
  action?: ToastAction;
}

export function useToast() {
  const nextIdRef = useRef(0);
  const [toast, setToast] = useState<ToastState>({
    id: 0,
    message: '',
    visible: false,
    kind: 'info',
  });
  const showToast = useCallback<ShowToast>((message, kind = 'info', action) => {
    nextIdRef.current += 1;
    setToast({ id: nextIdRef.current, message, visible: true, kind, action });
  }, []);
  const dismissToast = useCallback(() => {
    setToast((prev) => ({ ...prev, visible: false }));
  }, []);

  return { toast, showToast, dismissToast };
}
