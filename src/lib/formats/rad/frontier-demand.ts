/** VLAM demand ordering: projected importance, then file id.
 * Spark 2.1 instead preserves first-touch order from its best-first traversal;
 * this comparator is not an exact port of Spark's fetch queue.
 * Screen-tier and center-weight scoring are not part of this path. */
import type { FrontierDemandWant } from './frontier-worker-protocol';

export function compareDemand(a: FrontierDemandWant, b: FrontierDemandWant): number {
  return b.priority - a.priority || a.file - b.file;
}
