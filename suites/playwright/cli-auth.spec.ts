import { test, expect } from "@playwright/test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { runZed } from "../../harness/stack.js";

interface RequestRecord {
  method: string;
  path: string;
  authorization?: string;
  apikey?: string;
  body: Record<string, unknown>;
}

const requests: RequestRecord[] = [];
let authOrigin = "";
let exchangeSequence = 0;

function json(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const body = await bodyOf(req);
    requests.push({
      method: req.method ?? "",
      path: `${url.pathname}${url.search}`,
      authorization: req.headers.authorization,
      apikey: typeof req.headers.apikey === "string" ? req.headers.apikey : undefined,
      body,
    });
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;

    if (url.pathname === "/supabase/auth/v1/signup") {
      json(res, 200, {
        access_token: "supabase-signup-access",
        refresh_token: "supabase-signup-refresh",
        expires_in: 3600,
        user: { id: "supabase-user", email: body.email },
      });
      return;
    }
    if (url.pathname === "/supabase/auth/v1/token" && url.searchParams.get("grant_type") === "password") {
      json(res, 200, {
        access_token: "supabase-login-access",
        refresh_token: "supabase-login-refresh",
        expires_in: 3600,
        user: { id: "supabase-user", email: body.email },
      });
      return;
    }
    if (url.pathname === "/supabase/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
      json(res, 200, {
        access_token: "supabase-refreshed-access",
        refresh_token: "supabase-refreshed-refresh",
        expires_in: 3600,
        user: { id: "supabase-user", email: "person@example.com" },
      });
      return;
    }
    if (url.pathname === "/supabase/auth/v1/logout") {
      json(res, 204);
      return;
    }
    if (url.pathname === "/shared/auth/exchange") {
      exchangeSequence += 1;
      json(res, 200, {
        access_token: `shared-exchanged-access-${exchangeSequence}`,
        refresh_token: `shared-exchanged-refresh-${exchangeSequence}`,
        expires_at: expiresAt,
        refresh_expires_at: expiresAt + 86400,
        shared_user_id: "shared-user",
        provider: "supabase",
        roles: ["publisher"],
      });
      return;
    }
    if (url.pathname === "/shared/auth/login" || url.pathname === "/shared/auth/register") {
      json(res, 200, {
        access_token: "shared-direct-access",
        refresh_token: "shared-direct-refresh",
        expires_at: expiresAt,
        refresh_expires_at: expiresAt + 86400,
        shared_user_id: "shared-local-user",
        provider: "local",
        roles: ["publisher"],
      });
      return;
    }
    if (url.pathname === "/shared/auth/refresh") {
      json(res, 200, {
        access_token: "shared-refreshed-access",
        refresh_token: "shared-refreshed-refresh",
        expires_at: expiresAt,
        refresh_expires_at: expiresAt + 86400,
        shared_user_id: "shared-user",
        provider: "supabase",
        roles: ["publisher"],
      });
      return;
    }
    if (url.pathname === "/shared/auth/logout") {
      json(res, 204);
      return;
    }
    json(res, 404, { error: `unhandled mock route ${url.pathname}` });
  } catch (error) {
    json(res, 500, { error: String(error) });
  }
});

test.beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  authOrigin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

function authEnv(home: string): NodeJS.ProcessEnv {
  return {
    ZED_PKG_HOME: home,
    ZED_PKG_AUTH_URL: `${authOrigin}/shared`,
    ZED_PKG_SUPABASE_URL: `${authOrigin}/supabase`,
    ZED_PKG_SUPABASE_KEY: "public-anon-key",
    ZED_PKG_AUTH_PASSWORD: "test-password",
  };
}

async function runAuth(words: string[], home: string, extra: string[] = []) {
  return runZed([...words, ...extra], { env: authEnv(home) });
}

const loginAliases = [
  ["login"],
  ["signin"],
  ["auth", "login"],
  ["auth", "signin"],
];
const signupAliases = [
  ["signup"],
  ["register"],
  ["auth", "signup"],
  ["auth", "register"],
];
const logoutAliases = [
  ["logout"],
  ["signout"],
  ["auth", "logout"],
  ["auth", "signout"],
];

