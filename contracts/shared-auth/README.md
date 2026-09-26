# Shared Auth ↔ Zed delegation conformance

This fixture is an independent E2E peer contract. It does not mint tokens and
contains no secrets.

It freezes the cross-repository assumptions shared by:

- `shared-auth/shared-auth-server.rs` product delegation;
- `shared-auth/shared-auth-infra` product policy;
- `zed-pkg/zed-web-server.rs` browser/BFF integration;
- `zed-pkg/zed-cli` private package read delegation;
- `zed-pkg/zed-api-server.rs` delegated resource-server verification; and
- `zed-pkg/zed-infra` edge fallback capability authorization.

Authentication and product authorization remain separate. A valid Shared Auth
identity is never, by itself, permission to read an arbitrary private Zed
package or digest.
