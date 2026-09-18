/**
 * Experimental stable GPU radix sorting strategies.
 *
 * Importing this entry is opt-in: the default viewer and the base unified
 * compositor do not include the radix implementation in their static graphs.
 *
 * @module sorting/radix
 */
import { RadixSorter } from '../../core/radix-sorter';
import type { SplatSortStrategyFactory } from '../../core/strategy-types';

function createRadixStrategy(exactDepth: boolean): SplatSortStrategyFactory {
  return {
    kind: 'radix',
    exactDepth,
    create: (options) => new RadixSorter({ ...options, exactDepth }),
  };
}

/** Returns the stable quantized GPU radix sorting strategy. */
export function radixSort(): SplatSortStrategyFactory {
  return createRadixStrategy(false);
}

/** Returns the stable Float32-depth GPU radix sorting strategy. */
export function exactSort(): SplatSortStrategyFactory {
  return createRadixStrategy(true);
}
