import { describe, expect, it } from 'vitest';

import { errorMessage } from '../errors.js';

describe('errorMessage', () => {
  it('formats Error messages and stringifies everything else', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(null)).toBe('null');
  });
});
