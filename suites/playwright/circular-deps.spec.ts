import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runZed, createToken } from "../../harness/stack.js";
import { publishFixture } from "../../harness/fixtures.js";

// A genuine circular dependency must resolve, not hang. pkg-a <-> pkg-b depend
// on each other; pkg-b also pulls a transitive leaf pkg-c (dep-of-dep). The
// registry accepts the publishes (dependency existence is not validated at
// publish time, so the mutual pair can be created), and `zed install` must
// terminate, materialize every node once, and dedup the cycle.
test.describe("circular dependencies", () => {
  const suffix = Date.now().toString(36);
  const org = `cyc-${suffix}`;
  let token = "";

  test.beforeAll(async () => {
    token = await createToken(`e2e-cyc-${suffix}`, org);
    // Publish order is irrelevant — publish does not validate that deps exist,
    // which is what lets a mutually-dependent pair be created at all.
    await publishFixture({ org, name: "pkg-c", version: "1.0.0", description: "leaf" }, { token, allowExisting: true });
    await publishFixture(
      { org, name: "pkg-a", version: "1.0.0", description: "cycle A" },
      { token, deps: { [`${org}/pkg-b`]: "^1.0.0" }, allowExisting: true },
    );
    await publishFixture(
      { org, name: "pkg-b", version: "1.0.0", description: "cycle B" },
      { token, deps: { [`${org}/pkg-a`]: "^1.0.0", [`${org}/pkg-c`]: "^1.0.0" }, allowExisting: true },
    );
  });

  test("install resolves the a<->b cycle (+ dep-of-dep) without looping", async () => {
    const consumer = mkdtempSync(path.join(os.tmpdir(), "zed-cyc-"));
    try {
      writeFileSync(
        path.join(consumer, ".zpkg.toml"),
        `[package]\norg = "local"\nname = "consumer"\nversion = "0.0.0"\n\n` +
          `[package.repository]\nvcs = "git"\nurl = "https://github.com/local/consumer"\n\n` +
          `[dependencies]\n"${org}/pkg-a" = "^1.0.0"\n`,
      );
      // A hang on the cycle would blow the Playwright test timeout and fail here.
      const res = await runZed(["install"], { cwd: consumer });
      expect(res.code, res.stderr).toBe(0);

      // Every node of the graph materialized: the cycle (a, b) + the leaf (c).
      for (const n of ["pkg-a", "pkg-b", "pkg-c"]) {
        expect(existsSync(path.join(consumer, "zed_modules", org, n)), `${n} installed`).toBeTruthy();
      }

      // The cycle is deduped: each package pinned exactly once despite a<->b
      // referencing each other (and b referencing c).
      const lock = readFileSync(path.join(consumer, ".zpkg.lock"), "utf8");
      for (const n of ["pkg-a", "pkg-b", "pkg-c"]) {
        expect(lock.match(new RegExp(`name = "${n}"`, "g"))?.length, `${n} pinned once`).toBe(1);
      }
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  });

  test("installing the other side of the cycle resolves the same closed graph", async () => {
    // Entering the cycle from pkg-b must reach the identical {a, b, c} set.
    const consumer = mkdtempSync(path.join(os.tmpdir(), "zed-cyc2-"));
    try {
      writeFileSync(
        path.join(consumer, ".zpkg.toml"),
        `[package]\norg = "local"\nname = "consumer2"\nversion = "0.0.0"\n\n` +
          `[package.repository]\nvcs = "git"\nurl = "https://github.com/local/consumer2"\n\n` +
          `[dependencies]\n"${org}/pkg-b" = "^1.0.0"\n`,
      );
      const res = await runZed(["install"], { cwd: consumer });
      expect(res.code, res.stderr).toBe(0);
      for (const n of ["pkg-a", "pkg-b", "pkg-c"]) {
        expect(existsSync(path.join(consumer, "zed_modules", org, n)), `${n} installed`).toBeTruthy();
      }
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  });
});
