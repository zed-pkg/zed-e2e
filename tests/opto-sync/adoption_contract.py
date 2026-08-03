#!/usr/bin/env python3
"""Validate the cross-repository Opto-Sync adoption contract.

The fast mode validates the E2E profile without network access.  The live mode
is intentionally fail-closed: it requires a real wrapper checkout, a resolved
lock entry, and the installed native targets produced by `zed install --frozen`.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import tomllib
from typing import Any

REQUIRED_SCENARIOS = {
    "frozen-install-provenance",
    "offline-restart",
    "optimistic-local-view-rebase",
    "remote-confirmed-write",
    "idempotent-replay",
    "conflict-and-tombstone",
    "indexeddb",
    "sqlite",
    "postgres-supabase",
    "background-handoff",
}

TARGET_MANIFESTS = {
    "rust": "Cargo.toml",
    "typescript": "package.json",
    "dart": "pubspec.yaml",
    "gleam": "gleam.toml",
}


def load_json(path: pathlib.Path) -> dict[str, Any]:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise AssertionError(f"{path} must contain a JSON object")
    return value


def dependency_names(manifest_path: pathlib.Path) -> set[str]:
    manifest = tomllib.loads(manifest_path.read_text())
    names: set[str] = set()
    for section in ("dependencies", "build-dependencies", "dev-dependencies"):
        names.update(manifest.get(section, {}).keys())
    return names


def validate_profile(profile: dict[str, Any]) -> None:
    assert profile["schemaVersion"] == 1
    assert profile["rolloutIssue"] == "DEN-1386"
    assert profile["parentIssue"] == "DEN-313"
    assert set(profile["releaseGates"]) == {"DEN-309", "DEN-363"}
    assert profile["dependency"] == {
        "package": "opto-sync/opto-sync-clients",
        "range": "^0.2.0",
        "installRoot": "zed_modules/opto-sync/opto-sync-clients",
    }
    assert REQUIRED_SCENARIOS <= set(profile["requiredScenarios"])
    assert profile["wrapperRepository"]
    assert profile["wrapperRef"]
    assert profile["e2eRepository"]
    assert profile["nativeAdapters"]

    for language, relative_path in profile["nativeAdapters"].items():
        assert language in TARGET_MANIFESTS
        parts = pathlib.PurePosixPath(relative_path).parts
        assert ".." not in parts
        assert relative_path.startswith(profile["dependency"]["installRoot"] + "/")

    if profile.get("legacyParityRequired"):
        assert profile.get("legacySourcePins"), "legacy parity requires exact source-pin paths"


def validate_wrapper(profile: dict[str, Any], wrapper: pathlib.Path, live: bool) -> None:
    manifest = tomllib.loads((wrapper / ".zpkg.toml").read_text())
    lock = tomllib.loads((wrapper / ".zpkg.lock").read_text())
    adapter = load_json(wrapper / "opto-sync-adapter.json")

    assert manifest["dependencies"]["opto-sync/opto-sync-clients"] == "^0.2.0"
    assert manifest["install"]["dir"] == "zed_modules"
    assert adapter["repository"] == profile["wrapperRepository"]
    assert adapter["e2eRepository"] == profile["e2eRepository"]
    assert adapter["dependency"] == profile["dependency"]

    packages = lock.get("package", [])
    if not live:
        if adapter["releaseState"] == "blocked-until-certified-package-published":
            assert lock.get("version") == 1 and packages == []
        return

    package = next(
        item
        for item in packages
        if item.get("org") == "opto-sync" and item.get("name") == "opto-sync-clients"
    )
    assert re.fullmatch(r"[0-9a-f]{64}", package["sha256"])
    assert isinstance(package["size"], int) and package["size"] > 0
    assert package["format"]
    assert package["vcs_tag"]
    assert re.fullmatch(r"[0-9a-f]{40}", package["vcs_commit"])
    assert package["source"]

    for language, relative_path in profile["nativeAdapters"].items():
        target = wrapper / relative_path / TARGET_MANIFESTS[language]
        assert target.is_file(), f"missing installed {language} adapter: {target}"

    if profile.get("legacyParityRequired"):
        for label, relative_path in profile["legacySourcePins"].items():
            target = wrapper / relative_path
            assert target.exists(), f"missing legacy parity source {label}: {target}"


def validate_bootstrap(
    profile: dict[str, Any],
    zed_cli: pathlib.Path | None,
    zed_interfaces: pathlib.Path | None,
) -> None:
    if not profile.get("bootstrapIndependent"):
        return
    assert zed_cli is not None and zed_interfaces is not None
    for manifest_path in (zed_cli / "Cargo.toml", zed_interfaces / "Cargo.toml"):
        forbidden = {
            name
            for name in dependency_names(manifest_path)
            if "opto" in name.lower() or name == "zed-sync"
        }
        assert not forbidden, f"{manifest_path} has forbidden bootstrap deps: {sorted(forbidden)}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", type=pathlib.Path, default=pathlib.Path("opto-sync-adoption.json"))
    parser.add_argument("--wrapper", type=pathlib.Path)
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--zed-cli", type=pathlib.Path)
    parser.add_argument("--zed-interfaces", type=pathlib.Path)
    args = parser.parse_args()

    profile = load_json(args.profile)
    validate_profile(profile)
    if args.wrapper is not None:
        validate_wrapper(profile, args.wrapper, args.live)
    validate_bootstrap(profile, args.zed_cli, args.zed_interfaces)
    print(f"validated Opto-Sync adoption contract for {profile['e2eRepository']}")


if __name__ == "__main__":
    main()
