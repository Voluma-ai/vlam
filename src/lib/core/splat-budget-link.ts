import type { SplatData } from './splat-data';

/**
 * What a scene budget sees of a mesh built from budgeted data.
 *
 * @internal Implemented by `SplatMesh`; consumed by `SplatSceneBudget`
 * (`@voluma/vlam/loaders`). Lives in core so the mesh can take part without
 * importing the loaders.
 */
export interface SplatBudgetTenant {
  /** Splats the mesh currently holds. */
  readonly budgetedSplatCount: number;
  /**
   * Shrinks the mesh to its `count` most visible splats, when it can (see
   * {@link SplatData.drawOrder}). Returns the count it now holds.
   */
  shrinkToBudget(count: number): number;
}

/**
 * The budget's handle on one loaded scene, carried from the loader to the
 * mesh constructed from its data.
 *
 * @internal
 */
export interface SplatBudgetLink {
  /** The mesh built from the data; called once, from its constructor. */
  attach(tenant: SplatBudgetTenant): void;
  /** The mesh was disposed: its splats leave the budget. */
  detach(tenant: SplatBudgetTenant): void;
}

// Keyed by the data object itself, so the link travels with exactly the
// object the loader returned and nothing has to be added to `SplatData`'s
// public shape (it could not cross the worker boundary anyway).
const links = new WeakMap<SplatData, SplatBudgetLink>();

/** @internal Marks `data` as budgeted; the mesh built from it reports in. */
export function linkSplatBudget(data: SplatData, link: SplatBudgetLink): void {
  links.set(data, link);
}

/** @internal The budget link of `data`, if any. A link is taken at most once. */
export function takeSplatBudgetLink(data: SplatData): SplatBudgetLink | undefined {
  const link = links.get(data);
  links.delete(data);
  return link;
}
