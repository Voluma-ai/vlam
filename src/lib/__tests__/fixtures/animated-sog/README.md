# animated-sog reference decoder (test oracle)

An unmodified copy of `js/src/core/{container,decode,dequant,half,inflate,layout,motion,planes,reader,util}.js`
from [arrival-space/animated-sog](https://github.com/arrival-space/animated-sog) at commit
`355bd0f1b31ad644be56699a8241f12facc85da8` (2026-11-20), MIT licence (see `LICENSE`).

It is test-only: `src/lib/__tests__/parse-asog.test.ts` checks VLAM's own port
(`src/lib/formats/asog/`) against it. Nothing here ships in the package. To update it, copy those
files from a newer commit, update the hash above, and rerun the spec.
