# Contributing to VLAM!

Thanks for your interest in **VLAM!**, an open-source (MIT), WebGPU-first
renderer for 3D Gaussian Splatting, built on three.js `WebGPURenderer` + TSL.

This is the human-facing summary. [`docs/architecture.md`](docs/architecture.md)
holds the full, hard-won engineering guidance (architecture tour, domain
gotchas, verification workflow), read it before a non-trivial change. By participating you agree to
our [Code of Conduct](CODE_OF_CONDUCT.md).

> **Where things go.** Bugs and feature requests belong on the
> [issue tracker](https://github.com/Voluma-ai/vlam/issues); changes arrive as
> [pull requests](https://github.com/Voluma-ai/vlam/pulls). Security reports are
> the exception, report those privately, never as a public issue or PR
> ([SECURITY.md](SECURITY.md)).

## Getting set up

```bash
npm install        # also registers the lint pre-commit hook
npm run dev        # Docs site → http://localhost:5170 (viewer at /demo/)
npm test           # Vitest unit tests
npm run typecheck  # tsc --noEmit
npm run lint       # ESLint + Prettier check
npm run format     # rewrite with Prettier
npm run docs:check # roadmap/changelog/link consistency (non-mutating)
npm run docs:api   # generate a local TypeDoc reference in .tmp/api-reference/
npm run docs:samples # type-check the guide code samples in docs/guide/samples/
npm run build      # docs site + library
npm run build:lib  # the published package: bundle + .d.ts into dist/ (what prepack runs)
npm run size:check # gzip-size budget for dist/index.js (scripts/check-bundle-size.mjs)
npm run test:coverage # Vitest with V8 coverage (text + cobertura, what CI runs)
```

## Continuous integration (GitHub Actions)

Workflow: [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

Required jobs (each independently visible; any failure blocks the run):

| Job | Command |
| --- | --- |
| `lint` | `npm run lint` |
| `typecheck` | `npm run typecheck` |
| `test` | `npm run test:coverage` (summary in the job log, not stored) |
| `docs` | `npm run docs:check` + `npm run docs:samples` |
| `secrets` | `gitleaks detect --no-git` against [`.gitleaks.toml`](.gitleaks.toml) |
| `build` | `npm run build` + gzip budget for `dist/index.js` |

A green local run of those commands means a green CI. Runs happen on pull
requests and pushes to `main`. Public API docs are generated from JSDoc while
building the site, so review `npm run docs:api` output but do not commit it.

Releases are cut by pushing a `v*` tag, which triggers
[`.github/workflows/release.yml`](.github/workflows/release.yml), it re-runs
the gates, checks the tag against `package.json`, and publishes to npm.

The docs/demo site deploys to [https://vlam.voluma.ai](https://vlam.voluma.ai)
from [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) on pushes
to `main`, when a GitHub Release is published, and via **Actions → Deploy →
Run workflow**. It uses repository secrets `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` (Workers:Edit token). Local equivalent: `npm run deploy`.

**Guide samples are compiled.** Every multi-line code block in
`docs/guide/*.md` exists as a real TypeScript file under
`docs/guide/samples/`, type-checked by `npm run docs:samples` against the
current source (the `@voluma/vlam` import name is path-mapped to `src/lib`, so
samples read exactly like embedder code). To change a guide snippet, edit
the sample file first, verify with `npm run docs:samples`, then paste the
relevant lines into the markdown, a `<!-- full file: … -->` comment under a
fence marks where boilerplate imports were trimmed.

## Issue & pull-request templates

Templates live under [`.github/`](.github/):

- Issues: [Bug report](.github/ISSUE_TEMPLATE/bug_report.md), [Feature request](.github/ISSUE_TEMPLATE/feature_request.md)
- Pull requests: [default template](.github/PULL_REQUEST_TEMPLATE.md)

Bug reports should include browser/OS, GPU/adapter, backend, dataset format and
approximate splat count, reproduction steps, expected vs actual, and console
output. Pull requests should name the roadmap item, tests run, manual/device
validation, docs/changelog updates, and compatibility impact.

## Root-level GPU harnesses

[`chunk-harness.html`](chunk-harness.html) and
[`unified-harness.html`](unified-harness.html) are standalone browser pages for
poking at one subsystem in isolation, chunked streaming upload and the unified
renderer's work buffer respectively. They are served by `npm run dev` at
`/chunk-harness.html` and `/unified-harness.html`, are not part of the docs
site chrome, and are not published. Reach for them when a change needs a smaller
surface than the full viewer.

## Ground rules (the non-negotiables)

- **License hygiene is load-bearing.** MIT project: reuse code only from
  MIT/Apache-2.0 sources, with attribution in the README. **Never copy code
  from `graphdeco-inria` repos** (the 3DGS reference), the paper math is free,
  their code is not licensed for commercial use.
- **Minimal dependencies.** The published library depends on exactly one
  package: `three` (a peer dependency). Demo-only deps (e.g.
  `camera-controls`) stay in `devDependencies` and must never be imported from
  `src/lib/`.
- **Don't regress the rendering math.** Quads extend to ±3σ with an
  `exp(-4.5·|q|²)` fragment falloff (the reference-correct mapping). Any change
 to projection, falloff, or blending needs side-by-side visual verification
 against SuperSplat or another reference viewer.
- **Type-check ≠ done.** Sorting and color-space bugs pass `tsc`. The demo
 loads a default scene on start; verify with a small scene *and* the largest
 one you have, and look at the pixels.

## Code standards

- TypeScript strict mode with `noUncheckedIndexedAccess`. No `any`; isolate any
 library-typing gap behind one commented cast.
- Files kebab-case, classes PascalCase, functions/variables camelCase.
- Comments explain **why** and state constraints the code cannot show; JSDoc on
 every exported symbol. No "what the next line does" comments.
- Small, single-purpose modules; match the style of neighboring code.

## Tests & verification

- `npm test` must pass. Add or update unit tests for logic changes
 (`src/lib/__tests__/`, Vitest, Node environment, no browser, no real GPU).
- GPU-facing code is tested against minimal mock renderers: object literals
 with `vi.fn()` stubs cast `as unknown as THREE.WebGPURenderer` (see
  `compute-sorter.test.ts` for the pattern). Some tests reach private members
  by name through `as unknown as` casts, keep those members as instance
  members (list in [`docs/architecture.md`](docs/architecture.md)).
- `npm run build` (type-check + bundle) must pass.
- For renderer changes, follow the visual verification workflow in
  [`docs/architecture.md`](docs/architecture.md#verification-workflow), orbit
  every scene you have (the demo loads a default scene; `?scene=<path-or-url>`
  picks another, and a local scene arrives by drag & drop or the welcome
  panel's Choose file / Choose folder buttons) on WebGPU **and** the forced
  WebGL2 fallback (`?backend=webgl`). A remote `?scene=`
  only works if that host sends `Access-Control-Allow-Origin`, and streamed
  formats additionally need the `Range` header allowed and `Content-Range`
  exposed; there is no client-side workaround, so a cross-origin fetch failure
  is reported as a CORS problem (`describeLoadError` in `src/viewer/failure.ts`).
- Device-only validations: record browser, OS, GPU, backend, dataset, splat
  count, and observed result.

## Commits & pull requests

- **Conventional commits**: `feat:`, `fix:`, `perf:`, `refactor:`, `docs:`,
 `chore:`. Present tense, ≤ 72-char subject. A Husky pre-commit hook runs
 `npm run lint` (the same ESLint + Prettier check CI uses). Skip with
 `HUSKY=0 git commit` only when you have a reason.
- **One roadmap item per PR** from [`ROADMAP.md`](ROADMAP.md); update its state
 in the same PR. Keep diffs reviewable.
- **Changelog:** user-visible changes get an entry under `## [Unreleased]` in
 [`CHANGELOG.md`](CHANGELOG.md) (Keep a Changelog). Do not add a second
  `Unreleased` heading. Version headings must not contradict `package.json`.
  Public git history starts at `0.2.0`; earlier internal `0.0.x`
  versions were never tagged. Do not invent historical tags.
- **Docs move with code.** Update the relevant guide, format note, README, and
  public JSDoc in the same PR. Generated TypeDoc output is not committed.
- Never commit `node_modules/`, `dist/` (all gitignored).
  Non-redistributable test scenes stay on local disks.

## Where to find work

[`ROADMAP.md`](ROADMAP.md) is the execution queue (Next → Later →
Blocked). Capability claims: [`docs/capabilities.md`](docs/capabilities.md).
Doc index: [`docs/README.md`](docs/README.md).
Pick the top open item you can unblock, implement it end-to-end (including
verification), and open a PR. 🪿
