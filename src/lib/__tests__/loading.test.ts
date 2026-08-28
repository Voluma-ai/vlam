import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_ARRAY_BUFFER_BYTES,
  SplatLoadError,
  createProgressThrottle,
  readWholeFile,
  splatFormatForExtension,
  splatNameExtension,
  splatUrlExtension,
} from '../loaders/loading';

describe('splatNameExtension', () => {
  it('lower-cases the extension of a plain file name', () => {
    expect(splatNameExtension('Scene.PLY')).toBe('.ply');
  });

  it('takes the last extension of a multi-dotted name', () => {
    expect(splatNameExtension('goose.v2.sog')).toBe('.sog');
  });

  it('returns an empty string when there is no extension', () => {
    expect(splatNameExtension('goose')).toBe('');
  });
});

describe('splatUrlExtension', () => {
  it('ignores query and hash text', () => {
    expect(splatUrlExtension(new URL('https://x.test/a/goose.sog?v=2#top'))).toBe('.sog');
  });
});

describe('splatFormatForExtension', () => {
  it.each([
    ['.ply', 'ply'],
    ['.spz', 'spz'],
    ['.splat', 'splat'],
    ['.ksplat', 'ksplat'],
    ['.sog', 'sog'],
  ])('maps %s to the %s parser', (extension, format) => {
    expect(splatFormatForExtension(extension, 'goose')).toBe(format);
  });

  it('names the input in the failure, so a local file reports its file name', () => {
    expect(() => splatFormatForExtension('.obj', 'goose.obj')).toThrow(
      /Unsupported splat file extension in goose\.obj/,
    );
  });

  it('throws a SplatLoadError (phase resolve, not retryable) for an unknown extension', () => {
    let error: unknown;
    try {
      splatFormatForExtension('.obj', 'goose.obj');
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(SplatLoadError);
    const loadError = error as SplatLoadError;
    expect(loadError.phase).toBe('resolve');
    expect(loadError.retryable).toBe(false);
    expect(loadError.url).toBe('goose.obj');
  });
});

describe('readWholeFile', () => {
  /** A stand-in for a file too large to exist in a test process. */
  function fakeFile(name: string, size: number, read: () => Promise<ArrayBuffer>): File {
    return { name, size, arrayBuffer: read } as unknown as File;
  }

  it('reads a normal file through', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const buffer = await readWholeFile(new File([bytes], 'small.ply'));
    expect(new Uint8Array(buffer)).toEqual(bytes);
  });

  it('rejects a file past the 2 GiB ArrayBuffer ceiling before attempting the read', async () => {
    let attempted = false;
    const file = fakeFile('point_cloud_1.ply', 4_000_000_000, async () => {
      attempted = true;
      return new ArrayBuffer(0);
    });
    // The read itself would fail with Chrome's NotReadableError, whose text
    // blames permissions - the whole point is to not get there.
    await expect(readWholeFile(file)).rejects.toThrow(/4\.0 GB.*cannot read more than 2 GB/s);
    expect(attempted).toBe(false);
  });

  it('allows a file exactly at the ceiling', async () => {
    const file = fakeFile('edge.sog', MAX_ARRAY_BUFFER_BYTES, async () => new ArrayBuffer(8));
    await expect(readWholeFile(file)).resolves.toBeInstanceOf(ArrayBuffer);
  });

  it('rewrites NotReadableError into what actually tends to cause it', async () => {
    const file = fakeFile('moved.ply', 1024, async () => {
      throw Object.assign(
        new Error('The requested file could not be read, typically due to permission problems…'),
        {
          name: 'NotReadableError',
        },
      );
    });
    await expect(readWholeFile(file)).rejects.toThrow(/moved, renamed or changed/);
  });

  it('passes other read failures through untouched', async () => {
    const file = fakeFile('odd.ply', 1024, async () => {
      throw new Error('disk on fire');
    });
    await expect(readWholeFile(file)).rejects.toThrow(/disk on fire/);
  });
});

describe('createProgressThrottle', () => {
  // `monotonicNow` reads performance.now(), so the clock has to be faked to
  // drive the interval deterministically.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['performance', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the first update immediately', () => {
    const report = vi.fn();
    createProgressThrottle(report)(0, 1000);
    expect(report).toHaveBeenCalledExactlyOnceWith(0, 1000);
  });

  it('drops updates that arrive inside the interval', () => {
    const report = vi.fn();
    const throttled = createProgressThrottle(report);
    throttled(0, 1000);
    for (let loaded = 64; loaded < 500; loaded += 64) throttled(loaded, 1000);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('reports again once the interval has passed', () => {
    const report = vi.fn();
    const throttled = createProgressThrottle(report);
    throttled(0, 1000);
    vi.advanceTimersByTime(100);
    throttled(500, 1000);
    expect(report).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenLastCalledWith(500, 1000);
  });

  it('never drops the final update of a known-size read', () => {
    const report = vi.fn();
    const throttled = createProgressThrottle(report);
    throttled(0, 1000);
    // Immediately after the first report, so the interval has not elapsed.
    throttled(1000, 1000);
    expect(report).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenLastCalledWith(1000, 1000);
  });

  // Regression: `total` is 0 for a body with no Content-Length. The final-update
  // exemption used to read `loaded < total`, which is false for every update
  // when total is 0 - so the throttle never engaged and each ~64 KB chunk
  // posted a message.
  it('throttles a stream of unknown size, which has no final update', () => {
    const report = vi.fn();
    const throttled = createProgressThrottle(report);
    throttled(0, 0);
    for (let loaded = 65_536; loaded <= 65_536 * 200; loaded += 65_536) throttled(loaded, 0);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('still reports an unknown-size stream once per interval', () => {
    const report = vi.fn();
    const throttled = createProgressThrottle(report);
    throttled(0, 0);
    vi.advanceTimersByTime(100);
    throttled(65_536, 0);
    vi.advanceTimersByTime(100);
    throttled(131_072, 0);
    expect(report).toHaveBeenCalledTimes(3);
  });
});
