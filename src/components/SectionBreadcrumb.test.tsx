// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { createRef } from 'react';
import { SectionBreadcrumb } from './SectionBreadcrumb';

const CHAIN = [
  { id: 'intro', text: 'Project Specification', level: 1 },
  { id: 'background', text: 'Background', level: 2 },
];

afterEach(() => cleanup());

// jsdom cannot scroll; drive visibility through the exported test hook prop.
describe('SectionBreadcrumb', () => {
  it('renders chain segments when visible and fires onJump', () => {
    const onJump = vi.fn();
    render(
      <SectionBreadcrumb
        chain={CHAIN}
        containerRef={createRef()}
        onJump={onJump}
        initialVisible
      />,
    );
    expect(document.querySelector('[data-section-breadcrumb]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Background' }));
    expect(onJump).toHaveBeenCalledWith('background');
    expect(screen.getByRole('button', { name: 'Project Specification' })).toBeTruthy();
  });

  it('renders nothing when not scrolled', () => {
    render(<SectionBreadcrumb chain={CHAIN} containerRef={createRef()} onJump={vi.fn()} />);
    expect(document.querySelector('[data-section-breadcrumb]')).toBeNull();
  });

  it('renders nothing for an empty chain even when visible', () => {
    render(
      <SectionBreadcrumb chain={[]} containerRef={createRef()} onJump={vi.fn()} initialVisible />,
    );
    expect(document.querySelector('[data-section-breadcrumb]')).toBeNull();
  });
});
