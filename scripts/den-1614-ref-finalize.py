#!/usr/bin/env python3
"""Finalize the Windows E2E ref from its last reviewed branch commit."""

from pathlib import Path

suite = Path("tests/cli/zed_develop_windows_clean_room.py")
text = suite.read_text(encoding="utf-8")
old_path_key = '''def path_key(path: Path) -> str:
    return os.path.normcase(os.path.normpath(os.fspath(path.resolve())))
'''
new_path_key = '''def path_key(path: Path) -> str:
    text = os.path.normpath(os.fspath(path.resolve()))
    if text.startswith("\\\\?\\UNC\\"):
        text = "\\\\" + text[8:]
    elif text.startswith("\\\\?\\"):
        text = text[4:]
    return os.path.normcase(text)
'''
if text.count(old_path_key) != 1:
    raise SystemExit("expected exactly one Windows path-key implementation")
suite.write_text(text.replace(old_path_key, new_path_key, 1), encoding="utf-8")

workflow = Path(".github/workflows/zed-develop-windows-clean-room.yml")
text = workflow.read_text(encoding="utf-8")
old_pin = "  ZED_CLI_SHA: 676163e80c2154aa973fd2528471f3c3dfd3ee61\n"
new_pin = "  ZED_CLI_SHA: f28abbd462195628f05e919fd6431963a320340e\n"
if text.count(old_pin) != 1:
    raise SystemExit("expected exactly one prior Windows CLI candidate pin")
workflow.write_text(text.replace(old_pin, new_pin, 1), encoding="utf-8")

Path("scripts/den-1614-ref-finalize.py").unlink()
Path(".github/workflows/den-1614-ref-finalize.yml").unlink()
