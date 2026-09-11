#!/usr/bin/env python3
"""Validate the Zed package-script/task ownership boundary."""

from __future__ import annotations

import sys
import tomllib
from pathlib import Path
from typing import Any


def fail(message: str) -> "NoReturn":
    raise SystemExit(f"zed package task audit: {message}")


def load_toml(path: Path) -> dict[str, Any]:
    try:
        with path.open("rb") as source:
            value = tomllib.load(source)
    except (OSError, tomllib.TOMLDecodeError) as error:
        fail(f"cannot parse {path}: {error}")
    if not isinstance(value, dict):
        fail(f"TOML root must be a table: {path}")
    return value


def task_commands(tasks: dict[str, Any], name: str) -> list[str]:
    task = tasks.get(name)
    if not isinstance(task, dict):
        fail(f"zed-env.toml is missing [tasks.{name}]")
    run = task.get("run")
    if isinstance(run, str) and run:
        return [run]
    if isinstance(run, list) and run and all(isinstance(item, str) and item for item in run):
        return run
    fail(f"[tasks.{name}].run must be a non-empty string or string array")


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    manifest = load_toml(root / ".zpkg.toml")
    environment = load_toml(root / "zed-env.toml")

    scripts = manifest.get("scripts")
    if not isinstance(scripts, dict):
        fail(".zpkg.toml must contain [scripts]")
    if set(scripts) != {"test"}:
        fail(
            ".zpkg.toml [scripts] may expose only the package-level test hook; "
            f"found {sorted(scripts)}"
        )
    package_test = scripts.get("test")
    if not isinstance(package_test, str) or not package_test:
        fail(".zpkg.toml [scripts].test must be a non-empty command")

    if environment.get("schema") != 2:
        fail(f"zed-env.toml must use schema = 2, got {environment.get('schema')!r}")
    tasks = environment.get("tasks")
    if not isinstance(tasks, dict):
        fail("zed-env.toml must contain [tasks.*] entries")

    for name in ("typecheck", "harness", "test"):
        task_commands(tasks, name)

    task_test = " && ".join(task_commands(tasks, "test"))
    if package_test != task_test:
        fail(
            "package test hook and schema-2 tasks.test must remain equivalent: "
            f"{package_test!r} != {task_test!r}"
        )

    print(
        "zed package task audit passed: scripts=test, schema=2, "
        "tasks=typecheck,harness,test"
    )


if __name__ == "__main__":
    main()
