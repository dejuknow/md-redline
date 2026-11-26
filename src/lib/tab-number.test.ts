import { describe, expect, it } from 'vitest';
import { tabIndexForNumber } from './tab-number';

describe('tabIndexForNumber', () => {
  it('picks tabs 1 to 8 by position', () => {
    expect(tabIndexForNumber(1, 3)).toBe(0);
    expect(tabIndexForNumber(3, 3)).toBe(2);
    expect(tabIndexForNumber(8, 12)).toBe(7);
  });

  it('picks the last tab for 9, however many there are', () => {
    expect(tabIndexForNumber(9, 1)).toBe(0);
    expect(tabIndexForNumber(9, 4)).toBe(3);
    expect(tabIndexForNumber(9, 20)).toBe(19);
  });

  it('does nothing past the last tab or with no tabs', () => {
    expect(tabIndexForNumber(4, 3)).toBeNull();
    expect(tabIndexForNumber(1, 0)).toBeNull();
    expect(tabIndexForNumber(9, 0)).toBeNull();
  });

  it('ignores numbers outside 1 to 9', () => {
    expect(tabIndexForNumber(0, 3)).toBeNull();
    expect(tabIndexForNumber(10, 12)).toBeNull();
    expect(tabIndexForNumber(1.5, 3)).toBeNull();
  });
});
