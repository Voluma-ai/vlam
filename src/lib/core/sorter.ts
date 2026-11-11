/** Internal sorter and strategy contracts shared by the core and optional entries. */
export type {
  SplatSortStrategy,
  SplatSortStrategyFactory,
  SplatSortCenterAdapter,
  SplatSorter,
  SplatSorterOptions,
} from './strategy-types';
export type SplatSorterKind = 'counting' | 'radix' | 'worker';
