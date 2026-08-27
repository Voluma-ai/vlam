import { describe, expect, expectTypeOf, it } from 'vitest';

/**
 * API-freeze smoke test (E9). Imports ONLY public entrypoints - the
 * main index and the format subpath entry files that back `@voluma/vlam/formats/*` -
 * never deep internals. If an export is removed or renamed, this file stops
 * compiling and the suite fails, so accidental surface changes are caught in
 * CI before they reach an embedder.
 *
 * Runtime instantiation is limited to what works without a GPU or DOM;
 * everything else is checked at the type/typeof level.
 */
import * as vlam from '../index';
import * as effects from '../effects';
import * as ply from '../formats/ply/index';
import * as sog from '../formats/sog/index';
import * as rad from '../formats/rad/index';
import * as lcc from '../formats/lcc/index';
import * as spz from '../formats/spz/index';
import * as splat from '../formats/splat/index';
import * as ksplat from '../formats/ksplat/index';

describe('public API surface (vlam)', () => {
  it('exports the core classes', () => {
    expect(typeof vlam.SplatMesh).toBe('function');
    expect(typeof vlam.StreamedSplatMesh).toBe('function');
    expect(typeof vlam.SplatScene).toBe('function');
    expect(typeof vlam.UnifiedSplatRenderer).toBe('function');
    expect(typeof vlam.supportsUnifiedSplatRenderer).toBe('function');
    expect(typeof vlam.BudgetGovernor).toBe('function');
    expect(typeof vlam.CameraBudgetGovernor).toBe('function');
    expect(typeof vlam.ChunkLoader).toBe('function');
    expect(typeof vlam.ModifierSlots).toBe('function');
    // Streamed static loaders an embedding app drives.
    expect(typeof vlam.StreamedSplatMesh.load).toBe('function');
    expect(typeof vlam.StreamedSplatMesh.loadLocal).toBe('function');
  });

  it('exports the loading pipeline', () => {
    expect(typeof vlam.loadScene).toBe('function');
    expect(typeof vlam.loadSceneFile).toBe('function');
    expect(typeof vlam.SplatLoadError).toBe('function');
    expect(typeof vlam.isAbortError).toBe('function');
    // Every parser now lives on `@voluma/vlam/formats/*`, PLY and SOG included:
    // the main entry loads them through the worker, never by importing them.
    expect('parseSplatPly' in vlam).toBe(false);
    expect('parseSog' in vlam).toBe(false);
    expect('parseSogDirectory' in vlam).toBe(false);
    expect(typeof vlam.httpDatasetSource).toBe('function');
    expect(typeof vlam.createLocalDataset).toBe('function');
    expect(typeof vlam.setVlamLogHandler).toBe('function');
  });

  it('exports renderer constants and profile resolution', () => {
    expect(vlam.MAX_SH_BANDS).toBe(3);
    expect(vlam.MAX_SOURCES).toBeGreaterThan(0);
    // Spark parity: the LOD cut is `targetPx · 2·tan(fovY/2) / renderHeight`,
    // and Spark's `lodRenderScale` defaults to 1 px. A larger default stops the
    // descent early on every ray that does not reach leaves - invisible on
    // small scenes, but landscapes/drone scans then lose detail long before
    // Spark does, and never fetch the finer chunks either.
    expect(vlam.DEFAULT_FOVEATION_TARGET_PX).toBe(1);
    expect(vlam.DEFAULT_FOVEATION_DRAW_BUDGET).toBeGreaterThan(0);
    expect(typeof vlam.resolveSplatPerformanceProfile).toBe('function');
    expect(vlam.resolveSplatPerformanceProfile('smooth')).toBe('smooth');
  });

  it('exports device/budget/limits helpers', () => {
    expect(typeof vlam.resolveSplatBudget).toBe('function');
    expect(typeof vlam.detectSplatDeviceProfile).toBe('function');
    expect(typeof vlam.classifySplatGpuClass).toBe('function');
    expect(typeof vlam.probeSplatGpuClass).toBe('function');
    expect(typeof vlam.isFillConstrainedSplatDevice).toBe('function');
    expect(typeof vlam.recommendedMaxPixelRatio).toBe('function');
    expect(typeof vlam.recommendedRadMaxStdDev).toBe('function');
    expect(typeof vlam.suggestAdaptivePixelRatio).toBe('function');
    expect(vlam.ADAPTIVE_PIXEL_RATIO_WARMUP_FRAMES).toBe(5);
    expect(typeof vlam.estimateSplatPoolBytes).toBe('function');
    expect(typeof vlam.createSplatRenderer).toBe('function');
    expect(typeof vlam.recommendedWebGpuRequiredLimits).toBe('function');
    expect(typeof vlam.supportsWebGpuPowerPreference).toBe('function');
    expect(typeof vlam.webGpuPowerPreferenceOptions).toBe('function');
    expect(typeof vlam.estimateLargestStorageBufferBytes).toBe('function');
    expect(typeof vlam.deviceMaxStorageBufferBindingSize).toBe('function');
    expect(typeof vlam.assertStorageBufferFitsDevice).toBe('function');
    expect(vlam.WORK_BUFFER_CENTERS_BYTES_PER_SPLAT).toBeGreaterThan(0);
    expect(vlam.WEBGPU_DEFAULT_MAX_STORAGE_BUFFER_BINDING_SIZE).toBe(128 * 1024 * 1024);
  });

  it('exports orientation and depth-of-field helpers', () => {
    expect(typeof vlam.createYUpTransform).toBe('function');
    expect(typeof vlam.yUpTransformForFormat).toBe('function');
    expect(typeof vlam.apertureAngleFromSize).toBe('function');
    expect(typeof vlam.computeDofCocVariancePx2).toBe('function');
    expect(typeof vlam.computeDofOpacityFade).toBe('function');
    expect(typeof vlam.clampDepthOfFieldSettings).toBe('function');
    expect(typeof vlam.clampRelightingSettings).toBe('function');
    expect(typeof vlam.createPlaceholderRelightTexture).toBe('function');
    expect(vlam.MAX_DOF_RADIUS_PX).toBeGreaterThan(0);
    expect(vlam.MAX_DOF_VARIANCE).toBeGreaterThan(0);
    expect(vlam.DEFAULT_RELIGHT_BRIGHTNESS).toBe(2);
  });

  it('instantiates the GPU-free runtime surface', () => {
    const governor = new vlam.BudgetGovernor({ totalBudget: 1000 });
    expect(governor).toBeInstanceOf(vlam.BudgetGovernor);

    const slots = new vlam.ModifierSlots(['reveal', 'sdf', 'lighting', 'fog', 'opacity']);
    expect(slots).toBeInstanceOf(vlam.ModifierSlots);

    const err = new vlam.SplatLoadError('nope', {
      phase: 'fetch',
      url: 'https://example.invalid/scene.sog',
      retryable: true,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.phase).toBe('fetch');
    expect(vlam.isAbortError(err)).toBe(false);

    const clamped = vlam.clampDepthOfFieldSettings({ focusDistance: -1, aperture: 2 });
    expect(clamped.focusDistance).toBeGreaterThan(0);

    expect(vlam.createYUpTransform().determinant()).toBeCloseTo(1);
    expect(vlam.yUpTransformForFormat('spz')).toBeNull();
  });

  it('exports selection and separation helpers', () => {
    expect(typeof vlam.createSelectionVolume).toBe('function');
    expect(typeof vlam.selectInData).toBe('function');
    expect(typeof vlam.countInData).toBe('function');
    expect(typeof vlam.partitionSplatData).toBe('function');
    expectTypeOf<vlam.SelectionVolume>().toBeObject();
    expectTypeOf<vlam.SelectionVolumeOptions>().toBeObject();
    expectTypeOf<vlam.SplatPartition>().toBeObject();
    expectTypeOf<vlam.SelectionVolumeKind>().toEqualTypeOf<'box' | 'sphere' | 'cylinder'>();
    // Collision-mesh splitting is format-specific and must stay off the main
    // entry (AGENTS.md: format APIs live on `@voluma/vlam/formats/*`).
    expect('partitionTriangleMesh' in vlam).toBe(false);
    // Nor should the raw index-gather helper leak - partitionSplatData is the
    // validated public path.
    expect('gatherSplatData' in vlam).toBe(false);
  });

  it('keeps the public option/result types nameable', () => {
    // Pure type-level checks: fail to compile if a public type disappears.
    expectTypeOf<vlam.SplatMeshOptions>().toBeObject();
    expectTypeOf<vlam.SplatUpdateOptions>().toBeObject();
    expectTypeOf<vlam.StreamedSplatMeshOptions>().toBeObject();
    expectTypeOf<vlam.SplatLoadOptions>().toBeObject();
    expectTypeOf<vlam.SplatFileLoadOptions>().toBeObject();
    expectTypeOf<vlam.UnifiedSplatRendererOptions>().toBeObject();
    expectTypeOf<vlam.UnifiedSplatSourceOptions>().toBeObject();
    expectTypeOf<vlam.BudgetGovernorOptions>().toBeObject();
    expectTypeOf<vlam.DepthOfFieldSettings>().toBeObject();
    expectTypeOf<vlam.RelightingSettings>().toBeObject();
    expectTypeOf<vlam.RelightingUniforms>().toBeObject();
    expectTypeOf<vlam.SplatPickOptions>().toBeObject();
    expectTypeOf<vlam.SplatChannelOptions>().toBeObject();
    expectTypeOf<vlam.SplatSceneOptions>().toBeObject();
    expectTypeOf<vlam.AddSourceOptions>().toBeObject();
    expectTypeOf<vlam.PersistentChannelOptions>().toBeObject();
    expectTypeOf<vlam.SplatRequestOptions>().toBeObject();
    expectTypeOf<vlam.AdaptivePixelRatioInput>().toBeObject();
    expectTypeOf<vlam.WebGpuRequiredLimits>().toBeObject();

    expectTypeOf<vlam.SplatPickResult>().toBeObject();
    expectTypeOf<vlam.UnifiedSplatPickResult['source']>().toEqualTypeOf<vlam.SplatMesh>();
    expectTypeOf<vlam.SplatNearestResult>().toBeObject();
    expectTypeOf<vlam.SplatHeightResult>().toBeObject();
    expectTypeOf<vlam.SplatData>().toBeObject();
    expectTypeOf<vlam.SplatShData>().toBeObject();
    expectTypeOf<vlam.SplatPackedShData>().toBeObject();
    expectTypeOf<vlam.CollisionMeshTile>().toBeObject();
    expectTypeOf<vlam.SceneCollision>().toBeObject();
    expectTypeOf<vlam.CollisionMeshDescriptor>().toBeObject();
    expectTypeOf<vlam.EnvironmentTile>().toBeObject();
    expectTypeOf<vlam.SplatModifier>().toBeObject();
    expectTypeOf<vlam.SplatContext>().toBeObject();
    expectTypeOf<vlam.SplatOutputs>().toBeObject();
    expectTypeOf<vlam.SplatDatasetSource>().toBeObject();
    expectTypeOf<vlam.LocalDataset>().toBeObject();
    expectTypeOf<vlam.SplatRange>().toBeObject();
    expectTypeOf<vlam.StreamedSplatPerformanceEvent>().toBeObject();
    expectTypeOf<vlam.SplatDeviceProfile>().toBeObject();
    expectTypeOf<vlam.AdaptivePixelRatioResult>().toBeObject();
    expectTypeOf<vlam.ModifierStackTarget>().toBeObject();
    expectTypeOf<vlam.UnifiedSourceView>().toBeObject();
    expectTypeOf<vlam.Vec3Uniform>().toBeObject();
    // SplatShInputs is a union; naming it is the contract under test.
    expectTypeOf<vlam.SplatShInputs>().not.toBeNever();

    // Union/literal contracts embedders switch on.
    expectTypeOf<vlam.SplatOrientation>().toEqualTypeOf<'y-up' | 'source'>();
    expectTypeOf<vlam.SplatSortStrategy>().toEqualTypeOf<'counting' | 'radix' | 'exact'>();
    expectTypeOf<vlam.SplatPerformanceProfile>().toEqualTypeOf<'quality' | 'smooth'>();
    expectTypeOf<vlam.SplatLoadPhase>().toEqualTypeOf<
      'resolve' | 'manifest' | 'fetch' | 'decode' | 'worker'
    >();
    expectTypeOf<vlam.SplatFormat>().toBeString();
    expectTypeOf<vlam.SplatSourceFormat>().toEqualTypeOf<
      'ply' | 'sog' | 'spz' | 'splat' | 'ksplat' | 'rad'
    >();
    expectTypeOf<vlam.SplatData['sourceFormat']>().toEqualTypeOf<
      vlam.SplatSourceFormat | undefined
    >();
    expectTypeOf<vlam.StreamedSplatFormat>().toBeString();
    expectTypeOf<vlam.OrientableFormat>().toBeString();
    expectTypeOf<vlam.SplatChannelType>().toBeString();
    expectTypeOf<vlam.SplatProgressCallback>().toBeFunction();
    // Referenced by every loader signature, so hosts must be able to name them.
    expectTypeOf<vlam.SplatInputOptions>().toBeObject();
    expectTypeOf<vlam.SplatLoadOptions>().toExtend<vlam.SplatInputOptions>();
    expectTypeOf<vlam.ChunkFileFormat>().toEqualTypeOf<
      'ply' | 'sog' | 'spz' | 'splat' | 'ksplat' | 'rad' | 'lcc-bin' | 'rad-chunk'
    >();
    expectTypeOf<vlam.VlamLogLevel>().toEqualTypeOf<'warn' | 'error'>();
    expectTypeOf<vlam.VlamLogHandler>().toBeFunction();
  });
});

describe('public API surface (@voluma/vlam/effects)', () => {
  it('exports the presets', () => {
    expect(typeof effects.sdfEffects).toBe('function');
    expect(typeof effects.lightingPreset).toBe('function');
    expect(typeof effects.revealPreset).toBe('function');
    expect(typeof effects.depthOfFieldPreset).toBe('function');
    expect(typeof effects.worldWarpPreset).toBe('function');
    expect(typeof effects.createRelightingProxy).toBe('function');
    expect(typeof effects.createRelightingShadowFactorMaterial).toBe('function');
    expectTypeOf<effects.SdfShape>().toBeObject();
    expectTypeOf<effects.SdfShapeKind>().toEqualTypeOf<'sphere' | 'box' | 'cylinder'>();
    expectTypeOf<effects.SdfMode>().toEqualTypeOf<'tint' | 'desaturate' | 'hide' | 'rim'>();
    expectTypeOf<effects.RelightingProxy>().toBeObject();
    expectTypeOf<effects.RelightingLightContribution>().toBeObject();
    expect(effects.MAX_RELIGHTING_SHADOW_LIGHTS).toBe(4);
  });
});

describe('public API surface (@voluma/vlam/formats/*)', () => {
  it('rad', () => {
    expect(typeof rad.parseRad).toBe('function');
    expect(typeof rad.parseRadHeaderMeta).toBe('function');
    expect(typeof rad.parseRadChunkStreaming).toBe('function');
    expect(typeof rad.buildRadScene).toBe('function');
    expect(typeof rad.RadLodSource).toBe('function');
    expect(typeof rad.RAD_MAGIC).toBe('number');
    expect(typeof rad.RAD_CHUNK_MAGIC).toBe('number');
    expectTypeOf<rad.RadMeta>().toBeObject();
    expectTypeOf<rad.RadTree>().toBeObject();
    expectTypeOf<rad.RadChunkRange>().toBeObject();
    // Names ChunkLoader.load's `rad` option for hosts wrapping the chunk path.
    expectTypeOf<rad.RadChunkRangeRequest>().toBeObject();
  });

  it('lcc', () => {
    expect(typeof lcc.parseLccManifest).toBe('function');
    expect(typeof lcc.parseLccIndex).toBe('function');
    expect(typeof lcc.parseLccChunk).toBe('function');
    expect(typeof lcc.buildLccScene).toBe('function');
    expect(typeof lcc.buildLcc2Scene).toBe('function');
    expect(typeof lcc.createLcc2ToThreeMatrix).toBe('function');
    expect(typeof lcc.applyLcc2ToThreeTransform).toBe('function');
    expect(typeof lcc.loadCollisionMeshTiles).toBe('function');
    expect(typeof lcc.parseMeshPly).toBe('function');
    expect(typeof lcc.parseCollisionLci).toBe('function');
    expect(typeof lcc.partitionTriangleMesh).toBe('function');
    expectTypeOf<lcc.TriangleMeshPartition>().toBeObject();
    expectTypeOf<lcc.LccManifest>().toBeObject();
    expectTypeOf<lcc.LccIndexCell>().toBeObject();
    expectTypeOf<lcc.TriangleMeshData>().toBeObject();
    // The tile type on the main entry must be the same type the subpath loader
    // returns, so a host can pass tiles between the two without casts.
    expectTypeOf<lcc.CollisionMeshTile>().toEqualTypeOf<vlam.CollisionMeshTile>();
  });

  it('spz / splat / ksplat', () => {
    expect(typeof spz.parseSpz).toBe('function');
    expect(typeof splat.parseSplat).toBe('function');
    expect(typeof ksplat.parseKsplat).toBe('function');
  });

  it('ply / sog', () => {
    expect(typeof ply.parseSplatPly).toBe('function');
    expect(typeof sog.parseSog).toBe('function');
    expect(typeof sog.parseSogDirectory).toBe('function');
    // The streamed local-file reader stays internal - it is the worker's path
    // for a dropped `.ply`, not a documented entry point.
    expect('parseSplatPlyFile' in ply).toBe(false);
  });
});
