import { useCallback, useEffect, useRef, useState } from 'react';
import { parseComments } from '../lib/comment-parser';
import {
  AgentNotificationQueue,
  INITIAL_ROUND_STATE,
  SeenKeys,
  buildNotifications,
  detectRoundEvents,
  detectThreadEvents,
  type KeyStorage,
  type RoundSession,
  type TakeResult,
} from '../lib/agent-notifications';
import type { MdComment } from '../types';

/** What the shell last learned from the system about notifications for mdr. */
export type AgentNotificationPermission = 'unknown' | 'granted' | 'denied';

/** What the shell passes on each take. */
export interface ShellTakeArgs {
  /** Whether the app window has focus. */
  focused?: boolean;
  permission?: string;
}

declare global {
  interface Window {
    /** Set while the app is mounted; the desktop shell calls it about once a
     *  second (#244). Returns whether agent notifications are on and the
     *  notifications that are ripe, handing each over exactly once. */
    __mdrTakeAgentNotifications?: (shell?: ShellTakeArgs) => TakeResult;
  }
}

function localKeyStorage(): KeyStorage {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** The reader is looking at the page: it is shown and has focus. */
function readerPresent(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

interface Options {
  /** The setting is on and the shell can deliver (see desktopNotificationsSupported). */
  enabled: boolean;
  /** The reader's author name: an unstamped reply under it is theirs. */
  readerName: string;
  /** Every open review session the server lists. */
  sessions: readonly RoundSession[];
  /** A sessions poll has answered with a list; until then `sessions` is a placeholder. */
  sessionsLoaded: boolean;
}

/**
 * Detects agent activity that needs the reader and hands it to the desktop
 * shell as notifications (#244): agent replies and questions in open files
 * (`reportFileChange`, called with every external change a tab takes in) and
 * finished agent rounds on reviews (the sessions' `agentRounds`). Each event
 * notifies at most once, and only while the reader is away from the window;
 * the shell takes the ripe batches through `window.__mdrTakeAgentNotifications`.
 */
export function useAgentNotifications({ enabled, readerName, sessions, sessionsLoaded }: Options) {
  const queueRef = useRef<AgentNotificationQueue | null>(null);
  if (!queueRef.current) {
    queueRef.current = new AgentNotificationQueue(new SeenKeys(localKeyStorage()));
  }
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const readerNameRef = useRef(readerName);
  readerNameRef.current = readerName;
  const roundStateRef = useRef(INITIAL_ROUND_STATE);
  const [permission, setPermission] = useState<AgentNotificationPermission>('unknown');

  // Rounds are tracked with the setting off too, so turning it on never
  // reports rounds that finished before. The baseline is the first real list:
  // taken against the placeholder, every open review would look new.
  useEffect(() => {
    if (!sessionsLoaded) return;
    const { events, state } = detectRoundEvents(roundStateRef.current, sessions);
    roundStateRef.current = state;
    if (enabledRef.current && events.length > 0) {
      queueRef.current!.add(events, Date.now(), readerPresent());
    }
  }, [sessions, sessionsLoaded]);

  /**
   * An external change a tab took in. `priorContent` must be content the tab
   * had loaded, never a first load. `parsed` skips the parse when the caller
   * already has both sides.
   */
  const reportFileChange = useCallback(
    (
      path: string,
      priorContent: string,
      content: string,
      parsed?: { oldComments: MdComment[]; newComments: MdComment[] },
    ) => {
      if (!enabledRef.current) return;
      let oldComments: MdComment[];
      let newComments: MdComment[];
      if (parsed) {
        ({ oldComments, newComments } = parsed);
      } else {
        try {
          oldComments = parseComments(priorContent).comments;
          newComments = parseComments(content).comments;
        } catch {
          return;
        }
      }
      const events = detectThreadEvents(path, oldComments, newComments, readerNameRef.current);
      if (events.length > 0) queueRef.current!.add(events, Date.now(), readerPresent());
    },
    [],
  );

  useEffect(() => {
    if (!enabled) queueRef.current!.clear();
  }, [enabled]);

  useEffect(() => {
    window.__mdrTakeAgentNotifications = (shell) => {
      const p = shell?.permission;
      if (p === 'granted' || p === 'denied' || p === 'unknown') setPermission(p);
      if (!enabledRef.current) return { enabled: false, items: [] };
      // The shell knows whether its window has focus; the page alone can only
      // guess (a hidden page can still report focus for a moment).
      const present = typeof shell?.focused === 'boolean' ? shell.focused : readerPresent();
      const events = queueRef.current!.take(Date.now(), present);
      return { enabled: true, items: buildNotifications(events) };
    };
    return () => {
      delete window.__mdrTakeAgentNotifications;
    };
  }, []);

  return { reportFileChange, permission };
}
