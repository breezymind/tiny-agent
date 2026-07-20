export type SettledResult<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown };

/**
 * Runs work in input order while limiting the number of active workers.
 * The result order remains stable so merge/error reporting does not depend on
 * which child agent finishes first.
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  maxConcurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<SettledResult<R>[]> {
  if (items.length === 0) return [];
  const concurrency = Math.max(
    1,
    Math.min(items.length, Math.floor(maxConcurrency)),
  );
  const results: SettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;

  async function consume(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;

      try {
        results[index] = {
          status: "fulfilled",
          value: await worker(items[index], index),
        };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  await Promise.all(
    Array.from({ length: concurrency }, () => consume()),
  );
  return results;
}
