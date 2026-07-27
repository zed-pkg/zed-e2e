# Live opto-sync certification on Zed Cloud

There are two deliberately separate certification layers.

## Blocking cluster certification

`zed-pkg/zed-infra` deploys and certifies the registry independently on the AWS
and Hetzner Kubernetes clusters. Each protected cloud job opens a
`kubectl port-forward` to the live `dd-zed-api-server` Service and performs the
complete package transaction without depending on public DNS:

1. publish `opto-sync/syncer@0.2.1`;
2. publish `opto-sync/opto-sync-clients@0.2.0`;
3. publish `opto-sync/opto-sync-e2e@0.1.0`;
4. install only the top-level E2E dependency into a blank consumer;
5. prove all three packages materialize under `zed_modules/opto-sync/`;
6. remove the complete module tree and Zed download store;
7. repeat with `zed install --frozen` and require an identical lockfile.

That is the blocking proof that the image, migrations, pgvector metadata,
memory-backed artifact store, dependency resolver, archive download, and frozen
lock behavior work inside each real cluster.

## Manual public-edge canary

The `live opto-sync zed cloud` workflow in this repository retains the same
publish/install/frozen-install transaction for the intended public registries:

- `https://registry.aws.zpkg.tech`
- `https://registry.hetzner.zpkg.tech`

It is manual-only until Cloudflare records and the cloud-specific edge routes are
complete. AWS uses the existing hostPort gateway and does not have the nginx
IngressClass/cert-manager path used by Hetzner, so the two public edges must not
be treated as identical deployment targets.

## Immutable package graph

The certification pins the exact source revisions that produced the fixed
versions. The CLI accepts a retry only when the existing artifact has the
identical SHA; a same-version artifact with different bytes remains a hard
failure.

The current cloud deployment is deliberately disposable. Each cluster runs one
registry API replica with artifacts stored in a bounded 512 MiB memory-backed
`emptyDir`; package metadata uses a pinned pgvector/PostgreSQL 16 deployment on
a separate bounded 512 MiB memory-backed `emptyDir`. The two volatile tiers are
reset together before certification so metadata can never point at artifacts
that were erased by an API restart.

Durable PostgreSQL and R2/S3 are the next production-storage step.
