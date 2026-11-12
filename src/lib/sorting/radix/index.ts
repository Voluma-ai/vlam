/**
 * GPU radix sorting strategies with stable (equal-key preserving) ranking.
 *
 * Importing this entry is opt-in: the default viewer and the base unified
 * compositor do not include the radix implementation in their static graphs.
 *
 * @module sorting/radix
 */
import { RadixSorter } from '../../core/radix-sorter';
import type {
  SplatSortStrategy,
  SplatSortStrategyFactory,
  SplatSortStrategyName,
} from '../../core/strategy-types';

function createRadixStrategy(exactDepth: boolean): SplatSortStrategyFactory {
  return {
    kind: 'radix',
    exactDepth,
    create: (options) => new RadixSorter({ ...options, exactDepth }),
  };
}

/** Returns the stable quantized GPU radix sorting strategy.
 */
export function radixSort(): SplatSortStrategyFactory {
  return createRadixStrategy(false);
}

/** Returns the stable Float32-depth GPU radix sorting strategy.
 */
export function exactSort(): SplatSortStrategyFactory {
  return createRadixStrategy(true);
}

const RADIX_SORT = /* @__PURE__ */ radixSort();
const EXACT_SORT = /* @__PURE__ */ exactSort();

/**
 * Maps a strategy name to the `sortStrategy` option a mesh accepts: `'counting'`
 * and `'worker'` pass through, `'radix'` and `'exact'` become their factories
 * (one shared instance each). It lives in this entry so that naming a radix
 * strategy is what pulls the radix code into the bundle.
 */
export function sortStrategyFromName(name: SplatSortStrategyName): SplatSortStrategy {
  if (name === 'radix') return RADIX_SORT;
  if (name === 'exact') return EXACT_SORT;
  return name;
}
