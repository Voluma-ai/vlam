import { describe, expect, it } from 'vitest';
import { parseSplatPly, parseSplatPlyFile } from '../formats/ply/parse-splat-ply';

/** The vertex properties a Gaussian splat PLY carries, in file order. */
const PROPERTY_NAMES = [
  'x',
  'y',
  'z',
  'f_dc_0',
  'f_dc_1',
  'f_dc_2',
  'opacity',
  'scale_0',
  'scale_1',
  'scale_2',
  'rot_0',
  'rot_1',
  'rot_2',
  'rot_3',
] as const;

type Vertex = Partial<Record<(typeof PROPERTY_NAMES)[number], number>>;

interface PlyBuildOptions {
  /** Header line terminator; the parser must accept CRLF too. */
  newline?: '\n' | '\r\n';
  /** Raw text substituted for the vertex count (to inject hostile values). */
  countText?: string;
  /** Header lines inserted before the vertex element declaration. */
  beforeVertex?: string[];
  /** Record bytes for `beforeVertex`'s element, written ahead of the vertices. */
  beforeVertexData?: Float32Array;
  /** Header lines appended after the vertex properties. */
  afterVertex?: string[];
  /** Per-property declared type overrides (default float). */
  propertyTypes?: Partial<Record<(typeof PROPERTY_NAMES)[number], string>>;
  /** Bytes chopped off the end to simulate a truncated download. */
  truncateBytes?: number;
}

/** Builds a binary little-endian splat PLY with float32 vertex records. */
function buildPly(vertices: Vertex[], options: PlyBuildOptions = {}): ArrayBuffer {
  const newline = options.newline ?? '\n';
  const headerLines = [
    'ply',
    'format binary_little_endian 1.0',
    ...(options.beforeVertex ?? []),
    `element vertex ${options.countText ?? vertices.length}`,
    ...PROPERTY_NAMES.map((name) => `property ${options.propertyTypes?.[name] ?? 'float'} ${name}`),
    ...(options.afterVertex ?? []),
    'end_header',
  ];
  const header = new TextEncoder().encode(headerLines.join(newline) + newline);

  const stride = PROPERTY_NAMES.length * 4;
  const body = new DataView(new ArrayBuffer(vertices.length * stride));
  vertices.forEach((vertex, i) => {
    PROPERTY_NAMES.forEach((name, j) => {
      body.setFloat32(i * stride + j * 4, vertex[name] ?? 0, true);
    });
  });

  const leading = new Uint8Array(options.beforeVertexData?.buffer ?? new ArrayBuffer(0));
  const file = new Uint8Array(header.length + leading.byteLength + body.byteLength);
  file.set(header, 0);
  file.set(leading, header.length);
  file.set(new Uint8Array(body.buffer), header.length + leading.byteLength);
  return file.buffer.slice(0, file.length - (options.truncateBytes ?? 0));
}

/** Like {@link buildPly} but appends channel-major `f_rest_*` properties. */
function buildPlyWithRest(
  vertices: Vertex[],
  restProperties: readonly (readonly [string, string])[],
): ArrayBuffer {
  const newline = '\n';
  const headerLines = [
    'ply',
    'format binary_little_endian 1.0',
    `element vertex ${vertices.length}`,
    ...PROPERTY_NAMES.map((name) => `property float ${name}`),
    ...restProperties.map(([name, type]) => `property ${type} ${name}`),
    'end_header',
  ];
  const header = new TextEncoder().encode(headerLines.join(newline) + newline);
  const stride = (PROPERTY_NAMES.length + restProperties.length) * 4;
  const body = new DataView(new ArrayBuffer(vertices.length * stride));
  vertices.forEach((vertex, i) => {
    PROPERTY_NAMES.forEach((name, j) => {
      body.setFloat32(i * stride + j * 4, vertex[name] ?? 0, true);
    });
    restProperties.forEach(([name], j) => {
      body.setFloat32(
        i * stride + (PROPERTY_NAMES.length + j) * 4,
        (vertex as Record<string, number>)[name] ?? 0,
        true,
      );
    });
  });
  const file = new Uint8Array(header.length + body.byteLength);
  file.set(header, 0);
  file.set(new Uint8Array(body.buffer), header.length);
  return file.buffer;
}

