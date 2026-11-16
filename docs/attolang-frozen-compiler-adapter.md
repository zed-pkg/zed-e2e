# AttoLang: frozen Zed dependencies in compiler process environments

This is an **integration adapter under test**, not a native `zed run` feature or
proof of AttoLang compiler parity. Zed remains the single authority for
`.zpkg.toml`, `.zpkg.lock`, package resolution, downloads, artifact integrity,
and materialization. The compiler remains responsible for native
canonical `.atto.pkg.toml` (legacy `.ores.pkg.toml`), `+` project-root
imports, module selection and execution.

The adapter only works with a Zed CLI that implements the proposed canonical
`zed attolang paths --json` contract ([zed-cli #552](https://github.com/zed-pkg/zed-cli/pull/552),
stacked on [#543](https://github.com/zed-pkg/zed-cli/pull/543)). It should not
be mistaken for functionality available in the current released CLI.

From a project containing `.zpkg.toml`, `.zpkg.lock` and exactly one native
marker (`.atto.pkg.toml` preferred; `.ores.pkg.toml` legacy), run:

```sh
python3 suites/cli/attolang_frozen_exec.py \
  --project /path/to/atto-project --zed /path/to/zed -- \
  /path/to/your-compiler your-compiler-arguments
```

The argument sequence after `--` is passed directly to the specified compiler
program with no shell interpolation. The adapter runs, **in order**:

1. `zed validate --require-lock` (offline metadata admission).
2. `zed install --frozen` (Zed's normal locked installation and hash checks).
3. `zed attolang paths --json` (the read-only source-root projection).
4. The exact supplied compiler command with `ATTO_PATHS`, `ORES_PATHS`, and
   `ORESLANG_PATH` all set to the same Zed-provided, native-delimited path list.

It fails before compiler invocation if Zed rejects validation/frozen install,
if the index is malformed, too large, ambiguous, missing required metadata,
contains duplicate/traversing/control-character paths, refers to missing
package directories, or presents missing, ambiguous, symlinked or directory
compiler markers. It verifies the structured path list against the CLI's
serialized value rather than using shell `eval`, pipe parsing, or POSIX-only
`:` concatenation. CLI stderr is surfaced, but the JSON payload is bounded to
1 MiB. The invoked compiler's exit status is preserved.

These guards are **defense in depth**, not replacements for Zed's lock,
artifact, symlink, archive and namespace verification. The adapter doesn't
independently hash installed bytes, prove that the lock covers every transitive
node, or prevent filesystem mutation after frozen install. Those remain Zed
product/transactional guarantees requiring independent executable tests.

## Proof ceiling and remaining milestones

Run the deterministic, offline host contract tests:

```sh
python3 -m unittest discover -s tests -p 'test_attolang_frozen_exec.py' -v
```

The regression uses explicitly *fake* Zed and compiler processes only to check
admission order, JSON handling, argument/environment transmission, exit codes,
and fail-closed negative paths. Its CI status means **ADAPTER_HOST_ONLY**.

For release readiness, obtain real Zed CLI compatibility including canonical
marker admission ([zed-cli #568](https://github.com/zed-pkg/zed-cli/pull/568))
and then a
publish → isolated registry → frozen install → import compile → **guest run**
receipt for Java/GraalVM, LLVM, Wasm, Forge/Cranelift and .NET NativeAOT, each
with exact source/lock/compiler SHAs, explicit negative controls and verified
executed CI steps. Track [zed-e2e #71](https://github.com/zed-pkg/zed-e2e/issues/71)
and [AttoLang Zed readiness](https://github.com/zed-pkg/zed-docs/blob/main/docs/39-attolang-package-authority.md).
