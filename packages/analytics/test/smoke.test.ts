import { describe, expect, it } from 'vitest';
import { PHASE_13_PACKAGE } from '../src/index';
describe('the package resolves', () => {
  it('names itself', () => { expect(PHASE_13_PACKAGE).toBe('@daftar/analytics'); });
});
