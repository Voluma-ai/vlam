# Security policy

VLAM! is a client-side rendering library: it runs entirely in the browser of
the application that embeds it. There are no server components, no network
services, and no credential handling in this repository.

## Threat model

In scope:

- **Parsing untrusted scene files.** The loaders accept arbitrary bytes
 (`.sog`, `.ply`, `.spz`, `.splat`, `.ksplat`, `.lcc`, `.lcc2`, `.rad`) and
 must fail safely, with a `SplatLoadError`, never a crash, hang, or
 out-of-bounds access, on malformed, truncated, or hostile input.
- Memory-exhaustion issues that a hostile scene file could trigger beyond the
 documented limits (e.g. the 2 GiB ArrayBuffer ceiling in `loading.ts`).

Out of scope:

- Vulnerabilities in the host application, browser, GPU driver, or in
  `three` itself.
- The viewer app (`src/viewer/`) and dev tooling: not part of the published
  package.

## Reporting a vulnerability

Please report suspected vulnerabilities **privately**, either through GitHub's
[private vulnerability reporting](https://github.com/Voluma-ai/vlam/security/advisories/new)
or by email to **info@voluma.ai**. Do not open a public issue or pull
request. Include the affected version, a description, and if possible a minimal
reproducing scene file.

This is a small open-source project: we handle reports on a best-effort
basis and will acknowledge, investigate, and credit valid reports, but we
cannot commit to fixed response times and do not run a bug bounty program.
