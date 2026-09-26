import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

type Contract = {
  schemaVersion: string;
  audience: string;
  clients: Record<string, {
    authorizedParty: string;
    scopes: string[];
    resourceClass: string;
  }>;
  requiredDelegatedClaims: string[];
  privatePackagePolicy: {
    providerJwtIsAuthorization: boolean;
    optimisticIdentityMayAuthorize: boolean;
    reconciledOrResourceAuthoritativeProofRequired: boolean;
    cliReadScopeMayWrite: boolean;
    privateResponsesSharedCacheable: boolean;
    privateArtifactCapabilityRequiresExactSha256: boolean;
  };
};

async function load(): Promise<Contract> {
  const url = new URL("../contracts/shared-auth/zed-delegation.contract.json", import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as Contract;
}

test("Shared Auth and Zed product clients remain deliberately distinct", async () => {
  const contract = await load();
  assert.equal(contract.audience, "zed-pkg");
  assert.deepEqual(contract.clients.web, {
    authorizedParty: "zpkg-web",
    scopes: ["zpkg:account"],
    resourceClass: "account",
  });
  assert.deepEqual(contract.clients.cli, {
    authorizedParty: "zpkg-cli",
    scopes: ["zpkg:packages:read"],
    resourceClass: "private-package-read",
  });
  assert.notDeepEqual(contract.clients.web.scopes, contract.clients.cli.scopes);
});

test("delegated token lineage and private-package fail-closed rules are mandatory", async () => {
  const contract = await load();
  assert.deepEqual(
    new Set(contract.requiredDelegatedClaims),
    new Set(["sub", "sid", "jti", "parent_jti", "aud", "azp", "scope", "exp"]),
  );
  assert.equal(contract.privatePackagePolicy.providerJwtIsAuthorization, false);
  assert.equal(contract.privatePackagePolicy.optimisticIdentityMayAuthorize, false);
  assert.equal(
    contract.privatePackagePolicy.reconciledOrResourceAuthoritativeProofRequired,
    true,
  );
  assert.equal(contract.privatePackagePolicy.cliReadScopeMayWrite, false);
  assert.equal(contract.privatePackagePolicy.privateResponsesSharedCacheable, false);
  assert.equal(
    contract.privatePackagePolicy.privateArtifactCapabilityRequiresExactSha256,
    true,
  );
});
