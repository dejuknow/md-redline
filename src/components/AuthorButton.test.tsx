// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { AuthorButton } from './AuthorButton';

afterEach(cleanup);

describe('AuthorButton', () => {
  it('shows the author name in a button titled "Click to change author name"', () => {
    render(<AuthorButton author="Ada" onAuthorChange={vi.fn()} />);
    const btn = screen.getByTitle('Click to change author name');
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.textContent).toContain('Ada');
  });

  it('click swaps to an input with placeholder "Your name" holding the current name', () => {
    render(<AuthorButton author="Ada" onAuthorChange={vi.fn()} />);
    fireEvent.click(screen.getByTitle('Click to change author name'));
    const input = screen.getByPlaceholderText('Your name') as HTMLInputElement;
    expect(input.value).toBe('Ada');
    expect(screen.queryByTitle('Click to change author name')).toBeNull();
  });

  it('Enter commits the trimmed value via onAuthorChange and returns to the button', () => {
    const onChange = vi.fn();
    render(<AuthorButton author="Ada" onAuthorChange={onChange} />);
    fireEvent.click(screen.getByTitle('Click to change author name'));
    const input = screen.getByPlaceholderText('Your name');
    fireEvent.change(input, { target: { value: '  Grace  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('Grace');
    expect(screen.queryByPlaceholderText('Your name')).toBeNull();
    expect(screen.getByTitle('Click to change author name')).toBeTruthy();
  });

  it('an emptied name is handed to onAuthorChange as an empty string (the hook picks the default)', () => {
    const onChange = vi.fn();
    render(<AuthorButton author="Ada" onAuthorChange={onChange} />);
    fireEvent.click(screen.getByTitle('Click to change author name'));
    const input = screen.getByPlaceholderText('Your name');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('Escape cancels without calling onAuthorChange', () => {
    const onChange = vi.fn();
    render(<AuthorButton author="Ada" onAuthorChange={onChange} />);
    fireEvent.click(screen.getByTitle('Click to change author name'));
    const input = screen.getByPlaceholderText('Your name');
    fireEvent.change(input, { target: { value: 'Grace' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTitle('Click to change author name').textContent).toContain('Ada');
  });

  it('blur commits like Enter', () => {
    const onChange = vi.fn();
    render(<AuthorButton author="Ada" onAuthorChange={onChange} />);
    fireEvent.click(screen.getByTitle('Click to change author name'));
    const input = screen.getByPlaceholderText('Your name');
    fireEvent.change(input, { target: { value: 'Grace' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith('Grace');
    expect(screen.queryByPlaceholderText('Your name')).toBeNull();
  });
});
