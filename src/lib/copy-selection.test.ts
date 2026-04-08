import { describe, expect, it } from 'vitest';
import { getCopySelectionFallbackText } from './copy-selection';

describe('getCopySelectionFallbackText', () => {
  it('returns viewer selection text when native selection has been replaced by app highlight', () => {
    expect(
      getCopySelectionFallbackText({
        nativeSelectionText: '',
        viewerSelectionText: 'Selected review text',
        activeElement: { tagName: 'DIV', isContentEditable: false },
        viewMode: 'rendered',
      }),
    ).toBe('Selected review text');
  });

  it('does not override native browser copy when text is still truly selected', () => {
    expect(
      getCopySelectionFallbackText({
        nativeSelectionText: 'Native selection',
        viewerSelectionText: 'Selected review text',
        activeElement: { tagName: 'DIV', isContentEditable: false },
        viewMode: 'rendered',
      }),
    ).toBeNull();
  });

  it('does not override copy inside text inputs', () => {
    expect(
      getCopySelectionFallbackText({
        nativeSelectionText: '',
        viewerSelectionText: 'Selected review text',
        activeElement: { tagName: 'TEXTAREA', isContentEditable: false },
        viewMode: 'rendered',
      }),
    ).toBeNull();
  });

  it('does not apply outside rendered mode', () => {
    expect(
      getCopySelectionFallbackText({
        nativeSelectionText: '',
        viewerSelectionText: 'Selected review text',
        activeElement: { tagName: 'DIV', isContentEditable: false },
        viewMode: 'raw',
      }),
    ).toBeNull();
  });
});
