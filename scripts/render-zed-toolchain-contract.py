#!/usr/bin/env python3
"""Render the actual checked-out Zed/TOML tuple as TJSV instance evidence."""

from __future__ import annotations

import argparse
import json
import subprocess
import tomllib
from pathlib import Path


def load_toml(path: Path) -> dict:
    with path.open("rb") as source:
        value = tomllib.load(source)
    if not isinstance(value, dict):
        raise SystemExit(f"expected TOML table root: {path}")
    return value


def git_head(root: Path) -> str:
    value = subprocess.check_output(
        ["git", "-C", str(root), "rev-parse", "HEAD"], text=True
    ).strip()
    if len(value) != 40 or any(ch not in "0123456789abcdef" for ch in value):
        raise SystemExit(f"non-immutable git head: {value!r}")
    return value


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zed-cli-root", type=Path, required=True)
    parser.add_argument("--e2e-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    zed_root = args.zed_cli_root.resolve(strict=True)
    e2e_root = args.e2e_root.resolve(strict=True)
    cargo = load_toml(zed_root / "Cargo.toml")
    zpkg = load_toml(zed_root / ".zpkg.toml")
    e2e_zpkg = load_toml(e2e_root / ".zpkg.toml")

    specs = [zed_root / ".cli-flags.toml", *sorted(zed_root.glob(".*-cli-flags.toml"))]
    # .cli-flags.toml does not match the wildcard above; de-duplicate defensively.
    specs = list(dict.fromkeys(specs))
    parsed_specs = [load_toml(path) for path in specs]

    cargo_bins = {
        entry["name"]
        for entry in cargo.get("bin", [])
        if isinstance(entry, dict) and isinstance(entry.get("name"), str)
    }
    public_bins = set(zpkg.get("bin", {}))
    private_bins = cargo_bins - public_bins

    flags2env = cargo.get("dependencies", {}).get("flags2env", {})
    revision = flags2env.get("rev") if isinstance(flags2env, dict) else None
    if not isinstance(revision, str):
        raise SystemExit("Cargo.toml flags2env dependency has no immutable rev")

    contract_text = "\n".join(path.read_text(encoding="utf-8").lower() for path in specs)
    cargo_text = (zed_root / "Cargo.toml").read_text(encoding="utf-8").lower()

    evidence = {
        "schema": "zed.e2e/toolchain-contract/v1",
        "producerRevision": git_head(zed_root),
        "flags2envRevision": revision,
        "packageName": zpkg.get("package", {}).get("name"),
        "packageVersion": zpkg.get("package", {}).get("version"),
        "packageRequirement": e2e_zpkg.get("dependencies", {}).get("zed-pkg/zed-cli"),
        "flagSpecsCount": len(specs),
        "dotenvDisabled": all(
            spec.get("env", {}).get("dotenv") is False
            and spec.get("env", {}).get("files") == []
            for spec in parsed_specs
        ),
        "strictUnknownOptions": all(
            spec.get("parse", {}).get("allow_unknown") is False
            for spec in parsed_specs
        ),
        "publicBinCount": len(public_bins),
        "privateCargoBinCount": len(private_bins),
        "legacyFlagsAuthorityPresent": "github.com/oresoftware/flags-2-env" in (
            cargo_text + "\n" + contract_text
        ),
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(evidence, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(evidence, sort_keys=True))


if __name__ == "__main__":
    main()
