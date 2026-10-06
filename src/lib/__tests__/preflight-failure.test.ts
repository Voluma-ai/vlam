import { describe, expect, it } from 'vitest';
import { failureSummary } from '../../../scripts/preflight-failure.mjs';

describe('preflight failure summary', () => {
  it('keeps Playwright titles and the distinct error, dropping the numbered copies', () => {
    const output = `
  1) [chromium-webgpu] › browser-tests/sort-stream.spec.ts:3:3 › streaming radix permutation

    Error: expect(locator).not.toContainText()
    RangeError: SplatMesh.setSortStrategy: unsupported sortStrategy "radix"

  2) [chromium-webgpu] › browser-tests/sort-stream.spec.ts:3:3 › streaming exact permutation

    RangeError: SplatMesh.setSortStrategy: unsupported sortStrategy "exact"

  2 failed
    [chromium-webgpu] › browser-tests/sort-stream.spec.ts:3:3 › streaming radix permutation
    [chromium-webgpu] › browser-tests/sort-stream.spec.ts:3:3 › streaming exact permutation
`;
    const summary = failureSummary(output);
    expect(summary).toContain('streaming radix permutation');
    expect(summary).toContain('streaming exact permutation');
    expect(summary).toContain('unsupported sortStrategy "radix"');
    expect(summary.match(/streaming radix permutation/g)).toHaveLength(1);
  });

  it('keeps Vitest and TypeScript failures when there is no Playwright list', () => {
    const output = `
 FAIL  src/lib/__tests__/live-opacity.test.ts > live opacity > fades a slice
AssertionError: expected 0 to be 1
src/lib/unified/live-opacity.ts(12,5): error TS2322: Type 'number' is not assignable to type 'string'.
`;
    const summary = failureSummary(output);
    expect(summary).toContain('FAIL  src/lib/__tests__/live-opacity.test.ts');
    expect(summary).toContain('AssertionError: expected 0 to be 1');
    expect(summary).toContain('error TS2322');
  });

  it('falls back to the transcript tail when nothing matches', () => {
    expect(failureSummary('build failed\nexit 1\n')).toBe('build failed\nexit 1');
  });
});
