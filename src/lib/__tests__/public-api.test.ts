import { describe, expect, expectTypeOf, it } from 'vitest';

/**
 * API-freeze smoke test (E9). Imports ONLY public entrypoints - the
 * main index and the optional subpath entry files that back
 * `@voluma/vlam/{loaders,static-lod,streaming,unified,selection,effects,formats/*}` -
 * never deep internals. If an export is removed or renamed, this file stops
 * compiling and the suite fails, so accidental surface changes are caught in
 * CI before they reach an embedder.
 *
 * Runtime instantiation is limited to what works without a GPU or DOM;
 * everything else is checked at the type/typeof level.
 */
import * as vlam from '../index';
import * as loaders from '../loaders';
import * as staticLod from '../static-lod-entry';
import * as streaming from '../streaming';
import * as unified from '../unified';
import * as selection from '../selection';
import * as effects from '../effects';
import * as ply from '../formats/ply/index';
import * as sog from '../formats/sog/index';
import * as rad from '../formats/rad/index';
import * as lcc from '../formats/lcc/index';
import * as spz from '../formats/spz/index';
import * as splat from '../formats/splat/index';
import * as ksplat from '../formats/ksplat/index';

const movedOffRoot = [
  'loadSplatData',
  'loadSplatDataFile',
  'ChunkLoader',
  'SplatLoadError',
  'isAbortError',
  'StaticLodSplatMesh',
  'StreamedSplatMesh',
  'BudgetGovernor',
  'CameraBudgetGovernor',
  'ChunkFetchScheduler',
  'ChunkCacheBudget',
  'httpDatasetSource',
  'createLocalDataset',
  'UnifiedSplatMesh',
  'supportsUnifiedSplatMesh',
  'createSelectionVolume',
  'selectInData',
  'countInData',
  'partitionSplatData',
  'resolveCpuCacheBytes',
  'estimateLargestStorageBufferBytes',
  'estimateUnifiedWorkBufferBytes',
  'estimateUnifiedWorkBufferPeakBytes',
  'WORK_BUFFER_CENTERS_BYTES_PER_SPLAT',
  'WORK_BUFFER_BYTES_PER_SLOT',
] as const;

const removedExports = [
  'UnifiedSplatRenderer',
  'UnifiedSplatRendererOptions',
  'supportsUnifiedSplatRenderer',
  'SplatScene',
  'SplatSceneOptions',
  'AddSourceOptions',
  'MAX_SOURCES',
  'loadScene',
  'loadSceneFile',
  'SplatLoadOptions',
  'SplatFileLoadOptions',
  'SplatSourceFormat',
  'SceneCollision',
] as const;

