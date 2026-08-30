# Public Zed edge readiness

The **public edge readiness** workflow performs safe, non-mutating checks against
all four cloud-specific endpoints:

- `https://registry.aws.zpkg.net/healthz`
- `https://web.aws.zpkg.net/healthz`
- `https://registry.hetzner.zpkg.net/healthz`
- `https://web.hetzner.zpkg.net/healthz`

Each probe records DNS resolution, TLS verification, and the HTTPS health result.
It uploads a small text artifact and writes the same redacted evidence to the job
summary.

Scheduled, push, and pull-request runs are report-only. Missing DNS or an
unfinished origin route is visible without turning unrelated repository changes
red. A manual run can set `enforce=true`; in that mode every endpoint must pass
all three layers.

Use this workflow only for public edge readiness. The authoritative package
publish/install/frozen-install certification remains cluster-local in
`zed-pkg/zed-infra` until the public routes are intentionally enabled.

AWS and Hetzner are expected to reach these names through different edge paths:
AWS uses its existing hostPort gateway, while Hetzner uses ingress-nginx and
cert-manager. A failure on one cloud should not be hidden by success on the
other.
