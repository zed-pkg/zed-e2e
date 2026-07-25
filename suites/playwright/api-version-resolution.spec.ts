import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { API_URL, createToken } from "../../harness/stack.js";
import { publishFixture } from "../../harness/fixtures.js";

// Version-resolution correctness: `latest` is chosen by SEMVER precedence (not
// string order — 1.10.0 > 1.2.0 > 1.9.0), version metadata is complete and
// self-consistent, and the pinned download_url returns the exact bytes.
test.describe("zed-api-server version resolution + metadata", () => {
  const org = `ver-${Date.now().toString(36)}`;
  let token: string;

  test.beforeAll(async () => {
    token = await createToken(`${org}-owner`, org);
    // Publish out of semver order and with a double-digit minor to catch a
    // lexical-sort bug ("1.9.0" > "1.10.0" as strings, but 1.10.0 wins semver).
    for (const version of ["1.2.0", "1.9.0", "1.10.0"]) {
      await publishFixture({ org, name: "semver", version, description: "semver precedence fixture" }, { token, allowExisting: true });
    }
  });

  test("latest is the highest SEMVER version, not the lexicographically largest", async ({ request }) => {
    const body = await (await request.get(`${API_URL}/v1/packages/${org}/semver`)).json();
    expect(body.latest).toBe("1.10.0");
    expect(body.versions).toEqual(expect.arrayContaining(["1.2.0", "1.9.0", "1.10.0"]));
  });

  test("version metadata is complete and internally consistent", async ({ request }) => {
    const res = await request.get(`${API_URL}/v1/packages/${org}/semver/versions/1.10.0`);
    expect(res.status()).toBe(200);
    const m = await res.json();
    expect(m.org).toBe(org);
    expect(m.name).toBe("semver");
    expect(m.version).toBe("1.10.0");
    expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.size).toBeGreaterThan(0);
    expect(["tar.gz", "zip"]).toContain(m.format);
    expect(m.yanked).toBe(false);
    // download_url points at the content-addressed artifact for this sha.
    expect(m.download_url).toContain(`/v1/artifacts/${m.sha256}`);
    // published_at is a parseable ISO-8601 timestamp.
    expect(Number.isNaN(Date.parse(m.published_at))).toBe(false);
  });

  test("the pinned download_url returns bytes whose size and sha256 match the metadata", async ({ request }) => {
    const m = await (await request.get(`${API_URL}/v1/packages/${org}/semver/versions/1.10.0`)).json();
    const res = await request.get(m.download_url);
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"]).toContain("immutable");
    const body = await res.body();
    expect(body.length).toBe(m.size);
    expect(createHash("sha256").update(body).digest("hex")).toBe(m.sha256);
  });

  test("an unknown version of a known package is a clean 404 with an error code", async ({ request }) => {
    const res = await request.get(`${API_URL}/v1/packages/${org}/semver/versions/99.99.99`);
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.code).toBeTruthy();
    expect(typeof body.message).toBe("string");
  });

  test("a malformed version string does not 500", async ({ request }) => {
    const res = await request.get(`${API_URL}/v1/packages/${org}/semver/versions/not-a-version`);
    expect(res.status()).toBeLessThan(500);
  });
});