describe('public API surface (vlam)', () => {
  it('exports the core classes', () => {
    expect(typeof vlam.SplatMesh).toBe('function');
    expect(typeof vlam.MergedSplatMesh).toBe('function');
    expect(typeof vlam.ModifierSlots).toBe('function');
    for (const name of movedOffRoot) {
      expect(name in vlam).toBe(false);
    }
    for (const name of removedExports) {
      expect(name in vlam).toBe(false);
    }
  });

  it('keeps parsers off the core entry', () => {
    expect('parseSplatPly' in vlam).toBe(false);
    expect('parseSog' in vlam).toBe(false);
    expect('parseSogDirectory' in vlam).toBe(false);
    expect(typeof vlam.setVlamLogHandler).toBe('function');
  });

  it('exports renderer constants and profile resolution', () => {
    expect(vlam.MAX_SH_BANDS).toBe(3);
    expect(vlam.MAX_MERGED_SPLAT_SOURCES).toBeGreaterThan(0);
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
    expect(typeof vlam.deviceMaxStorageBufferBindingSize).toBe('function');
    expect(typeof vlam.assertStorageBufferFitsDevice).toBe('function');
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
    const slots = new vlam.ModifierSlots(['reveal', 'sdf', 'lighting', 'fog', 'opacity']);
    expect(slots).toBeInstanceOf(vlam.ModifierSlots);

    const clamped = vlam.clampDepthOfFieldSettings({ focusDistance: -1, aperture: 2 });
    expect(clamped.focusDistance).toBeGreaterThan(0);

    expect(vlam.createYUpTransform().determinant()).toBeCloseTo(1);
    expect(vlam.yUpTransformForFormat('spz')).toBeNull();
  });

  it('keeps the public option/result types nameable', () => {
    expectTypeOf<vlam.SplatMeshOptions>().toBeObject();
    expectTypeOf<vlam.SplatUpdateOptions>().toBeObject();
    expectTypeOf<vlam.DepthOfFieldSettings>().toBeObject();
    expectTypeOf<vlam.RelightingSettings>().toBeObject();
    expectTypeOf<vlam.RelightingUniforms>().toBeObject();
    expectTypeOf<vlam.SplatPickOptions>().toBeObject();
    expectTypeOf<vlam.SplatChannelOptions>().toBeObject();
    expectTypeOf<vlam.MergedSplatMeshOptions>().toBeObject();
    expectTypeOf<vlam.MergedSplatSourceOptions>().toBeObject();
    expectTypeOf<vlam.AdaptivePixelRatioInput>().toBeObject();
    expectTypeOf<vlam.WebGpuRequiredLimits>().toBeObject();

    expectTypeOf<vlam.SplatPickResult>().toBeObject();
    expectTypeOf<vlam.SplatNearestResult>().toBeObject();
    expectTypeOf<vlam.SplatHeightResult>().toBeObject();
    expectTypeOf<vlam.SplatData>().toBeObject();
    expectTypeOf<vlam.SplatShData>().toBeObject();
    expectTypeOf<vlam.SplatPackedShData>().toBeObject();
    expectTypeOf<vlam.SplatModifier>().toBeObject();
    expectTypeOf<vlam.SplatContext>().toBeObject();
    expectTypeOf<vlam.SplatOutputs>().toBeObject();
    expectTypeOf<vlam.SplatRange>().toBeObject();
    expectTypeOf<vlam.SplatDeviceProfile>().toBeObject();
    expectTypeOf<vlam.AdaptivePixelRatioResult>().toBeObject();
    expectTypeOf<vlam.ModifierStackTarget>().toBeObject();
    expectTypeOf<vlam.UnifiedSourceView>().toBeObject();
    expectTypeOf<vlam.Vec3Uniform>().toBeObject();
    expectTypeOf<vlam.SplatShInputs>().not.toBeNever();

    expectTypeOf<vlam.SplatOrientation>().toEqualTypeOf<'y-up' | 'source'>();
    expectTypeOf<vlam.SplatSortStrategy>().toEqualTypeOf<'counting' | 'radix' | 'exact'>();
    expectTypeOf<vlam.SplatPerformanceProfile>().toEqualTypeOf<'quality' | 'smooth'>();
    expectTypeOf<vlam.SplatDataFormat>().toEqualTypeOf<
      'ply' | 'sog' | 'spz' | 'splat' | 'ksplat' | 'rad'
    >();
    expectTypeOf<vlam.SplatData['format']>().toEqualTypeOf<vlam.SplatDataFormat | undefined>();
    expectTypeOf<vlam.StreamedSplatFormat>().toBeString();
    expectTypeOf<vlam.OrientableFormat>().toBeString();
    expectTypeOf<vlam.SplatChannelType>().toBeString();
    expectTypeOf<vlam.VlamLogLevel>().toEqualTypeOf<'warn' | 'error'>();
    expectTypeOf<vlam.VlamLogHandler>().toBeFunction();
  });
});

