/**
 * Worker count for parallel file work. Parsing is CPU-bound and Node runs it on
 * one thread, so this only buys the overlap between one file's syscalls and
 * another's parsing — enough workers to keep the disk queue busy, not more.
 */
const DEFAULT_CONCURRENCY = 8;

/**
 * Run `worker` over `items` with at most `limit` in flight, returning the
 * results in input order regardless of completion order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  worker: (item: T) => Promise<R>,
  limit: number = DEFAULT_CONCURRENCY,
): Promise<R[]> {
  // Reversed so pop() hands out work in input order.
  const queue = [...items.entries()].reverse();
  const results: R[] = [];

  const runner = async (): Promise<void> => {
    for (let entry = queue.pop(); entry !== undefined; entry = queue.pop()) {
      const [index, item] = entry;
      results[index] = await worker(item);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}
