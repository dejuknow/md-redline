// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { stripReviewParamFromUrl } from './review-url';

describe('stripReviewParamFromUrl', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('removes the review param while leaving other params intact', () => {
    window.history.replaceState({}, '', '/?file=spec.md&review=rev_abc&foo=bar');
    stripReviewParamFromUrl();
    const params = new URLSearchParams(window.location.search);
    expect(params.has('review')).toBe(false);
    expect(params.get('file')).toBe('spec.md');
    expect(params.get('foo')).toBe('bar');
  });

  it('is a no-op when the review param is absent', () => {
    window.history.replaceState({}, '', '/?file=spec.md');
    stripReviewParamFromUrl();
    const params = new URLSearchParams(window.location.search);
    expect(params.has('review')).toBe(false);
    expect(params.get('file')).toBe('spec.md');
  });

  it('leaves the path and hash alone', () => {
    window.history.replaceState({}, '', '/some/path?review=rev_1#section');
    stripReviewParamFromUrl();
    expect(window.location.pathname).toBe('/some/path');
    expect(new URLSearchParams(window.location.search).has('review')).toBe(false);
    expect(window.location.hash).toBe('#section');
  });

  it('clears the entire search string when review was the only param', () => {
    window.history.replaceState({}, '', '/?review=rev_only');
    stripReviewParamFromUrl();
    expect(window.location.search).toBe('');
  });
});
