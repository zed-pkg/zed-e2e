import { test, expect } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { API_URL, createToken, runZed } from "../../harness/stack.js";
import { publishFixture } from "../../harness/fixtures.js";

// An immutable lockfile is a deployment contract, not just a version hint:
// yanking a version must affect NEW resolution, never the artifact/digest
// already pinned by existing consumers. Drives CLI -> API -> storage -> CLI.
test("a yanked version remains reproducible from a frozen lock while fresh installs fall back", async ({ request }) => {
  const suffix = randomUUID().slice(0, 12);
  const org = `frozen-${suffix}`;
  const name = "locked-dependency";
  const token = await createToken(`frozen-${suffix}-owner`, org);
  await publishFixture({ org, name, version: "1.0.0", description: "fallback" }, { token });
  await publishFixture({ org, name, version: "1.1.0", description: "locked" }, { token });

  const versionUrl = `${API_URL}/v1/packages/${org}/${name}/versions/1.1.0`;
  const initial = await request.get(versionUrl);
  expect(initial.status()).toBe(200);
  const version = await initial.json();
  const sha = version.sha256 as string;
  expect(sha).toMatch(/^[a-f0-9]{64}$/);

  const temp = mkdtempSync(path.join(os.tmpdir(), "zed-frozen-yank-"));
  const manifest =
    `[package]\norg = "local"\nname = "frozen-consumer"\nversion = "0.0.0"\n\n` +
    `[package.repository]\nvcs = "git"\nurl = "https://github.com/local/frozen-consumer"\n\n` +
    `[dependencies]\n"${org}/${name}" = "^1.0.0"\n`;
  const makeConsumer = (child: string, lock?: string) => {
    const dir = path.join(temp, child);
    // Each consumer uses its own source tree; runZed shares the harness's
    // isolated package cache rather than touching the operator's home.
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, ".zpkg.toml"), manifest);
    if (lock !== undefined) writeFileSync(path.join(dir, ".zpkg.lock"), lock);
    return dir;
  };
  const install = async (dir: string, frozen = false) => {
    const result = await runZed(["install", ...(frozen ? ["--frozen"] : [])], {
      cwd: dir,
      env: { ZED_PKG_REGISTRY: API_URL },
    });
    expect(result.code, result.stderr).toBe(0);
    return readFileSync(path.join(dir, ".zpkg.lock"), "utf8");
  };

  let yanked = false;
  try {
    const first = makeConsumer("original");
    const locked = await install(first);
    expect(locked).toContain('version = "1.1.0"');
    expect(locked).toContain(`sha256 = "${sha}"`);

    const yank = await request.post(`${versionUrl}/yank`, {
      headers: { authorization: `Bearer ${token}` },
      data: { yanked: true },
    });
    expect(yank.status()).toBe(200);
    yanked = true;

    const afterYank = await request.get(versionUrl);
    expect(afterYank.status()).toBe(200);
    expect((await afterYank.json()).yanked).toBe(true);
    const artifact = await request.get(`${API_URL}/v1/artifacts/${sha}`);
    expect(artifact.status()).toBe(200);
    const bytes = await artifact.body();
    expect(bytes.byteLength).toBe(version.size);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha);

    // A separate checkout with NO zed_modules replays the original lock.
    const replay = makeConsumer("replay", locked);
    const replayed = await install(replay, true);
    expect(replayed).toBe(locked);
    expect(existsSync(path.join(replay, "zed_modules", org, name))).toBe(true);

    // A fresh unpinned consumer must NOT receive the yanked higher version.
    const fresh = await install(makeConsumer("fresh"));
    expect(fresh).toContain('version = "1.0.0"');
    expect(fresh).not.toContain('version = "1.1.0"');

    const restore = await request.post(`${versionUrl}/yank`, {
      headers: { authorization: `Bearer ${token}` },
      data: { yanked: false },
    });
    expect(restore.status()).toBe(200);
    yanked = false;
    const restored = await install(makeConsumer("restored"));
    expect(restored).toContain('version = "1.1.0"');
    expect(restored).toContain(`sha256 = "${sha}"`);
  } finally {
    if (yanked) {
      // Do not leave a test org pointing at a yanked version when assertions fail.
      await request.post(`${versionUrl}/yank`, {
        headers: { authorization: `Bearer ${token}` },
        data: { yanked: false },
      }).catch(() => {});
    }
    rmSync(temp, { recursive: true, force: true });
  }
});
