# `prove-100` — the end-to-end proof for zed-pkg

The existing suites are broad and green. They are also, in three specific
places, green *because* they route around the claims that are hardest to keep
true. This suite exists to close those three holes and to make the closing
legible: every claim is a numbered gate, a gate either runs and passes or the
run is not a pass, and a gate that cannot run reports `SKIP` — which exits `2`,
not `0`.

## What was not being proven before

1. **VCS provenance.** Every publish in `zed-e2e` passes `--skip-vcs-checks`
   (`harness/fixtures.ts:66`, `:152`, `cli-lifecycle.spec.ts:102`,
   `cli-init-login.spec.ts:56`, `api-registry.spec.ts:151`), because the
   fixtures are temp directories rather than tagged repositories. So
   `vcs.rs::verify_publish_provenance` — the code behind "the git tag is the
   source of truth" — had no integration coverage at all. **G3.**
2. **The GitHub backing.** `forge_publish.rs`, `mirror.rs`,
   `mirrored_registry.rs` and `publisher_keys.rs` have unit tests and nothing
   else: no test anywhere runs `zed mirror`, `zed key`, or `zed oci`. The forge
   upload is best-effort inside `zed publish` — its failures print as warnings
   and are never propagated — so the mirror could have been silently broken for
   as long as it has existed. **G4, G5, G6, G7, G8.**
3. **The public edge.** Nothing published to or installed from
   `registry.zpkg.net`, and the one live-network job
   (`.github/workflows/public-edge-readiness.yml`) probes
   `registry.aws.zpkg.tech` / `hetzner.zpkg.tech` — a different domain from the
   `https://registry.zpkg.net` compiled into the shipped binary
   (`zed-interfaces/src/rust/registry.rs`). **L1–L5.**

## The gates

### Hermetic — one machine, Docker + Rust + Node

| Gate | Claim |
| --- | --- |
| G0 | Toolchain and the three sibling checkouts are present |
| G1 | The CLI builds from a locked manifest |
| G2 | The registry boots **with bearer auth enforced**, and an anonymous publish gets 401/403 |
| G3 | A publish from a real annotated tag at HEAD succeeds **without** `--skip-vcs-checks`, the tag and commit reach the version metadata, and a publish with HEAD ahead of the tag is refused |
| G4 | A publisher key generates, enrolls, and produces a signed index the registry serves |
| G5 | The publish lands `zpkg-<sha256>.tar.gz` + `zpkg-version.json` on the GitHub release, the asset's bytes hash to the digest the registry recorded, and the rolling `zpkg-index` release carries the package index |
| G6 | The registry serves `/.well-known/zpkg-mirrors.json` and the CLI can parse it |
| G7 | With the registry blackholed and the store empty, `zed install --frozen` completes from a mirror and the bytes match the lock pin |
| G8 | A mirror serving tampered bytes is **rejected** with an integrity error, not installed |
| G9 | A clean machine reproduces the closure: the frozen install does not rewrite the lockfile, and repacking the fixture reproduces the published digest |
| G10 | The database the SeaORM `migration/` crate applied on boot diffs **empty** against the declarative `schema/schema.sql`, via `dpm` |

G2 deliberately refuses to inherit `ZED_AUTH_DISABLED=1`. That flag is present in
`zed-api-server.rs/k8s/base/deployment.yaml` under a comment calling it a
"TEMPORARY bootstrap posture"; a proof run that inherited it would be proving an
unauthenticated registry, which is not the product.

### Live — the deployment as a user meets it

| Gate | Claim |
| --- | --- |
| L1 | `zpkg.net`, `registry.zpkg.net`, `cdn.zpkg.net` all resolve |
| L2 | The site, `registry.zpkg.net/healthz`, and the CDN's mirror document all answer 2xx |
| L3 | The live mirror set is well-formed, points back at the registry, and carries an **off-zone** alternate URL (a fallback inside the failure domain of the thing it backs up is not a fallback) |
| L4 | A published artifact downloads from the CDN and hashes to its pin |
| L5 | The CDN refuses PUT, DELETE, and listing |

## Running it

```bash
cd zed-e2e
npm install

# hermetic gates (G5 additionally needs the two GitHub variables)
export ZED_PKG_GITHUB_TOKEN=...            # contents:write on the fixture repo
export PROOF_FORGE_REPO=zed-pkg-test/zpkg-proof-fixture
bash suites/proof/prove-100.sh

# the public edge
bash suites/proof/prove-100.sh --live

# everything
bash suites/proof/prove-100.sh --all
```

Each run writes `receipts/<gate>.json` and a `proof-report.json` summary under
its temp root, so CI can publish the receipts as an artifact and a human can
tell a green run from a run that skipped half its gates.

## On G10 and the two migration paths

`zed-api-server.rs` carries two descriptions of one database: the declarative
`schema/schema.sql` (desired state, applied with
[`dpm`](https://github.com/declarative-migrations/declarative-postgres-migrate.rs)
in the [k8s-libs-and-shared-defs](https://github.com/ORESoftware/k8s-libs-and-shared-defs)
pg-defs style) and the imperative SeaORM `migration/` crate that runs on boot
under `AUTO_MIGRATE=true` and is, today, the authoritative applied path.

Two descriptions of one schema drift the moment nobody diffs them, and the
drift surfaces as a runtime error against whichever one production happened to
use. G10 closes that by construction: boot the stack (which migrates the
imperative way), then ask `dpm` for the diff against the declarative source and
require it to be empty.

The failure mode is the useful one. A non-empty diff is not just a red gate —
it *is* the migration, written out to `schema-drift.sql`, generated by diffing
the live database against the schema the ORM is built from. That is the
workflow to keep: the diff generates the migration; a human reviews it; nothing
destructive runs without the explicit `dpm` consent flags.

## Known gap this suite does not close

`zed oci push` publishes to an OCI registry, but no OCI kind participates in
*resolution*: `mirror.rs` / `mirrored_registry.rs` never read one, even though
`MirrorKindV1::OciRegistry` exists in the contract. Until a consumer can install
from `ghcr.io`, "GitHub Packages is a backing store" is true for publication and
not for retrieval. That is a missing feature, not a missing test, and it is
deliberately not papered over with a passing gate here.
