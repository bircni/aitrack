import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { contrastPairs } from '../contrast.js';

const css = readFileSync(join(import.meta.dirname, '../styles.css'), 'utf8');

describe('glass contrast', () => {
  it('keeps text and provider tints at WCAG AA on the worst mesh spot', () => {
    const pairs = contrastPairs(css);
    expect(pairs.length).toBeGreaterThanOrEqual(12);
    const failing = pairs
      .filter((pair) => pair.ratio < 4.5)
      .map(
        (pair) =>
          `${pair.theme} ${pair.role} ${pair.ratio.toFixed(2)} (light ${pair.onLightest.toFixed(2)}, dark ${pair.onDarkest.toFixed(2)})`,
      );
    expect(failing).toEqual([]);
  });
});
