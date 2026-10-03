import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflows = [
  ".github/workflows/ci.yml",
  ".github/workflows/cross-browser-security.yml",
  ".github/workflows/pack-publication-boundary.yml",
];

for (const relative of workflows) {
  test(`${relative} imports a verified exact Rust authority from zed-cli`, () => {
    const workflow = readFileSync(resolve(root, relative), "utf8");

    assert.match(workflow, /zed-cli\/rust-toolchain\.toml/);
    assert.match(workflow, /\^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);
    assert.match(workflow, /rustup toolchain install "\$toolchain"/);
    assert.match(workflow, /rustup default "\$toolchain"/);
    assert.match(workflow, /rustc --version/);

    for (const moving of [
      "toolchain: stable",
      "toolchain: beta",
      "toolchain: nightly",
      "rustup default stable",
      "rustup toolchain install stable",
    ]) {
      assert.ok(!workflow.includes(moving), `${relative} contains moving Rust policy: ${moving}`);
    }
  });
}
