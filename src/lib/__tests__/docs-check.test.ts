import { describe, expect, it } from 'vitest';
// @ts-expect-error This Node-only checker helper is deliberately plain ESM.
import { markdownAnchors } from '../../../scripts/docs-check-anchors.mjs';

describe('markdownAnchors', () => {
  it('matches GitHub-style headings and duplicate suffixes', () => {
    expect(
      markdownAnchors(
        '# A heading!\n## A heading!\n### [`Public API`](api.md)\n<a id="stable"></a>',
      ),
    ).toEqual(new Set(['a-heading', 'a-heading-1', 'public-api', 'stable']));
  });

  it('does not treat fenced example text as a document anchor', () => {
    expect(markdownAnchors('```md\n# Not an anchor\n```\n# Real')).toEqual(new Set(['real']));
  });
});
