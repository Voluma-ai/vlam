import * as THREE from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import {
  attachRelighting,
  clampRelightingSettings,
  createRelightingProxy,
  createRelightingShadowFactorMaterial,
  renderRelightingFactorMap,
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
    const attachment = attachRelighting(target, { map: first });
    const installed = target.displayColorModifier;
    expect(installed).not.toBe(previous);
    attachment.update({ map: first, softness: 2 });
    expect(target.displayColorModifier).toBe(installed);
    attachment.update({ map: second });
    expect(target.displayColorModifier).not.toBe(installed);
    attachment.dispose();
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
