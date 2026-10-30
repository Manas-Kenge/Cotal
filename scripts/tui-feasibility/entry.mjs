import { realpathSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { renderNative } from "./renderer/probe.mjs";

const root = realpathSync(process.argv[2]);
const config = JSON.parse(readFileSync(process.argv[3], "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (manifest.name !== "cotal-ai" || manifest.version !== "0.91.0" || manifest.proofOnly !== true) {
  throw new Error("the feasibility entry requires its matching explicit proof installation");
}
let stage = "import-installed-host";
try {
  const host = await import(pathToFileURL(join(root, "dist/tui-host.mjs")).href);
  stage = "run-installed-host";
  await host.run(config, { renderNative });
} catch (error) {
  writeFileSync(config.resultFile, `${JSON.stringify({
    sourceHead: config.sourceHead, mode: config.mode, platform: process.platform, arch: process.arch,
    node: process.versions.node, bun: process.versions.bun ?? null, executable: process.execPath,
    entries: [{ id: "installed-host-bootstrap", status: "failed", stage, error: { name: error.name, message: error.message, code: error.code ?? null, stack: error.stack ?? null } }],
  }, null, 2)}\n`);
  console.error(`${stage}: ${error.message}`);
  process.exitCode = 1;
}
