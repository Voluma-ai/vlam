import * as THREE from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import {
  attachRelighting,
  clampRelightingSettings,
  createRelightingProxy,
  createRelightingShadowFactorMaterial,
  renderRelightingFactorMap,
  updateRelightingShadowFactorWeights,
} from '../relighting';
import type { DisplayColorModifier } from '../core/splat-mesh-material';

describe('relighting settings', () => {
  it('clamps live numeric settings', () => {
    expect(clampRelightingSettings({ blend: 2, brightness: -1, background: 3 })).toEqual({
      blend: 1,
      brightness: 0,
      background: 3,
      softness: 0,
    });
  });
});

describe('attachRelighting', () => {
  it('composes and restores the prior display callback', () => {
    const previous = vi.fn<DisplayColorModifier>((rgb) => rgb);
    const target: { displayColorModifier: DisplayColorModifier | null } = {
      displayColorModifier: previous,
    };
    const first = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    const second = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
    const disposeFirst = vi.spyOn(first, 'dispose');
    const disposeSecond = vi.spyOn(second, 'dispose');
    const attachment = attachRelighting(target, { map: first });
    const installed = target.displayColorModifier;
    expect(installed).not.toBe(previous);
    attachment.update({ map: first, softness: 2 });
    expect(target.displayColorModifier).toBe(installed);
    attachment.update({ map: second });
    expect(target.displayColorModifier).not.toBe(installed);
    attachment.dispose();
    attachment.dispose();
    expect(disposeFirst).not.toHaveBeenCalled();
    expect(disposeSecond).not.toHaveBeenCalled();
    expect(target.displayColorModifier).toBe(previous);
  });

  it('does not overwrite a callback installed after the attachment', () => {
    const target: { displayColorModifier: DisplayColorModifier | null } = {
      displayColorModifier: null,
    };
    const map = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    const attachment = attachRelighting(target, { map });
    const replacement: DisplayColorModifier = (rgb) => rgb;
    target.displayColorModifier = replacement;
    attachment.dispose();
    expect(target.displayColorModifier).toBe(replacement);
  });
});

describe('proxy helpers', () => {
  it('creates a disposable proxy and factor material', () => {
    const proxy = createRelightingProxy({ geometries: [new THREE.BoxGeometry()] });
    expect(proxy.group.children).toHaveLength(1);
    const material = createRelightingShadowFactorMaterial(new THREE.DirectionalLight());
    expect(material).toBeInstanceOf(THREE.MeshStandardNodeMaterial);
    proxy.dispose();
    material.dispose();
  });

  it('only builds shadow lookups for lights that cast shadows', () => {
    const shadowNodeCount = (material: THREE.MeshStandardNodeMaterial): number => {
      let count = 0;
      material.outputNode!.traverse((node) => {
        if ((node as { isShadowNode?: boolean }).isShadowNode === true) count++;
      });
      return count;
    };
    const caster = new THREE.SpotLight();
    caster.castShadow = true;
    const fillOnly = Array.from({ length: 20 }, () => new THREE.PointLight());
    const material = createRelightingShadowFactorMaterial(
      [
        { light: caster, intensity: 1 },
        ...fillOnly.map((light) => ({ light, intensity: 0, fill: 0.5 })),
      ],
      { combine: 'min' },
    );
    expect(shadowNodeCount(material)).toBe(1);
    material.dispose();
  });

  it('retunes contribution weights in place while the graph shape holds', () => {
    const uniformValues = (material: THREE.MeshStandardNodeMaterial): number[] => {
      const values: number[] = [];
      material.outputNode!.traverse((node) => {
        const uniformNode = node as { isUniformNode?: boolean; value?: unknown };
        if (uniformNode.isUniformNode === true && typeof uniformNode.value === 'number') {
          values.push(uniformNode.value);
        }
      });
      return values;
    };
    const caster = new THREE.SpotLight();
    caster.castShadow = true;
    const bulb = new THREE.PointLight();
    const material = createRelightingShadowFactorMaterial(
      [
        { light: caster, intensity: 1 },
        { light: bulb, intensity: 0, fill: 0.5 },
      ],
      { combine: 'min' },
    );
    const outputNode = material.outputNode;

    expect(
      updateRelightingShadowFactorWeights(material, [
        { light: caster, intensity: 0.25 },
        { light: bulb, intensity: 0, fill: 0.75 },
      ]),
    ).toBe(true);
    expect(material.outputNode).toBe(outputNode);
    expect(uniformValues(material)).toEqual(expect.arrayContaining([0.25, 0.75]));

    // Graph-shaping changes need a new material.
    expect(
      updateRelightingShadowFactorWeights(material, [
        { light: caster, intensity: 0 },
        { light: bulb, intensity: 0, fill: 0.75 },
      ]),
    ).toBe(false);
    expect(updateRelightingShadowFactorWeights(material, [{ light: caster, intensity: 1 }])).toBe(
      false,
    );
    caster.castShadow = false;
    expect(
      updateRelightingShadowFactorWeights(material, [
        { light: caster, intensity: 1 },
        { light: bulb, intensity: 0, fill: 0.5 },
      ]),
    ).toBe(false);
    expect(updateRelightingShadowFactorWeights(new THREE.MeshBasicNodeMaterial(), [])).toBe(false);
    material.dispose();
  });

  it('restores renderer state after a factor pass', () => {
    const target = new THREE.RenderTarget(1, 1);
    const renderer = {
      autoClear: false,
      shadowMap: { enabled: false, autoUpdate: false },
      contextNode: { id: 1 },
      getDrawingBufferSize: vi.fn((size: THREE.Vector2) => size.set(2, 3)),
      getRenderTarget: vi.fn(() => null),
      getActiveCubeFace: vi.fn(() => 0),
      getActiveMipmapLevel: vi.fn(() => 0),
      getMRT: vi.fn(() => null),
      setMRT: vi.fn(),
      setRenderTarget: vi.fn(),
      getClearColor: vi.fn((color: THREE.Color) => color.set(0x123456)),
      getClearAlpha: vi.fn(() => 0.5),
      setClearColor: vi.fn(),
      clear: vi.fn(),
      render: vi.fn(),
    };
    renderRelightingFactorMap(renderer, new THREE.Scene(), new THREE.PerspectiveCamera(), target);
    expect(renderer.autoClear).toBe(false);
    expect(renderer.shadowMap.enabled).toBe(false);
    expect(renderer.contextNode).toEqual({ id: 1 });
  });
});
