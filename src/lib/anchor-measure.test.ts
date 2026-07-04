// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { measureAnchorTopsWithin } from './anchor-measure';

describe('measureAnchorTopsWithin', () => {
  it('measures marks relative to the scope element without scrollTop', () => {
    const scope = document.createElement('div');
    const mark = document.createElement('span');
    mark.dataset.commentIds = 'c1';
    scope.appendChild(mark);
    document.body.appendChild(scope);
    scope.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    mark.getBoundingClientRect = () => ({ top: 340 }) as DOMRect;
    expect(measureAnchorTopsWithin(scope).get('c1')).toBe(240);
    scope.remove();
  });
});
