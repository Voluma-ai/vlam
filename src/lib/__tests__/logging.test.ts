import { afterEach, describe, expect, it, vi } from 'vitest';
import { logError, setVlamLogHandler, warn, type VlamLogLevel } from '../logging';

afterEach(() => setVlamLogHandler());

describe('library log handler', () => {
  it('routes warnings and errors to an installed handler, prefixed with vlam:', () => {
    const seen: [VlamLogLevel, string, unknown[]][] = [];
    setVlamLogHandler((level, message, ...details) => seen.push([level, message, details]));
    warn('something is off', 1);
    logError('worse');
    expect(seen).toEqual([
      ['warn', 'vlam: something is off', [1]],
      ['error', 'vlam: worse', []],
    ]);
  });

  it('null silences the library completely', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setVlamLogHandler(null);
    warn('dropped');
    logError('dropped');
    expect(spy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    spy.mockRestore();
    errorSpy.mockRestore();
  });

  it('defaults to the console, and restores it when called with no argument', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setVlamLogHandler(null);
    setVlamLogHandler();
    warn('back on');
    expect(spy).toHaveBeenCalledWith('vlam: back on');
    spy.mockRestore();
  });
});
