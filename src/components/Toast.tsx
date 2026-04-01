import { useEffect, useRef, useState } from 'react';
import type { ToastAction } from '../hooks/useToast';

interface Props {
  message: string;
  visible: boolean;
  onDismiss: () => void;
  action?: ToastAction;
}

export function Toast({ message, visible, onDismiss, action }: Props) {
  const [show, setShow] = useState(false);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Clean up fade timer on unmount
  useEffect(() => {
    return () => {
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (visible) {
      // Trigger enter animation
      requestAnimationFrame(() => setShow(true));
      // Reset the auto-dismiss timer on every message update so coalesced
      // toasts stay visible while new events keep arriving.
      const timer = setTimeout(() => {
        setShow(false);
        if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
        fadeTimerRef.current = setTimeout(onDismiss, 200);
      }, 5000);
      return () => {
        clearTimeout(timer);
        if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
      };
    } else {
      setShow(false);
    }
  }, [visible, message, onDismiss]);

  if (!visible) return null;

  return (
    <div
      className={`fixed bottom-12 right-4 z-50 transition-all duration-200 ${
        show ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
      }`}
    >
      <div className="flex items-center gap-2 px-4 py-2.5 bg-primary text-on-primary text-sm font-medium rounded-lg shadow-lg">
        <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        {message}
        {action && (
          <button
            onClick={() => {
              action.onClick();
              setShow(false);
              if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
              fadeTimerRef.current = setTimeout(onDismiss, 200);
            }}
            className="ml-1 px-2 py-0.5 rounded text-xs font-semibold bg-on-primary/20 hover:bg-on-primary/30 transition-colors"
          >
            {action.label}
          </button>
        )}
        <button
          onClick={() => {
            setShow(false);
            if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
            fadeTimerRef.current = setTimeout(onDismiss, 200);
          }}
          className="ml-2 opacity-70 hover:opacity-100 transition-opacity"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
