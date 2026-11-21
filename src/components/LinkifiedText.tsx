import { useMemo } from 'react';
import { linkify } from '../lib/linkify';

/**
 * Plain comment text with its http(s) and www. URLs turned into links that
 * open in a new tab. A click on a link stays on the link, so it does not also
 * select the card it sits in, and a right-click gets the browser's link menu.
 */
export function LinkifiedText({ text }: { text: string }) {
  const segments = useMemo(() => linkify(text), [text]);
  return (
    <>
      {segments.map((s, i) =>
        s.kind === 'text' ? (
          s.text
        ) : (
          <a
            key={i}
            href={s.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            // The card's own context menu would replace the browser's link
            // menu (Copy link address, Open in new window).
            onContextMenu={(e) => e.stopPropagation()}
            className="break-all text-primary-text underline underline-offset-2 decoration-primary-text/40 hover:decoration-primary-text"
          >
            {s.text}
          </a>
        ),
      )}
    </>
  );
}
