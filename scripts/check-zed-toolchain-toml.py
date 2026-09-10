#!/usr/bin/env python3
"""Validate the Zed CLI/flags-2-env contract and every tracked TOML file.

This checker is intentionally dependency-free. It treats the tagged E2E workflow,
the selected zed-cli checkout, and the selected flags-2-env checkout as one
reviewed toolchain tuple. A mismatch stops admission instead of silently testing
one parser while the CLI links another.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
import tomllib
from pathlib import Path
from typing import Any

SHA40 = re.compile(r"^[0-9a-f]{40}$")
CANONICAL_FLAGS_GIT = "https://github.com/flags-2-env/flags-2-env.git"
CANONICAL_FLAGS_CHECKOUT = "repository: flags-2-env/flags-2-env"
LEGACY_FLAGS_FRAGMENT = "github.com/oresoftware/flags-2-env"
EXPECTED_FLAG_SPECS = frozenset(
    {
        ".cli-flags.toml",
        ".dev-cli-flags.toml",
        ".fetch-cli-flags.toml",
        ".nix-interop-cli-flags.toml",
        ".task-cli-flags.toml",
        ".tool-cli-flags.toml",
    }
)


def fail(message: str) -> "NoReturn":
    raise SystemExit(f"zed toolchain TOML audit: {message}")


def git_output(root: Path, *args: str) -> str:
    try:
        return subprocess.check_output(
            ["git", "-C", str(root), *args],
            text=True,
            stderr=subprocess.STDOUT,
        ).strip()
    except subprocess.CalledProcessError as error:
        fail(f"git {' '.join(args)} failed in {root}: {error.output.strip()}")


def git_head(root: Path) -> str:
    value = git_output(root, "rev-parse", "HEAD")
    if not SHA40.fullmatch(value):
        fail(f"{root} HEAD is not an immutable 40-character SHA: {value!r}")
    return value


def tracked_toml_files(root: Path) -> list[Path]:
    try:
        raw = subprocess.check_output(
            ["git", "-C", str(root), "ls-files", "-z"],
            stderr=subprocess.STDOUT,
        )
    except subprocess.CalledProcessError as error:
        fail(f"git ls-files failed in {root}: {error.output.decode(errors='replace').strip()}")
    relative = sorted(
        Path(value.decode("utf-8"))
        for value in raw.split(b"\0")
        if value and value.decode("utf-8").endswith(".toml")
    )
    return relative


def parse_toml_tree(root: Path) -> tuple[dict[Path, Any], list[Path]]:
    parsed: dict[Path, Any] = {}
    paths = tracked_toml_files(root)
    for relative in paths:
        path = root / relative
        try:
            with path.open("rb") as source:
                value = tomllib.load(source)
        except (OSError, tomllib.TOMLDecodeError) as error:
            fail(f"invalid tracked TOML {path}: {error}")
        if not isinstance(value, dict):
            fail(f"tracked TOML root must be a table: {path}")
        parsed[relative] = value
        text = path.read_text(encoding="utf-8").lower()
        if LEGACY_FLAGS_FRAGMENT in text:
            fail(f"legacy flags-2-env repository authority remains in {path}")
    return parsed, paths


def workflow_input_default(workflow_text: str, name: str) -> str:
    lines = workflow_text.splitlines()
    marker = f"      {name}:"
    matches = [index for index, line in enumerate(lines) if line == marker]
    if len(matches) != 1:
        fail(f"expected exactly one workflow_dispatch input named {name!r}")
    for line in lines[matches[0] + 1 :]:
        if line and not line.startswith("        "):
            break
        stripped = line.strip()
        if stripped.startswith("default:"):
            value = stripped.split(":", 1)[1].strip().strip("\"'")
            if not SHA40.fullmatch(value):
                fail(f"workflow default {name} must be an immutable SHA, got {value!r}")
            return value
    fail(f"workflow input {name!r} has no immutable default")


def dependency_table(cargo: dict[str, Any]) -> dict[str, Any]:
    dependencies = cargo.get("dependencies")
    if not isinstance(dependencies, dict):
        fail("zed-cli/Cargo.toml has no [dependencies] table")
    dependency = dependencies.get("flags2env")
    if not isinstance(dependency, dict):
        fail("zed-cli/Cargo.toml must declare flags2env as a pinned git dependency table")
    return dependency


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zed-cli-root", type=Path, required=True)
    parser.add_argument("--flags-root", type=Path, required=True)
    parser.add_argument("--workflow", type=Path, required=True)
    parser.add_argument(
        "--require-default-checkouts",
        action="store_true",
        help="require the checked-out SHAs to equal workflow_dispatch defaults",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    zed_root = args.zed_cli_root.resolve(strict=True)
    flags_root = args.flags_root.resolve(strict=True)
    workflow = args.workflow.resolve(strict=True)

    zed_head = git_head(zed_root)
    flags_head = git_head(flags_root)
    zed_toml, zed_toml_paths = parse_toml_tree(zed_root)
    e2e_toml, e2e_toml_paths = parse_toml_tree(workflow.parents[2])

    cargo = zed_toml.get(Path("Cargo.toml"))
    if not isinstance(cargo, dict):
        fail("tracked zed-cli/Cargo.toml was not parsed")
    cargo_package = cargo.get("package")
    if not isinstance(cargo_package, dict):
        fail("zed-cli/Cargo.toml has no [package] table")
    cli_version = cargo_package.get("version")
    if not isinstance(cli_version, str) or not cli_version:
        fail(f"zed-cli/Cargo.toml package.version must be a non-empty string, got {cli_version!r}")

    e2e_manifest = e2e_toml.get(Path(".zpkg.toml"))
    if not isinstance(e2e_manifest, dict):
        fail("tracked zed-e2e/.zpkg.toml was not parsed")
    e2e_dependencies = e2e_manifest.get("dependencies")
    if not isinstance(e2e_dependencies, dict):
        fail("zed-e2e/.zpkg.toml has no [dependencies] table")
    expected_cli_requirement = f"^{cli_version}"
    actual_cli_requirement = e2e_dependencies.get("zed-pkg/zed-cli")
    if actual_cli_requirement != expected_cli_requirement:
        fail(
            "zed-e2e/.zpkg.toml must consume the audited zed-cli package line: "
            f"{actual_cli_requirement!r} != {expected_cli_requirement!r}"
        )

    dependency = dependency_table(cargo)
    dependency_git = dependency.get("git")
    dependency_rev = dependency.get("rev")
    if dependency_git != CANONICAL_FLAGS_GIT:
        fail(f"flags2env git authority must be {CANONICAL_FLAGS_GIT}, got {dependency_git!r}")
    if not isinstance(dependency_rev, str) or not SHA40.fullmatch(dependency_rev):
        fail(f"flags2env dependency revision is not an immutable SHA: {dependency_rev!r}")
    if dependency_rev != flags_head:
        fail(
            "selected flags-2-env checkout does not match zed-cli/Cargo.toml: "
            f"{flags_head} != {dependency_rev}"
        )

    workflow_text = workflow.read_text(encoding="utf-8")
    if CANONICAL_FLAGS_CHECKOUT not in workflow_text:
        fail("tagged workflow does not check out flags-2-env/flags-2-env")
    if "repository: ORESoftware/flags-2-env" in workflow_text:
        fail("tagged workflow still names the legacy flags-2-env repository owner")
    default_zed = workflow_input_default(workflow_text, "zed_cli_ref")
    default_flags = workflow_input_default(workflow_text, "flags_2_env_ref")

    if args.require_default_checkouts:
        if default_zed != zed_head:
            fail(f"default zed_cli_ref does not match the audited checkout: {default_zed} != {zed_head}")
        if default_flags != flags_head:
            fail(
                "default flags_2_env_ref does not match the audited checkout: "
                f"{default_flags} != {flags_head}"
            )

    root_specs = {
        path.name
        for path in zed_toml_paths
        if path.parent == Path(".")
        and (path.name == ".cli-flags.toml" or path.name.endswith("-cli-flags.toml"))
    }
    missing = sorted(EXPECTED_FLAG_SPECS - root_specs)
    if missing:
        fail(f"missing expected root CLI flag contracts: {', '.join(missing)}")

    print(
        "zed toolchain TOML audit passed: "
        f"zed={zed_head}, flags2env={flags_head}, zed_cli_requirement={actual_cli_requirement}, "
        f"zed_toml={len(zed_toml_paths)}, e2e_toml={len(e2e_toml_paths)}, "
        f"flag_specs={len(root_specs)}"
    )


if __name__ == "__main__":
    main()
