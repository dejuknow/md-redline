// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DISMISS_POPUPS_EVENT, useDismiss } from './useDismiss';

function Menu({ open, close }: { open: boolean; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, ref, close);
  return <div ref={ref}>menu</div>;
}

function pressEscape() {
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
}

describe('useDismiss', () => {
  afterEach(cleanup);

  it('leaves Escape to a dialog open elsewhere', () => {
    const close = vi.fn();
    render(
      <>
        <Menu open close={close} />
        <div role="dialog">drawer</div>
      </>,
    );
    pressEscape();
    expect(close).not.toHaveBeenCalled();
  });

  it('closes on the dismiss event even with a dialog open', () => {
    const close = vi.fn();
    render(
      <>
        <Menu open close={close} />
        <div role="dialog">drawer</div>
      </>,
    );
    window.dispatchEvent(new Event(DISMISS_POPUPS_EVENT));
    expect(close).toHaveBeenCalledOnce();
  });

  it('ignores the dismiss event while closed', () => {
    const close = vi.fn();
    render(<Menu open={false} close={close} />);
    window.dispatchEvent(new Event(DISMISS_POPUPS_EVENT));
    expect(close).not.toHaveBeenCalled();
  });
});
