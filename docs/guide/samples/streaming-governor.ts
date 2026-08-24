// Guide sample: docs/guide/streaming-and-lod.md - one device budget shared
// across a main scene and a marker mesh via BudgetGovernor.
import { BudgetGovernor, StreamedSplatMesh } from '@voluma/vlam';

export async function openWithSharedBudget() {
  const main = await StreamedSplatMesh.load('/city/lod-meta.json');
  const markers = await StreamedSplatMesh.load('/markers/lod-meta.json');

  // The governor splits one total (default: the per-device budget) across
  // members by weight, steering each through its public setBudget.
  const governor = new BudgetGovernor();
  governor.register(main, { weight: 7 }); // main gets 0.7 of the total…
  governor.register(markers, { weight: 3 }); // …markers the remaining 0.3

  // Later - closing the marker layer returns its share to the main mesh:
  //   governor.unregister(markers);
  // Manual override is still available on any mesh not registered:
  //   standalone.setBudget(500_000);
  return { main, markers, governor };
}
