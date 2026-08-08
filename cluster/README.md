# In-cluster e2e (kind + in-memory profile)

Bring the zed-pkg registry up **inside a Kubernetes cluster** (a throwaway
[kind](https://kind.sigs.k8s.io) cluster running in Docker) and test the CLI +
web UI against the cluster-hosted servers. Artifacts are stored **in memory**
(a RAM-backed `emptyDir`) instead of S3/R2, and metadata lives in an ephemeral
in-cluster Postgres — nothing external is required.

This complements `harness/stack.ts`, which runs the same servers as local
processes. Same servers, same URLs (`48080` API / `48081` web) — just hosted in
the cluster.

## Quick start

```bash
# 1. build images, create the kind cluster, deploy, wait for rollout
npm run cluster:up

# 2. test the CLI end-to-end against the cluster registry
npm run cluster:test-cli

# 3. (optional) run the FULL Playwright/Puppeteer/Selenium + CLI suite
npm run cluster:e2e

# 4. tear it all down
npm run cluster:down
```

Prereqs on PATH: `docker`, `kind`, `kubectl`, `cargo` (+ `npm` for `cluster:e2e`).

`cluster:up` rebuilds both `:dev` images from the current source checkout by
default, while retaining Docker's layer cache. For a faster repeat run after
verifying the source tree is unchanged, opt in explicitly with
`ZED_E2E_REUSE_IMAGES=1 npm run cluster:up`.

## What gets deployed (`manifests/`, namespace `zed`)

| Resource | Notes |
|---|---|
| `zed-postgres` | ephemeral Postgres (`emptyDir`), metadata only; db `zed_e2e` |
| `dd-zed-api-server` | `:dev` image, `STORAGE_BACKEND=local` on a `medium: Memory` emptyDir → **artifact blobs in RAM**, `AUTO_MIGRATE=true`, `ZED_VERIFY_TAGS=off`, NodePort `30080` |
| `dd-zed-web-server` | `:dev` image, points at the API NodePort, NodePort `30081` |

`kind.yaml` maps host `48080→30080` and `48081→30081`, so the servers are
reachable at `http://127.0.0.1:48080` (API) and `:48081` (web) — the same URLs
the local-process harness uses, which is why the existing suites run unchanged.

This is a **test profile**, deliberately not the production GitOps source of
truth. Production manifests live in each app repo's `k8s/`
(`zed-api-server.rs/k8s`, `zed-web-server.rs/k8s`) and are registered onto the
ORES cluster by `remote/argocd/apps/zed.applications.yaml`. The differences
(local images, plain Secret instead of ESO, in-memory storage, ephemeral PG,
single replica, NodePort instead of Ingress) are the test-cluster adaptations.

## GitOps (Argo CD app-of-apps)

`npm run cluster:up:argocd` additionally installs Argo CD and deploys the stack
through an app-of-apps (`argocd/`): a root Application renders the child
`zed-inmemory` Application, which syncs `cluster/manifests`. Argo CD pulls from
GitHub, so this branch of `zed-e2e` must be pushed first. Layout:

```
argocd/project.yaml                     AppProject zed-e2e
argocd/app-of-apps.yaml                 root Application -> argocd/apps/
argocd/apps/zed-inmemory.application.yaml  child Application -> ../manifests
```

## CLI smoke (`test-cli.sh`)

Mints an org-scoped token **inside the cluster** (`kubectl exec` into the API
pod, which holds `DATABASE_URL`), then drives the real publish lifecycle through
the `zed` CLI against the cluster registry: publish → duplicate-publish
rejected (immutability) → find → install (materializes `zed_modules/` +
`.zpkg.lock`) → yank (hidden from fresh resolution).

## Files

```
kind.yaml            kind cluster (port mappings 48080/48081)
manifests/           in-memory profile (kustomize): ns, postgres, api, web
argocd/              Argo CD app-of-apps (project, root, child)
build-images.sh      build :dev images from a clean, source-only context
up.sh / down.sh      lifecycle (up.sh --argocd for the GitOps path)
test-cli.sh          standalone CLI smoke (no browser deps)
e2e.sh               full existing suite against the cluster (PG port-forward)
lib.sh               shared constants/helpers
```