describe('public API surface (@voluma/vlam/loaders)', () => {
  it('exports the loading pipeline and keeps mesh/LOD out', () => {
    expect(typeof loaders.loadSplatData).toBe('function');
    expect(typeof loaders.loadSplatDataFile).toBe('function');
    expect(typeof loaders.ChunkLoader).toBe('function');
    expect(typeof loaders.SplatLoadError).toBe('function');
    expect(typeof loaders.isAbortError).toBe('function');
    expect('SplatMesh' in loaders).toBe(false);
    expect('StaticLodSplatMesh' in loaders).toBe(false);
    expect('StreamedSplatMesh' in loaders).toBe(false);
    expect('loadScene' in loaders).toBe(false);
    expect('loadSceneFile' in loaders).toBe(false);
    expect('SplatLoadOptions' in loaders).toBe(false);
    expect('SplatFileLoadOptions' in loaders).toBe(false);
    expect('SplatSourceFormat' in loaders).toBe(false);

    const err = new loaders.SplatLoadError('nope', {
      phase: 'fetch',
      url: 'https://example.invalid/scene.sog',
      retryable: true,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.phase).toBe('fetch');
    expect(loaders.isAbortError(err)).toBe(false);

    expectTypeOf<loaders.SplatDataLoadOptions>().toBeObject();
    expectTypeOf<loaders.SplatDataFileLoadOptions>().toBeObject();
    expectTypeOf<loaders.SplatRequestOptions>().toBeObject();
    expectTypeOf<loaders.SplatProgressCallback>().toBeFunction();
    expectTypeOf<loaders.SplatInputOptions>().toBeObject();
    expectTypeOf<loaders.SplatDataLoadOptions>().toExtend<loaders.SplatInputOptions>();
    expectTypeOf<loaders.SplatLoadPhase>().toEqualTypeOf<
      'resolve' | 'manifest' | 'fetch' | 'decode' | 'worker'
    >();
    expectTypeOf<loaders.SplatFormat>().toBeString();
    expectTypeOf<loaders.ChunkFileFormat>().toEqualTypeOf<
      'ply' | 'sog' | 'spz' | 'splat' | 'ksplat' | 'rad' | 'lcc-bin' | 'rad-chunk'
    >();
  });
});

describe('public API surface (@voluma/vlam/static-lod)', () => {
  it('exports StaticLodSplatMesh.load and not the streaming alias', () => {
    expect(typeof staticLod.StaticLodSplatMesh).toBe('function');
    expect(typeof staticLod.StaticLodSplatMesh.load).toBe('function');
    expect('loadAutoLod' in staticLod.StaticLodSplatMesh).toBe(false);
    expect('StreamedSplatMesh' in staticLod).toBe(false);
    expectTypeOf<staticLod.StaticLodSplatMeshOptions>().toBeObject();
    expectTypeOf<staticLod.StaticLodSplatMeshLoadOptions>().toBeObject();
    expectTypeOf<staticLod.StaticLodLoadProgress>().toBeObject();
    expectTypeOf<staticLod.StaticLodBuildProgress>().toBeObject();
  });
});

describe('public API surface (@voluma/vlam/streaming)', () => {
  it('exports streaming types and re-exports load errors', () => {
    expect(typeof streaming.StreamedSplatMesh).toBe('function');
    expect(typeof streaming.StreamedSplatMesh.load).toBe('function');
    expect(typeof streaming.StreamedSplatMesh.loadLocal).toBe('function');
    expect('loadAutoLod' in streaming.StreamedSplatMesh).toBe(false);
    expect(typeof streaming.BudgetGovernor).toBe('function');
    expect(typeof streaming.CameraBudgetGovernor).toBe('function');
    expect(typeof streaming.ChunkFetchScheduler).toBe('function');
    expect(typeof streaming.ChunkCacheBudget).toBe('function');
    expect(typeof streaming.httpDatasetSource).toBe('function');
    expect(typeof streaming.createLocalDataset).toBe('function');
    expect(typeof streaming.resolveCpuCacheBytes).toBe('function');
    expect(typeof streaming.SplatLoadError).toBe('function');
    expect(typeof streaming.isAbortError).toBe('function');
    expect('StaticLodSplatMesh' in streaming).toBe(false);

    const governor = new streaming.BudgetGovernor({ totalBudget: 1000 });
    expect(governor).toBeInstanceOf(streaming.BudgetGovernor);

    expectTypeOf<streaming.StreamedSplatMeshOptions>().toBeObject();
    expectTypeOf<streaming.BudgetGovernorOptions>().toBeObject();
    expectTypeOf<streaming.PersistentChannelOptions>().toBeObject();
    expectTypeOf<streaming.SplatRequestOptions>().toBeObject();
    expectTypeOf<streaming.CollisionMeshTile>().toBeObject();
    expectTypeOf<streaming.SplatCollisionData>().toBeObject();
    expectTypeOf<streaming.CollisionMeshDescriptor>().toBeObject();
    expectTypeOf<streaming.EnvironmentTile>().toBeObject();
    expectTypeOf<streaming.SplatDatasetSource>().toBeObject();
    expectTypeOf<streaming.LocalDataset>().toBeObject();
    expectTypeOf<streaming.StreamedSplatPerformanceEvent>().toBeObject();
    expect('SceneCollision' in streaming).toBe(false);
  });
});

describe('public API surface (@voluma/vlam/unified)', () => {
  it('exports the compositor and work-buffer estimates', () => {
    expect(typeof unified.UnifiedSplatMesh).toBe('function');
    expect(typeof unified.supportsUnifiedSplatMesh).toBe('function');
    expect(typeof unified.estimateLargestStorageBufferBytes).toBe('function');
    expect(typeof unified.estimateUnifiedWorkBufferBytes).toBe('function');
    expect(typeof unified.estimateUnifiedWorkBufferPeakBytes).toBe('function');
    expect(unified.WORK_BUFFER_CENTERS_BYTES_PER_SPLAT).toBeGreaterThan(0);
    expect(unified.WORK_BUFFER_BYTES_PER_SLOT).toBeGreaterThan(0);
    expectTypeOf<unified.UnifiedSplatMeshOptions>().toBeObject();
    expectTypeOf<unified.UnifiedSplatSourceOptions>().toBeObject();
    expectTypeOf<unified.UnifiedSplatPickResult['source']>().toEqualTypeOf<vlam.SplatMesh>();
    expect('UnifiedSplatRenderer' in unified).toBe(false);
    expect('supportsUnifiedSplatRenderer' in unified).toBe(false);
  });
});

describe('public API surface (@voluma/vlam/selection)', () => {
  it('exports volume select and partition helpers', () => {
    expect(typeof selection.createSelectionVolume).toBe('function');
    expect(typeof selection.selectInData).toBe('function');
    expect(typeof selection.countInData).toBe('function');
    expect(typeof selection.partitionSplatData).toBe('function');
    expectTypeOf<selection.SelectionVolume>().toBeObject();
    expectTypeOf<selection.SelectionVolumeOptions>().toBeObject();
    expectTypeOf<selection.SplatPartition>().toBeObject();
    expectTypeOf<selection.SelectionVolumeKind>().toEqualTypeOf<'box' | 'sphere' | 'cylinder'>();
    expect('partitionTriangleMesh' in selection).toBe(false);
    expect('gatherSplatData' in selection).toBe(false);
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
    expect(typeof effects.renderRelightingFactorMap).toBe('function');
    expectTypeOf<effects.SdfShape>().toBeObject();
    expectTypeOf<effects.SdfShapeKind>().toEqualTypeOf<'sphere' | 'box' | 'cylinder'>();
    expectTypeOf<effects.SdfMode>().toEqualTypeOf<'tint' | 'desaturate' | 'hide' | 'rim'>();
    expectTypeOf<effects.RelightingProxy>().toBeObject();
    expectTypeOf<effects.RelightingLightContribution>().toBeObject();
    expect(effects.MAX_RELIGHTING_SHADOW_LIGHTS).toBe(32);
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
    expectTypeOf<lcc.CollisionMeshTile>().toEqualTypeOf<streaming.CollisionMeshTile>();
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
    expect('parseSplatPlyFile' in ply).toBe(false);
  });
});