describe('parseSplatPly', () => {
  it('round-trips position, opacity, rotation, and scale', () => {
    // 90° rotation about z (w, x, y, z) = (√½, 0, 0, √½) swaps the x/y
    // scale axes, so Σ = diag(1, 4, 1) proves the quaternion order.
    const data = parseSplatPly(
      buildPly([
        {
          x: 1,
          y: 2,
          z: 3,
          opacity: 0, // logit 0 → sigmoid 0.5
          scale_0: Math.log(2),
          scale_1: 0,
          scale_2: 0,
          rot_0: Math.SQRT1_2,
          rot_3: Math.SQRT1_2,
        },
      ]),
    );

    expect(data.count).toBe(1);
    expect(Array.from(data.positions)).toEqual([1, 2, 3]);
    expect(data.colors[3]).toBe(128);
    const covariance = Array.from(data.covariances);
    const expected = [1, 0, 0, 4, 0, 1];
    covariance.forEach((value, i) => expect(value).toBeCloseTo(expected[i] as number, 5));
  });

  it('bakes the SH DC term into 8-bit color', () => {
    // f_dc = 0 → 0.5 + 0 → mid gray on all three channels.
    const data = parseSplatPly(buildPly([{ f_dc_0: 0, f_dc_1: 0, f_dc_2: 0 }]));
    expect(Array.from(data.colors.subarray(0, 3))).toEqual([128, 128, 128]);
  });

  it('packs higher-order f_rest_* into shPacked', () => {
    const rest = Array.from({ length: 9 }, (_, i) => [`f_rest_${i}`, 'float'] as const);
    const buffer = buildPlyWithRest(
      [{ x: 1, f_rest_0: 0.5, f_rest_3: -0.25, f_rest_6: 0.1 } as Vertex & Record<string, number>],
      rest,
    );
    const data = parseSplatPly(buffer);
    expect(data.shPacked?.bands).toBe(1);
    expect(data.shPacked?.packed.length).toBe(3);
  });

  it('accepts CRLF line endings in the header', () => {
    const data = parseSplatPly(buildPly([{ x: 5 }, { x: 6 }], { newline: '\r\n' }));
    expect(data.count).toBe(2);
    expect(data.positions[0]).toBe(5);
    expect(data.positions[3]).toBe(6);
  });

  it('ignores elements declared after the vertex data', () => {
    const data = parseSplatPly(
      buildPly([{ x: 7 }], {
        afterVertex: ['element face 0', 'property list uchar int vertex_indices'],
      }),
    );
    expect(data.count).toBe(1);
    expect(data.positions[0]).toBe(7);
  });

  it('rejects a truncated buffer', () => {
    expect(() => parseSplatPly(buildPly([{}, {}], { truncateBytes: 4 }))).toThrow(/Truncated PLY/);
  });

  it('rejects hostile vertex counts', () => {
    expect(() => parseSplatPly(buildPly([{}], { countText: 'NaN' }))).toThrow(/vertex count/);
    expect(() => parseSplatPly(buildPly([{}], { countText: '-5' }))).toThrow(/vertex count/);
    expect(() => parseSplatPly(buildPly([{}], { countText: '9007199254740993' }))).toThrow(
      /vertex count/,
    );
    // Huge but representable: caught by the file-size check, not by OOM.
    expect(() => parseSplatPly(buildPly([{}], { countText: '1000000000' }))).toThrow(
      /Truncated PLY/,
    );
  });

  it('reads vertex data that a leading element pushes down the file', () => {
    // A preceding element shifts where the vertex records start; the header
    // reader resolves each element's offset rather than assuming the vertices
    // sit directly after the header (which would decode the leading element's
    // bytes as splats).
    const data = parseSplatPly(
      buildPly([{ x: 7, y: 8, z: 9 }], {
        beforeVertex: ['element other 2', 'property float min_x'],
        beforeVertexData: new Float32Array([111, 222]),
      }),
    );
    expect(data.count).toBe(1);
    expect(Array.from(data.positions)).toEqual([7, 8, 9]);
  });

  it('rejects a leading element whose records are missing', () => {
    // Declared but absent: the vertices cannot be where the header implies.
    expect(() =>
      parseSplatPly(buildPly([{}], { beforeVertex: ['element other 8', 'property float min_x'] })),
    ).toThrow(/Truncated PLY/);
  });

  it('rejects non-float32 required properties', () => {
    expect(() => parseSplatPly(buildPly([{}], { propertyTypes: { opacity: 'double' } }))).toThrow(
      /Unsupported PLY property type/,
    );
  });

  it('rejects a non-PLY buffer', () => {
    expect(() => parseSplatPly(new TextEncoder().encode('not a ply').buffer)).toThrow(/Not a PLY/);
  });
});

