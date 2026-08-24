import { describe, expect, it, vi } from 'vitest';
import { SplatLoadError } from '../../lib';
import { describeLoadError } from '../failure';
import { filesFromDirectoryInput } from '../drop-zone';
import { validateSceneUrl, isStreamedScene, isSupportedSplatFile } from '../scene-url';

/**
 * The welcome panel's URL box can only fail in ways the user can act on, so
 * both halves of that contract are pinned here: what the input accepts, and
 * that a cross-origin fetch failure names CORS rather than "check your
 * connection" (the browser reports both identically).
 */

// `describeLoadError` compares against the page origin; the node env has none.
// Stubbed for the whole file - every test here wants the same page origin.
vi.stubGlobal('location', { href: 'https://viewer.test/', origin: 'https://viewer.test' });

/** A network-level failure: fetch phase, no HTTP status - where CORS lands. */
function networkError(url: string): SplatLoadError {
  return new SplatLoadError('Failed to fetch', { phase: 'fetch', url, retryable: true });
}

describe('describeLoadError', () => {
  it('blames CORS for a cross-origin fetch failure', () => {
    const info = describeLoadError(networkError('https://elsewhere.test/scene.sog'), 'scene.sog');
    expect(info.title).toBe('Could not load that URL');
    expect(info.message).toContain('Access-Control-Allow-Origin');
    expect(info.message).toContain('Range');
  });

  it('keeps the plain network message for a same-origin failure', () => {
    const info = describeLoadError(networkError('https://viewer.test/goose.sog'), 'goose.sog');
    expect(info.title).toBe('Network error');
    expect(info.message).toContain('Check your connection');
  });

  it('does not blame CORS for a dropped file streamed through a blob: URL', () => {
    const info = describeLoadError(networkError('blob:https://viewer.test/abc-123'), 'drop.rad');
    expect(info.title).toBe('Network error');
  });

  it('still reports HTTP status codes ahead of the CORS guess', () => {
    const error = new SplatLoadError('not found', {
      phase: 'fetch',
      url: 'https://elsewhere.test/scene.sog',
      status: 404,
      retryable: false,
    });
    expect(describeLoadError(error, 'scene.sog').title).toBe('Scene not found');
  });
});

describe('validateSceneUrl', () => {
  it('accepts an absolute https URL to a supported file', () => {
    expect(validateSceneUrl('  https://cdn.test/a/scene.sog  ')).toEqual({
      url: 'https://cdn.test/a/scene.sog',
    });
  });

  it('accepts a streamed manifest and ignores query strings', () => {
    expect(validateSceneUrl('https://cdn.test/lod-meta.json?v=2')).toEqual({
      url: 'https://cdn.test/lod-meta.json?v=2',
    });
  });

  it('rejects an empty value, a non-URL, a non-http scheme and a wrong extension', () => {
    expect(validateSceneUrl('   ')).toHaveProperty('error');
    expect(validateSceneUrl('cdn.test/scene.sog')).toHaveProperty('error');
    expect(validateSceneUrl('file:///C:/scene.sog')).toHaveProperty('error');
    expect(validateSceneUrl('javascript:alert(1)')).toHaveProperty('error');
    expect(validateSceneUrl('https://cdn.test/readme.txt')).toHaveProperty('error');
  });
});

describe('scene extension routing', () => {
  it('routes streamed formats away from the static loader', () => {
    expect(isStreamedScene('https://cdn.test/scene.lcc2')).toBe(true);
    expect(isStreamedScene('https://cdn.test/scene.rad')).toBe(true);
    expect(isStreamedScene('scene.sog')).toBe(false);
  });

  it('accepts .rad as both a single file and a streamed scene', () => {
    expect(isSupportedSplatFile('capture.RAD')).toBe(true);
    expect(isStreamedScene('capture.RAD')).toBe(true);
  });

  it('ignores a query string when reading the extension', () => {
    expect(isSupportedSplatFile('https://cdn.test/scene.ply?token=abc')).toBe(true);
  });
});

/** A `webkitdirectory` pick, in the shape the browser hands one over. */
function pickedFile(relativePath: string): File {
  const name = relativePath.split('/').pop() ?? relativePath;
  return { name, webkitRelativePath: relativePath } as unknown as File;
}

describe('filesFromDirectoryInput', () => {
  it('strips the chosen root folder and returns it as the scene name', () => {
    const picked = filesFromDirectoryInput([
      pickedFile('capture/meta.json'),
      pickedFile('capture/data.bin'),
      pickedFile('capture/tiles/0/0.bin'),
    ]);
    expect(picked?.name).toBe('capture');
    // The keys must match what a dropped folder produces: no root prefix.
    expect([...(picked?.files.keys() ?? [])]).toEqual(['meta.json', 'data.bin', 'tiles/0/0.bin']);
  });

  it('returns null for an empty pick', () => {
    expect(filesFromDirectoryInput([])).toBeNull();
  });

  it('keeps a file the browser reports no relative path for at the root', () => {
    const picked = filesFromDirectoryInput([{ name: 'lone.sog' } as unknown as File]);
    expect([...(picked?.files.keys() ?? [])]).toEqual(['lone.sog']);
  });
});
