# zed-pkg-test GitHub fallback contract

This cross-repository acceptance test runs the exact pinned registry Worker from
`zed-pkg/zed-infra` against immutable public fixtures maintained in
`zed-pkg-test/zed-pkg-e2e`.

The Worker origin is deliberately set to an unreachable loopback port. No live
Rust service is stopped or contacted. The test requires:

- two independently sized GitHub Release archives and sidecars to match their
  pinned SHA-256 and compressed byte counts;
- version and package metadata to be reconstructed from anonymous GitHub data;
- `HEAD` to preserve the fallback provenance while returning no body;
- `/healthz` to remain available but explicitly report degraded operation;
- writes to fail closed with a retryable 503;
- a missing release to fail closed without a download locator; and
- account/unknown and invalid-method routes to perform zero network I/O.

All fixture and Worker repositories are checked out at immutable commit SHAs.
The workflow uploads only the sanitized JSON result.