describe('parseSplatPlyFile (streamed)', () => {
  /** A spread of distinct values, so a misplaced record cannot pass. */
  const vertices = Array.from({ length: 37 }, (_, i) => ({
    x: i,
    y: i * 2,
    z: -i,
    f_dc_0: (i % 7) / 7,
    f_dc_1: (i % 5) / 5,
    f_dc_2: (i % 3) / 3,
    opacity: (i % 11) - 5,
    scale_0: Math.log(1 + (i % 4)),
    scale_1: 0,
    scale_2: Math.log(2),
    rot_0: Math.SQRT1_2,
    rot_3: Math.SQRT1_2,
  }));

  /** Every window size from "one record" up to "the whole file at once". */
  it.each([1, 56, 57, 200, 64 * 1024 * 1024])(
    'streams identically to the whole-buffer parse at windowBytes=%i',
    async (windowBytes) => {
      const buffer = buildPly(vertices);
      const whole = parseSplatPly(buffer);
      const streamed = await parseSplatPlyFile(new File([buffer], 'scene.ply'), { windowBytes });

      expect(streamed.count).toBe(whole.count);
      // Bit-identical, not approximately: both paths run the same decoder, so
      // any window-rebasing slip shows up as a shifted record.
      expect(Array.from(streamed.positions)).toEqual(Array.from(whole.positions));
      expect(Array.from(streamed.colors)).toEqual(Array.from(whole.colors));
      expect(Array.from(streamed.covariances)).toEqual(Array.from(whole.covariances));
    },
  );

  it('streams a vertex element that a leading element pushes down the file', async () => {
    const buffer = buildPly(vertices, {
      beforeVertex: ['element other 2', 'property float min_x'],
      beforeVertexData: new Float32Array([111, 222]),
    });
    const streamed = await parseSplatPlyFile(new File([buffer], 'scene.ply'), { windowBytes: 56 });
    expect(Array.from(streamed.positions)).toEqual(Array.from(parseSplatPly(buffer).positions));
  });

  it('dispatches a compressed file to the compressed decoder', async () => {
    // Detection happens on the header window, before any streaming decision.
    const header = [
      'ply',
      'format binary_little_endian 1.0',
      'element chunk 1',
      ...[
        'min_x',
        'min_y',
        'min_z',
        'max_x',
        'max_y',
        'max_z',
        'min_scale_x',
        'min_scale_y',
        'min_scale_z',
        'max_scale_x',
        'max_scale_y',
        'max_scale_z',
      ].map((n) => `property float ${n}`),
      'element vertex 1',
      'property uint packed_position',
      'property uint packed_rotation',
      'property uint packed_scale',
      'property uint packed_color',
      'end_header',
    ].join('\n');
    const head = new TextEncoder().encode(`${header}\n`);
    const file = new Uint8Array(head.length + 12 * 4 + 16);
    file.set(head, 0);
    const view = new DataView(file.buffer);
    // Position bounds 0..1; scale bounds pinned so exp(0) = 1.
    for (let i = 3; i < 6; i++) view.setFloat32(head.length + i * 4, 1, true);
    view.setUint32(head.length + 48 + 0, 0xffffffff, true); // position → max
    view.setUint32(head.length + 48 + 12, 0x000000ff, true); // color → opaque
    const data = await parseSplatPlyFile(new File([file.buffer], 'compressed.ply'));
    expect(data.count).toBe(1);
    expect(Array.from(data.positions)).toEqual([1, 1, 1]);
    expect(data.colors[3]).toBe(255);
  });

  it('reports progress that rises to exactly the vertex byte total', async () => {
    const calls: [number, number][] = [];
    const stride = 14 * 4; // the 14 float properties buildPly writes
    await parseSplatPlyFile(new File([buildPly(vertices)], 'scene.ply'), {
      windowBytes: stride * 10, // 4 windows over 37 records
      onProgress: (loaded, total) => calls.push([loaded, total]),
    });

    const total = vertices.length * stride;
    // Starts at 0 so a bar appears immediately rather than after the first
    // window, and ends exactly full rather than at 97%.
    expect(calls[0]).toEqual([0, total]);
    expect(calls[calls.length - 1]).toEqual([total, total]);
    expect(calls).toHaveLength(5); // the initial 0 plus one per window
    // Monotonic, and never over the total.
    const loaded = calls.map(([l]) => l);
    expect(loaded).toEqual([...loaded].sort((a, b) => a - b));
    expect(Math.max(...loaded)).toBe(total);
  });

  it('decodes fine without an onProgress callback', async () => {
    const data = await parseSplatPlyFile(new File([buildPly(vertices)], 'scene.ply'), {
      windowBytes: 56,
    });
    expect(data.count).toBe(vertices.length);
  });

  it('honors an abort signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      parseSplatPlyFile(new File([buildPly(vertices)], 'scene.ply'), {
        signal: controller.signal,
        windowBytes: 56,
      }),
    ).rejects.toThrow(/abort/i);
  });

  it('reports a truncated file from its declared size, not its buffer', async () => {
    const buffer = buildPly(vertices, { truncateBytes: 100 });
    await expect(parseSplatPlyFile(new File([buffer], 'scene.ply'))).rejects.toThrow(
      /Truncated PLY/,
    );
  });
});
