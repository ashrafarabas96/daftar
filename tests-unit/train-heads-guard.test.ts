import { describe, expect, it } from 'vitest';
import { classify, main, selfTest } from '../scripts/check-train-heads';

// The comparator behind `npm run check:train-heads` (DR-62 item 3).
describe('train head guard', () => {
  it('its own positive and negative controls all hold', () => {
    expect(selfTest()).toEqual([]);
  });

  it('two different objects sharing a 7-character prefix are never "same"', () => {
    const a = '1234567' + 'a'.repeat(33);
    const b = '1234567' + 'b'.repeat(33);
    expect(classify(a, b, () => false)).toBe('diverged');
  });

  it('refuses an abbreviated object name instead of comparing it', () => {
    expect(() => classify('abc1234', 'abc12345', () => true)).toThrow(/full object name/);
  });

  it('naming no branch fails: an empty train is not a passing train', () => {
    const err = console.error;
    console.error = () => undefined;
    try {
      expect(main([])).toBe(1);
    } finally {
      console.error = err;
    }
  });
});
