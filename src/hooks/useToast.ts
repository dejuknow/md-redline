import { useState, useCallback } from 'react';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastState {
  message: string;
  visible: boolean;
  action?: ToastAction;
}

export function useToast() {
  const [toast, setToast] = useState<ToastState>({
    message: '',
    visible: false,
  });
  const showToast = useCallback((message: string, action?: ToastAction) => {
    setToast({ message, visible: true, action });
  }, []);
  const dismissToast = useCallback(() => {
    setToast((prev) => ({ ...prev, visible: false }));
  }, []);

  return { toast, showToast, dismissToast };
}
