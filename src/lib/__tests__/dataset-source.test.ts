import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalDataset, httpDatasetSource } from '../streaming/dataset-source';

/**
 * Tests for resolving a streamed dataset's files out of a dropped folder,
 * where there is no URL to resolve relative paths against.
 *
 * `URL.createObjectURL` does not exist under Node, so it is stubbed to a
 * recognizable string - these tests are about *which* file a path resolves
 * to, which is exactly what has no HTTP equivalent to fall back on.
 */
let created: string[] = [];

beforeEach(() => {
  created = [];
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: (file: File) => {
        const url = `blob:test/${created.length}/${file.name}`;
        created.push(url);
        return url;
      },
      revokeObjectURL: (url: string) => {
        created = created.filter((entry) => entry !== url);
      },
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function folder(paths: string[]): Map<string, File> {
  return new Map(
    paths.map((path) => [path, new File(['x'], path.slice(path.lastIndexOf('/') + 1))]),
  );
}

describe('createLocalDataset', () => {
  it('finds an .lcc manifest and resolves its siblings', () => {
    const dataset = createLocalDataset(
      folder(['Casino Eindhoven.lcc', 'index.bin', 'data.bin', 'environment.bin', 'thumb.jpg']),
    );
    expect(dataset.format).toBe('lcc');
    expect(dataset.name).toBe('Casino Eindhoven.lcc');
    expect(dataset.source.resolve('data.bin')).toContain('data.bin');
    expect(dataset.source.resolve('index.bin')).toContain('index.bin');
    // Absent files resolve to null rather than a broken URL.
    expect(dataset.source.resolve('shcoef.bin')).toBeNull();
  });

  it('reports a file’s size without reading it', async () => {
    const files = new Map([
      ['scene.lcc', new File(['{}'], 'scene.lcc')],
      ['environment.bin', new File([new Uint8Array(96 * 4)], 'environment.bin')],
    ]);
    const dataset = createLocalDataset(files);
    expect(await dataset.source.size('environment.bin')).toBe(96 * 4);
    expect(await dataset.source.size('missing.bin')).toBeNull();
  });

  it('resolves paths relative to the manifest, not the drop root', () => {
    // Dropping a folder yields paths prefixed with the folder's own name.
    const dataset = createLocalDataset(folder(['Casino/scene.lcc', 'Casino/data.bin']));
    expect(dataset.source.resolve('data.bin')).toContain('data.bin');
    expect(dataset.source.resolve('./data.bin')).toContain('data.bin');
  });

  it('recognizes .lcc2 and streamed-SOG folders', () => {
    expect(createLocalDataset(folder(['cest_ca.lcc2', 'data/3dgs/0.sog'])).format).toBe('lcc2');
    expect(createLocalDataset(folder(['lod-meta.json', '0_0/meta.json'])).format).toBe(
      'streamed-sog',
    );
  });

  it('recognizes a .rad/.radc chunked-set folder (not the .radc chunks)', () => {
    const dataset = createLocalDataset(folder(['scene.rad', 'scene-0.radc', 'scene-1.radc']));
    expect(dataset.format).toBe('rad');
    expect(dataset.name).toBe('scene.rad'); // the .rad header, not a .radc chunk
    expect(dataset.source.resolve('scene-0.radc')).toContain('blob:');
  });

  it('resolves a nested .lcc2 tile path', () => {
    const dataset = createLocalDataset(folder(['cest_ca.lcc2', 'data/3dgs/0.sog']));
    expect(dataset.source.resolve('data/3dgs/0.sog')).toContain('0.sog');
    expect(dataset.source.resolve('data/3dgs/9.sog')).toBeNull();
  });

  it('hands an unbundled SOG chunk its whole directory', () => {
    const dataset = createLocalDataset(
      folder(['lod-meta.json', '0_0/meta.json', '0_0/means_l.webp', '0_1/meta.json']),
    );
    const chunk = dataset.source.directoryFiles('0_0/');
    expect(Object.keys(chunk ?? {}).sort()).toEqual(['means_l.webp', 'meta.json']);
    // Keyed by name within the chunk, which is how the SOG decoder asks.
    expect(chunk?.['meta.json']).toContain('meta.json');
    expect(dataset.source.directoryFiles('9_9/')).toBeNull();
  });

  it('ignores manifests nested below the top level', () => {
    // An .lcc2 capture nests whole datasets under data/; picking one of those
    // would silently load a fragment of the scene.
    const dataset = createLocalDataset(folder(['scene.lcc2', 'data/inner/other.lcc2']));
    expect(dataset.name).toBe('scene.lcc2');
  });

  it('rejects a folder with no manifest', () => {
    expect(() => createLocalDataset(folder(['data.bin', 'notes.txt']))).toThrow(
      /no streamed-scene manifest/,
    );
  });

  it('rejects an ambiguous folder holding two scenes', () => {
    expect(() => createLocalDataset(folder(['a.lcc', 'b.lcc']))).toThrow(
      /more than one scene manifest/,
    );
  });

  it('creates each file’s URL once, and revokes them all on dispose', () => {
    const dataset = createLocalDataset(folder(['scene.lcc', 'data.bin']));
    dataset.source.resolve('data.bin');
    dataset.source.resolve('data.bin');
    dataset.source.resolve('data.bin');
    expect(created.length).toBe(2); // the manifest and data.bin - not four
    dataset.source.dispose();
    expect(created.length).toBe(0);
  });
});

describe('httpDatasetSource', () => {
  it('resolves relative paths against the manifest URL', () => {
    const source = httpDatasetSource('https://example.test/capture/scene.lcc');
    expect(source.resolve('data.bin')).toBe('https://example.test/capture/data.bin');
    expect(source.resolve('data/3dgs/0.sog')).toBe('https://example.test/capture/data/3dgs/0.sog');
    // An HTTP chunk directory is a real URL, so it needs no file map.
    expect(source.directoryFiles('0_0/')).toBeNull();
  });

  it('reads a size from a HEAD, and falls back to a ranged GET', async () => {
    const head = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 200, headers: { 'content-length': '640' } })),
    );
    vi.stubGlobal('fetch', head);
    expect(await httpDatasetSource('https://example.test/scene.lcc').size('data.bin')).toBe(640);

    // An origin that refuses HEAD but serves ranges still yields the length.
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === 'HEAD'
          ? new Response(null, { status: 405 })
          : new Response('x', { status: 206, headers: { 'content-range': 'bytes 0-0/4096' } }),
      ),
    );
    expect(await httpDatasetSource('https://example.test/scene.lcc').size('data.bin')).toBe(4096);
  });

  it('treats a plain 200 on the ranged probe as unknown size', async () => {
    // A server that ignores Range answers 200 with the whole body; its
    // headers describe the full response, not a probe - size is unknown.
    let cancelled = false;
    const fullBody = (): ReadableStream =>
      new ReadableStream({
        start: (controller) => controller.enqueue(new Uint8Array([1, 2, 3])),
        cancel: () => void (cancelled = true),
      });
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === 'HEAD'
          ? new Response(null, { status: 405 })
          : new Response(fullBody(), { status: 200 }),
      ),
    );
    expect(await httpDatasetSource('https://example.test/scene.lcc').size('data.bin')).toBeNull();
    expect(cancelled).toBe(true);
  });

  it('rejects absurd probed sizes', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(null, { status: 200, headers: { 'content-length': 'NaNsense' } }),
      ),
    );
    expect(await httpDatasetSource('https://example.test/scene.lcc').size('data.bin')).toBeNull();

    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === 'HEAD'
          ? new Response(null, { status: 405 })
          : new Response('x', {
              status: 206,
              headers: { 'content-range': 'bytes 0-0/900719925474099299' },
            }),
      ),
    );
    expect(await httpDatasetSource('https://example.test/scene.lcc').size('data.bin')).toBeNull();
  });

  it('reports a missing file as null', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(null, { status: 404 })));
    expect(
      await httpDatasetSource('https://example.test/scene.lcc').size('environment.bin'),
    ).toBeNull();
  });
});
