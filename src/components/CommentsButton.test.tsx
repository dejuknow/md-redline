// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { CommentsButton } from './CommentsButton';

afterEach(cleanup);

type Props = React.ComponentProps<typeof CommentsButton>;

const baseProps = (): Props => ({
  surfaceVisible: true,
  openCount: 3,
  toggleLabel: 'Toggle comments rail (Cmd+\\)',
  onToggle: vi.fn(),
  density: 'anchored',
  onDensityChange: vi.fn(),
  resolvedCount: 0,
  totalCount: 3,
  resolveEnabled: true,
  onJumpPrev: vi.fn(),
  onJumpNext: vi.fn(),
  onBulkResolve: vi.fn(),
  onBulkDeleteResolved: vi.fn(),
  onBulkDelete: vi.fn(),
});

function renderButton(overrides: Partial<Props> = {}) {
  const props = { ...baseProps(), ...overrides };
  return { props, ...render(<CommentsButton {...props} />) };
}

const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Comment options' }));

describe('CommentsButton', () => {
  it('toggles the comments surface and shows the open count on the toggle', () => {
    const { props } = renderButton();
    const toggle = screen.getByRole('button', { name: 'Toggle comments rail (Cmd+\\)' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.textContent).toContain('3');
    fireEvent.click(toggle);
    expect(props.onToggle).toHaveBeenCalledTimes(1);
  });

  it('drops the count when nothing is open', () => {
    renderButton({ openCount: 0 });
    const toggle = screen.getByRole('button', { name: 'Toggle comments rail (Cmd+\\)' });
    expect(toggle.textContent).not.toMatch(/\d/);
  });

  it('offers Anchored and List as checked choices in its menu', () => {
    const { props } = renderButton();
    openMenu();
    const anchored = screen.getByRole('menuitemradio', { name: 'Anchored' });
    const list = screen.getByRole('menuitemradio', { name: 'List' });
    expect(anchored.getAttribute('aria-checked')).toBe('true');
    expect(list.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(list);
    expect(props.onDensityChange).toHaveBeenCalledWith('list');
    // Picking closes the menu.
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('leaves the layout choice out where the rail cannot show', () => {
    renderButton({ density: null });
    openMenu();
    expect(screen.queryByRole('menuitemradio')).toBeNull();
    expect(screen.getByRole('menuitem', { name: /Next comment/ })).toBeTruthy();
  });

  it('jumps between comments from the menu, and disables the jumps with none', () => {
    const { props, rerender } = renderButton();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Previous comment/ }));
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Next comment/ }));
    expect(props.onJumpPrev).toHaveBeenCalledTimes(1);
    expect(props.onJumpNext).toHaveBeenCalledTimes(1);

    rerender(<CommentsButton {...props} openCount={0} totalCount={0} />);
    openMenu();
    expect(
      (screen.getByRole('menuitem', { name: /Next comment/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('offers the bulk actions, gated on the counts', () => {
    const { props } = renderButton({ resolvedCount: 0 });
    openMenu();
    expect(screen.queryByText('Clear resolved')).toBeNull();
    fireEvent.click(screen.getByText('Resolve all open'));
    expect(props.onBulkResolve).toHaveBeenCalledTimes(1);
  });

  it('hides resolve-only bulk actions when the resolve workflow is off', () => {
    renderButton({ resolveEnabled: false });
    openMenu();
    expect(screen.queryByText('Resolve all open')).toBeNull();
    expect(screen.getByText('Delete all comments…')).toBeTruthy();
  });

  it('offers Clear resolved with the workflow off once the file has resolved markers', () => {
    const { props } = renderButton({ resolveEnabled: false, resolvedCount: 2 });
    openMenu();
    fireEvent.click(screen.getByText('Clear resolved'));
    expect(props.onBulkDeleteResolved).toHaveBeenCalledTimes(1);
  });

  it('confirms before deleting all comments', () => {
    const { props } = renderButton();
    openMenu();
    fireEvent.click(screen.getByText('Delete all comments…'));
    expect(props.onBulkDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete All' }));
    expect(props.onBulkDelete).toHaveBeenCalledTimes(1);
  });

  it('shows no bulk actions without comments', () => {
    renderButton({ openCount: 0, totalCount: 0 });
    openMenu();
    expect(screen.queryByText('Delete all comments…')).toBeNull();
  });

  it('drops an open delete dialog when the comments disappear underneath it', () => {
    const { props, rerender } = renderButton();
    openMenu();
    fireEvent.click(screen.getByText('Delete all comments…'));
    expect(screen.getByRole('button', { name: 'Delete All' })).toBeTruthy();
    rerender(<CommentsButton {...props} openCount={0} totalCount={0} />);
    expect(screen.queryByRole('button', { name: 'Delete All' })).toBeNull();
  });

  it('closes its menu on Escape', () => {
    renderButton();
    openMenu();
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
