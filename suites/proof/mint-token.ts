// Mints a publish token against the running stack, for the shell proof driver.
//   npx tsx suites/proof/mint-token.ts <name> <org>
import { createToken } from "../../harness/stack.js";

const [, , name = "proof", org = "proofco"] = process.argv;
process.stdout.write(await createToken(name, org));
