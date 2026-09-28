import { describe, expect, it } from 'vitest';

import { errorMessage } from '../errors.js';

describe('errorMessage', () => {
  it('formats errors from Error and non-Error values', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
  });

  it('stringifies values that are neither Error nor string', () => {
    // `catch` bindings are `unknown`; a thrown object must not surface as
    // "[object Object]" without at least being a deliberate String() call.
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(null)).toBe('null');
  });
});
