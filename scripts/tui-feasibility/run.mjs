import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, symlink, copyFile, cp, readdir, rm } from "node:fs/promises";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { teardownOnSignal, killAndAwaitExit, SMOKE_BROKER_TOKEN } from "../../packages/smoke-kit/src/index.ts";
import { createProtocolFixtures } from "./protocol.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const outputArg = process.argv.indexOf("--output");
const output = resolve(outputArg < 0 ? join(here, "results") : process.argv[outputArg + 1]);
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), `${SMOKE_BROKER_TOKEN}tui-`));
const brokers = [];
const childProcesses = new Set();
let closing = false;
let protocol;
const report = { sourceHead: spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim(), platform: process.platform, arch: process.arch, startedAt: new Date().toISOString(), runs: [], errors: [], cleanup: {} };
const errorRecord = (error) => ({ name: error?.name ?? typeof error, message: error?.message ?? String(error), code: error?.code ?? null, stack: error?.stack ?? null, ...(error?.errors ? { errors: error.errors.map(errorRecord) } : {}) });
const redact = (text) => text.replace(/([#?&]t=)[^\s&#"']+/g, "$1<redacted>").replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer <redacted>");

function recordInterrupted(force = false) {
  closing = true;
  if (!force && childProcesses.size === 0) return;
  writeFileSync(join(output, "interrupted.json"), JSON.stringify({ scratchRetained: scratch, children: [...childProcesses].map((child) => child.pid), brokers: brokers.map(({ child }) => child.pid), cleanup: "retained child handles registered with signal reaper; interrupted run is not a pass" }));
  for (const child of childProcesses) {
    try { child.kill("SIGKILL"); } catch {}
  }
}
process.once("exit", () => recordInterrupted());
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => recordInterrupted(true));

function runProcess(executable, args, options = {}) {
  if (closing) throw new Error("the proof controller has fenced new process launches");
  return new Promise((done) => {
    const child = spawn(executable, args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], ...options });
    childProcesses.add(child);
    const release = teardownOnSignal(child);
    let stdout = "", stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.once("error", (error) => { clearTimeout(timeout); release(); childProcesses.delete(child); done({ code: null, signal: null, stdout: redact(stdout), stderr: redact(stderr), error: errorRecord(error) }); });
    child.once("close", (code, signal) => { clearTimeout(timeout); release(); childProcesses.delete(child); done({ code, signal, stdout: redact(stdout), stderr: redact(stderr) }); });
  });
}

async function startBroker(args, storeDir) {
  if (closing) throw new Error("broker startup is fenced during teardown");
  const child = spawn("nats-server", args, { stdio: ["ignore", "pipe", "pipe"] });
  const spawned = new Promise((done, fail) => { child.once("spawn", done); child.once("error", fail); });
  let log = "";
  child.stdout.on("data", (chunk) => { log += chunk; });
  child.stderr.on("data", (chunk) => { log += chunk; });
  const broker = { child, release: () => {}, log: () => redact(log) };
  brokers.push(broker);
  broker.release = teardownOnSignal(child, storeDir);
  await spawned;
  return child;
}

