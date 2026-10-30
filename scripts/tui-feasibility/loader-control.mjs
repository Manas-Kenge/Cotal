import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const output = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), "ctfl-"));
const invoke = (file, args) => {
  const result = spawnSync(file, args, { cwd: scratch, encoding: "utf8", timeout: 30_000 });
  return { code: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, error: result.error?.message ?? null };
};
const records = [];
try {
  const disk = join(scratch, "installed");
  const dependency = join(disk, "node_modules", "@probe", "dependency");
  await mkdir(dependency, { recursive: true });
  await writeFile(join(dependency, "package.json"), JSON.stringify({ name: "@probe/dependency", type: "module", exports: { ".": { types: "./index.d.ts", import: "./index.js" } } }));
  await writeFile(join(dependency, "index.js"), "export const value = 17;\n");
  const app = join(disk, "host.mjs");
  await writeFile(app, "import { value } from '@probe/dependency'; console.log(value);\n");
  const entry = join(scratch, "entry.mjs");
  await writeFile(entry, "import { pathToFileURL } from 'node:url'; await import(pathToFileURL(process.argv[2]).href);\n");
  for (const runtime of [process.execPath, "bun"]) records.push({ kind: "direct", runtime, run: invoke(runtime, [entry, app]) });
  for (const variant of [
    { name: "default", flags: [] },
    { name: "external", flags: ["--external", "@probe/dependency"] },
    { name: "autoload", flags: ["--compile-autoload-package-json"] },
    { name: "external-autoload", flags: ["--external", "@probe/dependency", "--compile-autoload-package-json"] },
  ]) {
    const binary = join(scratch, `${variant.name}${process.platform === "win32" ? ".exe" : ""}`);
    const compile = invoke("bun", ["build", entry, "--compile", "--outfile", binary, ...variant.flags]);
    records.push({ kind: "compiled", ...variant, compile, run: compile.code === 0 ? invoke(binary, [app]) : null });
  }
  await writeFile(join(output, "loader-control.json"), `${JSON.stringify({ platform: process.platform, arch: process.arch, records }, null, 2)}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
for (const record of records) console.log(`${record.kind} ${record.name ?? record.runtime} exit=${record.run?.code} stdout=${record.run?.stdout.trim()}`);