test.describe("zed CLI dual authentication", () => {
  test("all login aliases persist both authorities with private filesystem modes", async () => {
    for (const words of loginAliases) {
      const home = mkdtempSync(path.join(os.tmpdir(), "zed-auth-login-"));
      try {
        const result = await runAuth(words, home, ["--email", "person@example.com"]);
        expect(result.code, `${words.join(" ")}: ${result.stderr}`).toBe(0);
        expect(result.stdout).toContain("signed in as person@example.com");

        const authDir = path.join(home, "auth");
        const sessionFile = path.join(authDir, "sessions.toml");
        const stored = readFileSync(sessionFile, "utf8");
        expect(stored).toContain("supabase-login-access");
        expect(stored).toContain("shared-exchanged-access-");
        expect(stored).toContain("publisher");
        if (process.platform !== "win32") {
          expect(statSync(authDir).mode & 0o777).toBe(0o700);
          expect(statSync(sessionFile).mode & 0o777).toBe(0o600);
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  });

  test("all signup aliases create and exchange a Supabase session", async () => {
    for (const words of signupAliases) {
      const home = mkdtempSync(path.join(os.tmpdir(), "zed-auth-signup-"));
      try {
        const result = await runAuth(words, home, ["--email", "new@example.com"]);
        expect(result.code, `${words.join(" ")}: ${result.stderr}`).toBe(0);
        expect(result.stdout).toContain("account created; signed in as new@example.com");
        const stored = readFileSync(path.join(home, "auth", "sessions.toml"), "utf8");
        expect(stored).toContain("supabase-signup-access");
        expect(stored).toContain("shared-exchanged-access-");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  });

  test("status, token preference, and explicit refresh use both authorities", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "zed-auth-refresh-"));
    try {
      const login = await runAuth(["auth", "login"], home, ["--email", "person@example.com"]);
      expect(login.code, login.stderr).toBe(0);

      const status = await runAuth(["auth", "status"], home);
      expect(status.code, status.stderr).toBe(0);
      expect(status.stdout).toContain("supabase+shared-auth");
      expect(status.stdout).toContain("shared-auth JWT expires at");
      expect(status.stdout).toContain("Supabase JWT expires at");

      const beforeRefresh = await runAuth(["auth", "token"], home);
      expect(beforeRefresh.code, beforeRefresh.stderr).toBe(0);
      expect(beforeRefresh.stdout.trim()).toMatch(/^shared-exchanged-access-/);

      const refreshed = await runAuth(["auth", "refresh"], home);
      expect(refreshed.code, refreshed.stderr).toBe(0);
      const afterRefresh = await runAuth(["auth", "token"], home);
      expect(afterRefresh.stdout.trim()).toBe("shared-refreshed-access");

      expect(
        requests.some(
          (request) =>
            request.path === "/shared/auth/refresh" &&
            String(request.body.refresh_token).startsWith("shared-exchanged-refresh-"),
        ),
      ).toBeTruthy();
      expect(
        requests.some(
          (request) =>
            request.path === "/supabase/auth/v1/token?grant_type=refresh_token" &&
            request.body.refresh_token === "supabase-login-refresh",
        ),
      ).toBeTruthy();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("all logout aliases revoke both authorities and remove local tokens", async () => {
    for (const words of logoutAliases) {
      const home = mkdtempSync(path.join(os.tmpdir(), "zed-auth-logout-"));
      try {
        const login = await runAuth(["login"], home, ["--email", "person@example.com"]);
        expect(login.code, login.stderr).toBe(0);
        const result = await runAuth(words, home);
        expect(result.code, `${words.join(" ")}: ${result.stderr}`).toBe(0);
        expect(result.stdout).toContain("local tokens removed");

        const stored = readFileSync(path.join(home, "auth", "sessions.toml"), "utf8");
        expect(stored).not.toContain("access");
        expect(stored).not.toContain("refresh");
        const status = await runAuth(["auth", "status"], home);
        expect(status.stdout).toContain("not signed in");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
    expect(requests.some((request) => request.path === "/shared/auth/logout")).toBeTruthy();
    expect(
      requests.some(
        (request) =>
          request.path === "/supabase/auth/v1/logout" &&
          request.authorization === "Bearer supabase-login-access" &&
          request.apikey === "public-anon-key",
      ),
    ).toBeTruthy();
  });

  test("shared-auth-only registration carries the display name", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "zed-auth-shared-"));
    try {
      const result = await runAuth(
        ["auth", "register"],
        home,
        ["--email", "local@example.com", "--provider", "shared-auth", "--display-name", "Local Person"],
      );
      expect(result.code, result.stderr).toBe(0);
      const token = await runAuth(["auth", "token"], home);
      expect(token.stdout.trim()).toBe("shared-direct-access");
      expect(
        requests.some(
          (request) =>
            request.path === "/shared/auth/register" &&
            request.body.email === "local@example.com" &&
            request.body.display_name === "Local Person",
        ),
      ).toBeTruthy();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Supabase requests use only the configured public key", async () => {
    const providerRequests = requests.filter((request) => request.path.startsWith("/supabase/auth/v1/"));
    expect(providerRequests.length).toBeGreaterThan(0);
    for (const request of providerRequests) {
      expect(request.apikey).toBe("public-anon-key");
      if (request.path !== "/supabase/auth/v1/logout") {
        expect(request.authorization).toBe("Bearer public-anon-key");
      }
    }
  });
});
