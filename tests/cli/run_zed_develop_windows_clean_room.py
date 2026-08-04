#!/usr/bin/env python3
"""Run the Windows contract with filesystem-equivalent path normalization."""

from __future__ import annotations

import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import zed_develop_windows_clean_room as contract  # noqa: E402


def path_key(path: Path) -> str:
    text = os.path.normpath(os.fspath(path.resolve()))
    if text.startswith("\\\\?\\UNC\\"):
        text = "\\\\" + text[8:]
    elif text.startswith("\\\\?\\"):
        text = text[4:]
    return os.path.normcase(text)


contract.path_key = path_key
raise SystemExit(contract.main())
