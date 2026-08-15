import { describe, expect, it } from 'vitest';

import { mapWithConcurrency } from '../concurrency.js';

/** Resolves only once `release()` is called, so a test controls completion order. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('mapWithConcurrency', () => {
  it('returns results in input order even when they finish out of order', async () => {
    const gates = [deferred(), deferred(), deferred()];

    const pending = mapWithConcurrency([0, 1, 2], async (index) => {
      await gates[index]?.promise;
      return `item-${String(index)}`;
    });

    // Finish last-to-first: input order has to survive that.
    gates[2]?.release();
    gates[1]?.release();
    gates[0]?.release();

    await expect(pending).resolves.toEqual(['item-0', 'item-1', 'item-2']);
  });

  it('keeps at most `limit` workers in flight', async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, index) => index),
      async (index) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight--;
        return index;
      },
      3,
    );

    expect(peak).toBe(3);
  });

  it('runs every item exactly once', async () => {
    const seen: number[] = [];

    const results = await mapWithConcurrency(
      Array.from({ length: 50 }, (_, index) => index),
      async (index) => {
        await Promise.resolve();
        seen.push(index);
        return index * 2;
      },
      4,
    );

    expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(results).toEqual(Array.from({ length: 50 }, (_, i) => i * 2));
  });

  it('resolves to an empty array for no items', async () => {
    await expect(mapWithConcurrency([], () => Promise.resolve(1))).resolves.toEqual([]);
  });
});
