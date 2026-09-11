import "@typespec/json-schema";
using TypeSpec.JsonSchema;

namespace Zed.E2E;

@id("ZedToolchainContract")
model ZedToolchainContract {
  schema: "zed.e2e/toolchain-contract/v1";
  @pattern("^[0-9a-f]{40}$")
  producerRevision: string;
  @pattern("^[0-9a-f]{40}$")
  flags2envRevision: string;
  packageName: "zed-cli";
  packageVersion: string;
  packageRequirement: string;
  flagSpecsCount: 6;
  dotenvDisabled: true;
  strictUnknownOptions: true;
  publicBinCount: 3;
  privateCargoBinCount: 1;
  legacyFlagsAuthorityPresent: false;
}
