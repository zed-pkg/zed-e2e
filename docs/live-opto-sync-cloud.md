# Live opto-sync certification on Zed Cloud

The `live opto-sync zed cloud` workflow exercises the real public registries on
both Kubernetes clusters:

- `https://registry.aws.zpkg.tech`
- `https://registry.hetzner.zpkg.tech`

It publishes the immutable package graph in dependency order:

1. `opto-sync/syncer@0.2.1`
2. `opto-sync/opto-sync-clients@0.2.0`
3. `opto-sync/opto-sync-e2e@0.1.0`

The CLI accepts a retry only when the existing artifact has the identical SHA.
A same-version artifact with different bytes remains a hard failure.

A blank consumer declares only `opto-sync/opto-sync-e2e`. A successful
`zed install --install-mode copy` must materialize the E2E package and both
transitive dependencies under `zed_modules/opto-sync/`. The workflow then
removes the entire Zed home and module tree and repeats with
`zed install --frozen`, which re-downloads every artifact and validates each
registry SHA against the generated lockfile.

The current cloud deployment is deliberately disposable. Each cluster runs one
registry API replica with artifacts stored in a bounded memory-backed
`emptyDir`; package metadata is also in a memory-backed bootstrap Postgres.
This singleton arrangement prevents intermittent artifact misses that would
occur if separate replicas had separate pod-local stores. Durable Postgres and
R2/S3 are the next production-storage step.
