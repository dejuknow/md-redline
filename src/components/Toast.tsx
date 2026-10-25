import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToastAction, ToastKind } from '../hooks/useToast';

interface Props {
  message: string;
  visible: boolean;
  onDismiss: () => void;
  action?: ToastAction;
  kind?: ToastKind;
  /** Changes on every showToast call, so a toast repeating the last one's
   *  text (two deletes in a row) still gets its own 5s and cancels the last
   *  one's pending fade-out. */
  toastId?: number;
}

// One neutral bar for every toast; the meaning lives in the icon color. The bar
// is the theme's own text color mixed 80% toward its surface, with the surface
// color as text — i.e. an inverted, slightly-softened neutral. That means it
// always sits at the opposite value from the page (a warm charcoal on light
// themes, a warm off-white on dark ones), so it stands out without blending,
// and it's drawn from each theme's palette rather than a fixed foreign color.
// The 80% mix takes the edge off the near-black on light themes. Icon colors
// are mid-tones that read on both bar values; `error` uses an alert glyph,
// never the success check.
export const TOAST_BG = 'color-mix(in srgb, var(--color-content) 80%, var(--color-surface))';
export const TOAST_FG = 'var(--color-surface)';
const KIND_STYLES: Record<ToastKind, { iconColor: string; icon: string }> = {
  success: {
    iconColor: '#10b981',
    icon: 'M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  },
  error: {
    iconColor: '#ef4444',
    icon: 'M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z',
  },
  info: {
    iconColor: '#9ca3af',
    icon: 'M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z',
  },
};

/** How long a toast stays up, not counting time spent paused. */
const TOAST_DURATION_MS = 5000;

export function Toast({ message, visible, onDismiss, action, kind = 'info', toastId }: Props) {
  const [show, setShow] = useState(false);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The auto-dismiss clock can pause, so it keeps what is left of its time
  // rather than a single fixed timeout. Pointing at the toast or focusing a
  // control inside it pauses the clock (and the countdown bar with it):
  // someone reaching for Undo shouldn't lose it on the way.
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const remainingRef = useRef(TOAST_DURATION_MS);
  const startedAtRef = useRef(0);
  const hoveredRef = useRef(false);
  const focusedRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);

  const fadeOut = useCallback(() => {
    setShow(false);
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    fadeTimerRef.current = setTimeout(onDismiss, 200);
  }, [onDismiss]);

  const startClock = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    startedAtRef.current = Date.now();
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      fadeOut();
    }, remainingRef.current);
  }, [fadeOut]);

  const syncPause = useCallback(() => {
    const shouldPause = hoveredRef.current || focusedRef.current;
    if (shouldPause && timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
      remainingRef.current -= Date.now() - startedAtRef.current;
      setPaused(true);
    } else if (!shouldPause && !timerRef.current && remainingRef.current > 0) {
      startClock();
      setPaused(false);
    }
  }, [startClock]);

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
      // Reset the auto-dismiss clock on every message update so coalesced
      // toasts stay visible while new events keep arriving. A toast that
      // arrives under the pointer or focus starts paused. Focus is read from
      // the page rather than remembered: a replacement toast can drop the
      // focused button (Undo swapped for "Couldn't undo") without a blur.
      remainingRef.current = TOAST_DURATION_MS;
      focusedRef.current = Boolean(containerRef.current?.contains(document.activeElement));
      const startPaused = hoveredRef.current || focusedRef.current;
      setPaused(startPaused);
      if (!startPaused) startClock();
      return () => {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = undefined;
        if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
      };
    } else {
      setShow(false);
      // The toast unmounts without a mouseleave or blur (clicking Undo hides
      // it under the pointer), so the next toast would otherwise start paused.
      hoveredRef.current = false;
      focusedRef.current = false;
    }
  }, [visible, message, toastId, startClock]);

  if (!visible) return null;

  return (
    <div
      ref={containerRef}
      role="status"
      aria-live="polite"
      className={`fixed bottom-12 right-4 z-50 transition-all duration-200 ${
        show ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
      }`}
      onMouseEnter={() => {
        hoveredRef.current = true;
        syncPause();
      }}
      onMouseLeave={() => {
        hoveredRef.current = false;
        syncPause();
      }}
      onFocus={() => {
        focusedRef.current = true;
        syncPause();
      }}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        focusedRef.current = false;
        syncPause();
      }}
    >
      <div
        className="relative overflow-hidden flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg shadow-lg"
        style={{ background: TOAST_BG, color: TOAST_FG }}
      >
        <svg
          className="w-4 h-4 shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          style={{ color: KIND_STYLES[kind].iconColor }}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d={KIND_STYLES[kind].icon} />
        </svg>
        {message}
        {action && (
          <button
            onClick={() => {
              action.onClick();
              fadeOut();
            }}
            className="ml-1 px-2 py-0.5 rounded text-xs font-semibold bg-current/10 hover:bg-current/20 transition-colors"
          >
            {action.label}
          </button>
        )}
        <button
          onClick={fadeOut}
          className="ml-2 opacity-70 hover:opacity-100 transition-opacity"
          aria-label="Dismiss notification"
        >
          <svg
            className="w-3.5 h-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        {/* Runs down over the toast's time so it is plain it will close on its
            own. Only a toast with a button gets one: with nothing to act on,
            there is nothing to race. Keyed per toast so a new one restarts it.
            Reduced motion leaves it static (index.css). */}
        {action && (
          <div
            key={`${toastId ?? 0}:${message}`}
            data-toast-countdown
            aria-hidden="true"
            className="toast-countdown absolute inset-x-0 bottom-0 h-0.5 bg-current opacity-40"
            style={{
              animationDuration: `${TOAST_DURATION_MS}ms`,
              animationPlayState: paused ? 'paused' : 'running',
            }}
          />
        )}
      </div>
    </div>
  );
}
