import { describe, expect, it } from 'vitest';

import { isKnownChannel } from '../contracts.js';

describe('isKnownChannel', () => {
  it('allows contract channels and refuses anything else', () => {
    expect(isKnownChannel('bootstrap')).toBe(true);
    expect(isKnownChannel('commits:decide')).toBe(true);
    expect(isKnownChannel('git:push')).toBe(false);
    expect(isKnownChannel('fs:write')).toBe(false);
    expect(isKnownChannel('')).toBe(false);
  });
});
