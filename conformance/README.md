# Conformance

`zed-e2e` owns executable full-stack acceptance behavior for the Zed toolchain contracts under `contracts/`.

`conformance/check.sh` is the stable entrypoint consumed by Zed package lifecycles and Git hooks. It installs the locked Node dependency graph without lifecycle scripts, type-checks the harness, and runs the existing harness tests. It does not invent a second case format or replace the deeper cluster/browser workflows.

A change to `contracts/` is therefore no longer merely documented: install/build/test/pack/publish and the focused CI lane have an executable consumer that fails closed when the harness disagrees.
