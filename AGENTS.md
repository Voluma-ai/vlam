# AGENTS.md

Pointer file for AI coding agents working on **VLAM!** (npm: `@voluma/vlam`).

## Read these first

1. [`docs/architecture.md`](docs/architecture.md), the src/ map, the
 non-negotiables (MIT-only reuse, `three` as the sole dependency, the ±3σ /
   `exp(-4.5·|q|²)` rendering math, portable compute), the hard-won domain
   gotchas, and the verification workflow.
2. [`CONTRIBUTING.md`](CONTRIBUTING.md): setup, commands, CI jobs, code
   standards, commit and pull-request conventions.
3. [`ROADMAP.md`](ROADMAP.md): the execution queue (Next → Later → Blocked).

Everything an agent needs about the codebase lives in those files; they are
kept authoritative so this one does not drift.

## Agent-specific conventions

- **Type-check is not done.** Most defects here (sorting, color space,
 orientation) compile cleanly and are only visible in pixels. An agent that
 cannot look at the rendered output must say so explicitly rather than
 reporting a change as verified.
- **Headless verification bar.** Run `npm test`, `npm run lint`,
  `npm run build`, `npm run docs:check`, and `npm run docs:samples`. Public
  JSDoc is rendered into the generated site; do not commit TypeDoc output.
- **Never commit** `node_modules/`, `dist/`, large scene captures, or internal
 strategy documents. Non-redistributable test scenes stay on local disks.
- **Do not widen the public API casually.** `src/lib/core/index.ts` is curated;
 format inspection belongs on the `@voluma/vlam/formats/*` subpaths.

Pick the top open roadmap item you can unblock, implement it end-to-end
including verification, and honk once done. 🪿
