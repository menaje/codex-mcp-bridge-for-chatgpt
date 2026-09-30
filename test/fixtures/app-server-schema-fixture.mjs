import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Contract projection from Codex 0.153.3, independent of the bridge's checker.
if (process.argv.includes("generate-json-schema")) {
  const directory = process.argv[process.argv.indexOf("--out") + 1];
  const schema = JSON.parse(readFileSync(new URL("./app-server-request-contract.json", import.meta.url), "utf8"));
  if (process.env.CODEX_TEST_MISSING_METHOD) schema.oneOf = schema.oneOf.filter(
    variant => variant.properties.method.enum[0] !== process.env.CODEX_TEST_MISSING_METHOD
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "ClientRequest.json"), JSON.stringify(schema));
  mkdirSync(path.join(directory, "v2"), { recursive: true });
  writeFileSync(path.join(directory, "v2", "ConfigReadResponse.json"),
    readFileSync(new URL("./app-server-config-contract.json", import.meta.url), "utf8"));
  process.exit(0);
}