async function freePort() {
  const server = createServer();
  await new Promise((done, fail) => server.once("error", fail).listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function linkDirectory(target, path) {
  await mkdir(dirname(path), { recursive: true });
  await symlink(realpathSync(target), path, process.platform === "win32" ? "junction" : "dir");
}

async function installLibrary(relative, destination) {
  const source = join(repoRoot, relative);
  await mkdir(destination, { recursive: true });
  await copyFile(join(source, "package.json"), join(destination, "package.json"));
  await cp(join(source, "dist"), join(destination, "dist"), { recursive: true });
  if (existsSync(join(source, "build/Release"))) await cp(join(source, "build/Release"), join(destination, "build/Release"), { recursive: true });
  for (const entry of await readdir(join(source, "node_modules"))) {
    if (entry.startsWith(".")) continue;
    if (entry.startsWith("@")) {
      for (const child of await readdir(join(source, "node_modules", entry))) {
        if (entry === "@cotal-ai") continue;
        await linkDirectory(join(source, "node_modules", entry, child), join(destination, "node_modules", entry, child));
      }
    } else await linkDirectory(join(source, "node_modules", entry), join(destination, "node_modules", entry));
  }
}

function probeEnvironment(root) {
  const env = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "TERM", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, { HOME: join(root, "home"), USERPROFILE: join(root, "home"), LOCALAPPDATA: join(root, "home", "local"), APPDATA: join(root, "home", "roaming"), COTAL_HOME: join(root, "cotal-home"), COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_PROOF_MODE: "1" });
  return env;
}

try {
  const core = await import(pathToFileURL(join(repoRoot, "packages/core/dist/index.js")).href);
  protocol = await createProtocolFixtures({ core, scratch, startBroker });
  const managerRoot = join(scratch, "manager");
  await mkdir(join(managerRoot, ".cotal"), { recursive: true, mode: 0o700 });
  const managerPort = await freePort();
  const managerServer = `nats://127.0.0.1:${managerPort}`;
  await startBroker(["-js", "-a", "127.0.0.1", "-p", String(managerPort), "-sd", join(managerRoot, "js")], join(managerRoot, "js"));
  for (let attempt = 0; attempt < 80 && !await core.isReachable(managerServer); attempt++) await new Promise((done) => setTimeout(done, 100));
  assert.ok(await core.isReachable(managerServer), "owned manager fixture broker became reachable");
  const managerSpace = `tui-manager-${randomUUID().slice(0, 8)}`;
  await core.setupSpaceStreams({ servers: managerServer, space: managerSpace });
  const fixture = { ...protocol.data, openManager: { space: managerSpace, servers: managerServer, workspaceRoot: managerRoot } };
  const installation = join(scratch, "installation", "node_modules", "cotal-ai");
  await mkdir(join(installation, "dist"), { recursive: true });
  await writeFile(join(installation, "package.json"), JSON.stringify({ name: "cotal-ai", version: "0.91.0", type: "module", proofOnly: true, dependencies: { "@cotal-ai/core": "0.91.0", "@cotal-ai/workspace": "0.91.0" } }));
  await copyFile(join(here, "host.mjs"), join(installation, "dist/tui-host.mjs"));
  const installedCore = join(installation, "node_modules/@cotal-ai/core");
  const installedWorkspace = join(installation, "node_modules/@cotal-ai/workspace");
  const libraries = {
    core: { source: "packages/core", target: installedCore },
    workspace: { source: "packages/workspace", target: installedWorkspace },
    manager: { source: "implementations/manager", target: join(installation, "node_modules/@cotal-ai/manager") },
    seat: { source: "packages/seat", target: join(installation, "node_modules/@cotal-ai/seat") },
    cli: { source: "implementations/cli", target: join(installation, "node_modules/@cotal-ai/cli") },
  };
  for (const library of Object.values(libraries)) await installLibrary(library.source, library.target);
  for (const library of Object.values(libraries)) {
    const manifest = JSON.parse(await readFile(join(library.target, "package.json"), "utf8"));
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
      if (!dependency.startsWith("@cotal-ai/")) continue;
      const target = libraries[dependency.slice("@cotal-ai/".length)];
      if (target) await linkDirectory(target.target, join(library.target, "node_modules", dependency));
    }
  }
  report.installation = { layout: "physical Cotal package files with linked locked third-party dependencies", coldNpmInstall: false };
  const binaryPackage = join(scratch, "installation", "node_modules", "@cotal-ai", `tui-${process.platform}-${process.arch}`);
  await mkdir(join(binaryPackage, "bin"), { recursive: true });
  await writeFile(join(binaryPackage, "package.json"), JSON.stringify({ name: `@cotal-ai/tui-${process.platform}-${process.arch}`, version: "0.91.0", proofOnly: true }));
  const binary = join(binaryPackage, "bin", process.platform === "win32" ? "cotal-proof.exe" : "cotal-proof");
  const compile = await runProcess("bun", ["build", join(here, "entry.mjs"), "--compile", "--outfile", binary, ...(process.platform === "linux" ? ["--define", `process.env.OPENTUI_LIBC=${JSON.stringify("glibc")}`] : [])]);
  await writeFile(join(output, "compile.log"), `${compile.stdout}\n${compile.stderr}`);
  report.compile = compile;
  if (compile.code === 0) report.compiledSha256 = createHash("sha256").update(await readFile(binary)).digest("hex");
  const modes = [{ mode: "node", executable: process.execPath, args: [...(Number(process.versions.node.split(".")[0]) >= 26 ? ["--experimental-ffi"] : []), join(here, "entry.mjs")] }, { mode: "bun", executable: "bun", args: [join(here, "entry.mjs")] }, ...(compile.code === 0 ? [{ mode: "compiled", executable: binary, args: [] }] : [])];
  for (const mode of modes) {
    const runRoot = join(scratch, mode.mode);
    await mkdir(join(runRoot, "home"), { recursive: true, mode: 0o700 });
    await mkdir(join(runRoot, "cotal-home"), { recursive: true, mode: 0o700 });
    const extensionDir = join(runRoot, "external-extension");
    await mkdir(extensionDir, { recursive: true });
    await writeFile(join(extensionDir, "package.json"), JSON.stringify({ name: "cotal-feasibility-extension", type: "module", peerDependencies: { "@cotal-ai/core": "0.91.0" } }));
    await linkDirectory(installedCore, join(extensionDir, "node_modules/@cotal-ai/core"));
    const extensionEntry = join(extensionDir, "index.mjs");
    await writeFile(extensionEntry, `import { registry } from '@cotal-ai/core'; registry.register({kind:'feasibility',name:'external-proof',value:${JSON.stringify(mode.mode)}}); export {registry};`);
    const resultFile = join(output, `${mode.mode}.json`);
    const configPath = join(runRoot, "config.json");
    const whoReady = join(runRoot, "who-ready");
    const whoResult = join(runRoot, "who-result.json");
    const env = probeEnvironment(runRoot);
    await writeFile(configPath, JSON.stringify({ mode: mode.mode, sourceHead: report.sourceHead, repoRoot, scratch: runRoot, fixture, resultFile, extensionEntry, whoReady, whoResult, libraryRoots: Object.fromEntries(Object.entries(libraries).map(([name, library]) => [name, library.target])) }), { mode: 0o600 });
    let whoTask;
    const watcher = setInterval(() => {
      if (whoTask || !existsSync(whoReady)) return;
      whoTask = (async () => {
        const observations = [];
        for (const [index, space] of fixture.spaces.entries()) {
          const observed = await runProcess(process.execPath, [join(repoRoot, "bin/dist/cotal.js"), "who", "--all", "--json", "--space", space.space, "--server", space.servers, "--creds", space.observerCredsPath], { cwd: runRoot, env });
          await writeFile(join(output, `${mode.mode}-who-${index}.log`), `${observed.stdout}\n${observed.stderr}`);
          let result;
          try { result = JSON.parse(observed.stdout); } catch { result = null; }
          observations.push({ code: observed.code, candidateVisible: result?.result?.items?.some((row) => row.id === space.candidate.principal) ?? false, outcome: result?.outcome ?? null, error: result?.error ?? observed.error ?? null });
        }
        await writeFile(whoResult, JSON.stringify(observations));
      })().catch(async (error) => { await writeFile(whoResult, JSON.stringify([{ code: null, candidateVisible: false, error: errorRecord(error) }])); });
    }, 50);
    const run = await runProcess(mode.executable, [...mode.args, installation, configPath], { cwd: runRoot, env });
    clearInterval(watcher);
    if (whoTask) await whoTask;
    await writeFile(join(output, `${mode.mode}.log`), `${run.stdout}\n${run.stderr}`);
    report.runs.push({ mode: mode.mode, process: run, result: existsSync(resultFile) ? JSON.parse(await readFile(resultFile, "utf8")) : null });
    console.log(`${mode.mode}: exit=${run.code} result=${existsSync(resultFile)}`);
  }
} catch (error) {
  report.errors.push(errorRecord(error));
} finally {
  closing = true;
  for (const child of childProcesses) await killAndAwaitExit(child);
  if (protocol) {
    try { await protocol.close(); } catch (error) { report.errors.push(errorRecord(error)); }
  }
  for (const [index, broker] of brokers.entries()) {
    await killAndAwaitExit(broker.child);
    broker.release();
    await writeFile(join(output, `broker-${index}.log`), broker.log());
  }
  report.cleanup = { launchesFenced: closing, probeChildren: childProcesses.size, brokers: brokers.map(({ child }) => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode })), allBrokerHandlesExited: brokers.every(({ child }) => child.exitCode !== null || child.signalCode !== null) };
  if (report.cleanup.allBrokerHandlesExited && childProcesses.size === 0) {
    try {
      await rm(scratch, { recursive: true, force: true });
      report.cleanup.scratchRemoved = true;
    } catch (error) {
      report.errors.push(errorRecord(error));
      report.cleanup.scratchRetained = scratch;
    }
  } else report.cleanup.scratchRetained = scratch;
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}
const failures = report.errors.length || !report.cleanup.allBrokerHandlesExited || report.cleanup.probeChildren !== 0 || report.compile?.code !== 0 || report.runs.length !== 3 || report.runs.some((run) => run.process.code !== 0 || !run.result || run.result.entries.length === 0 || run.result.entries.some((entry) => entry.status === "failed"));
console.log(`Proof report: ${join(output, "report.json")}`);
process.exitCode = failures ? 1 : report.runs.some((run) => run.result?.entries.some((entry) => entry.status === "unsupported")) ? 2 : 0;
