import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function errorRecord(error) {
  return {
    name: error?.name ?? typeof error,
    message: error?.message ?? String(error),
    code: error?.code ?? null,
    stack: error?.stack ?? null,
    ...(error?.cause === undefined ? {} : { cause: errorRecord(error.cause) }),
  };
}

function snapshot(root) {
  const rows = [];
  function visit(path) {
    let stat;
    try { stat = lstatSync(path); }
    catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) rows.push([path, "symlink", readlinkSync(path)]);
    else if (stat.isDirectory()) {
      rows.push([path, "directory", stat.mode]);
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    } else if (stat.isFile()) {
      rows.push([path, "file", stat.mode, stat.size, createHash("sha256").update(readFileSync(path)).digest("hex")]);
    } else rows.push([path, "other", stat.mode]);
  }
  visit(root);
  return rows;
}

export async function runNativeCases(ctx) {
  const load = (relative) => {
    const prefix = relative.startsWith("implementations/manager/") ? "implementations/manager/" : relative.startsWith("implementations/cli/") ? "implementations/cli/" : "packages/workspace/";
    const name = prefix.includes("manager") ? "manager" : prefix.includes("cli") ? "cli" : "workspace";
    return import(pathToFileURL(join(ctx.libraryRoots[name], relative.slice(prefix.length))).href);
  };
  const managerRequire = createRequire(join(ctx.libraryRoots.manager, "package.json"));
  const platform = { platform: process.platform, arch: process.arch };

  await ctx.case("native-process-identity", async () => {
    const token = ctx.workspace.defaultStartToken(process.pid);
    const identity = ctx.workspace.identityRecord(process.pid);
    assert.equal(typeof token, "string", "the current process has a real OS start token");
    assert.equal(identity.pid, process.pid);
    assert.equal(identity.token, token);
    assert.deepEqual(ctx.workspace.assertRecordIdentity(identity), { kind: "match" });
    return { ...platform, identity, mechanism: process.platform === "win32" ? "shipped creation.node through defaultStartToken" : process.platform === "linux" ? "/proc/<pid>/stat field 22" : "ps -o lstart=" };
  });

  await ctx.case("native-windows-creation-binding", async () => {
    if (process.platform !== "win32") return { ...platform, outcome: "not-run", reason: "Requires a real Windows kernel; no platform substitution was used." };
    const binding = await load("packages/workspace/dist/win32-process.js");
    const token = binding.nativeWin32CreationToken(process.pid);
    assert.match(token, /^\d{1,20}$/);
    assert.equal(ctx.workspace.defaultStartToken(process.pid), token);
    return { ...platform, outcome: "loaded", loader: "packages/workspace/dist/win32-process.js", binding: `packages/workspace/build/Release/win32-${process.arch}/creation.node`, token };
  });

  await ctx.case("native-node-pty-import", async () => {
    const modulePath = managerRequire.resolve("@lydell/node-pty");
    const pty = await import(pathToFileURL(modulePath).href);
    assert.equal(typeof pty.spawn, "function");
    return { ...platform, modulePath, outcome: "imported", spawnedSeat: false };
  });

  await ctx.case("native-manager-library-import", async () => {
    const module = await load("implementations/manager/dist/index.js");
    assert.equal(typeof module.Manager, "function");
    assert.equal(typeof module.createRuntime, "function");
    return { outcome: "imported", path: "implementations/manager/dist/index.js" };
  });

  await ctx.case("native-pty-runtime-construction", async () => {
    const module = await load("implementations/manager/dist/index.js");
    try {
      const runtime = module.createRuntime("pty", "tui-feasibility-no-seats");
      assert.equal(runtime.kind, "pty");
      return { outcome: "constructed", kind: runtime.kind, spawnedSeat: false };
    } catch (error) {
      if (!process.versions.bun || !error.message.startsWith("the pty runtime requires Node.js - the manager is running under Bun")) throw error;
      return { outcome: "existing-restriction", source: "implementations/manager/src/runtime/index.ts", error: errorRecord(error), spawnedSeat: false };
    }
  });

  await ctx.case("native-process-service-host", async () => {
    const { processServiceHost } = await load("implementations/cli/dist/lib/service-instances.js");
    try {
      const host = processServiceHost();
      assert.equal(process.platform, "linux");
      assert.match(host.machine, /^[0-9a-f]{64}$/);
      assert.match(host.boot, /^[0-9a-f-]{36}$/i);
      assert.equal(host.uid, process.getuid());
      return { ...platform, outcome: "supported", host };
    } catch (error) {
      if (process.platform === "linux" || error.code !== "UNSUPPORTED") throw error;
      return { ...platform, outcome: "existing-restriction", error: errorRecord(error) };
    }
  });

  await ctx.case("native-detached-manager-entry-guard", async () => {
    const { startManagerDetached } = await load("implementations/cli/dist/lib/manager-proc.js");
    const cwd = join(ctx.scratch, "non-cli-manager-entry");
    mkdirSync(cwd, { recursive: true });
    const home = resolve(process.env.COTAL_HOME ?? "");
    assert.ok(home.startsWith(`${resolve(ctx.scratch)}/`) || home.startsWith(`${resolve(ctx.scratch)}\\`), "COTAL_HOME is inside this probe's scratch directory");
    const before = { cwd: snapshot(cwd), home: snapshot(home) };
    const originalCwd = process.cwd();
    let observed;
    try {
      process.chdir(cwd);
      try { startManagerDetached({ space: "tui-feasibility-entry-guard" }); }
      catch (error) { observed = error; }
    } finally { process.chdir(originalCwd); }
    assert.ok(observed, "a non-CLI library entry actually refuses detached manager startup");
    assert.ok(observed.message.startsWith("refusing to re-exec this process as `cotal`:"));
    assert.deepEqual({ cwd: snapshot(cwd), home: snapshot(home) }, before, "the refusal leaves scratch cwd and COTAL_HOME unchanged");
    return { outcome: "existing-restriction", entry: process.argv[1] ?? null, error: errorRecord(observed), filesystemSnapshotsUnchanged: true, transientWritesOrChildrenObserved: false, changedCwdOnlyDuringCall: true, argvModified: false };
  });

  await ctx.case("native-direct-manager-lifecycle", async () => {
    const fixture = ctx.fixture.openManager;
    assert.ok(fixture, "the parent supplies a separate owned open-mode broker fixture");
    assert.match(fixture.servers, /^nats:\/\/127\.0\.0\.1:\d+$/);
    const { Manager } = await load("implementations/manager/dist/index.js");
    let instance;
    try {
      instance = new Manager({ space: fixture.space, servers: fixture.servers, workspaceRoot: fixture.workspaceRoot, runtime: "pty", consolePort: 0, installedExtensions: false });
    } catch (error) {
      if (!process.versions.bun || !error.message.startsWith("the pty runtime requires Node.js - the manager is running under Bun")) throw error;
      return { outcome: "existing-restriction", stage: "construction-before-start", error: errorRecord(error), directStartAttempted: false, spawnedSeat: false, cliOrchestrationExercised: false };
    }
    let observation;
    let consoleOrigin;
    let primaryError;
    try {
      await instance.start();
      observation = instance.localServiceObservation();
      assert.ok(observation?.registration?.instanceId, "the actual manager registered its native endpoint");
      assert.equal(instance.runtimeKind, "pty");
      const url = new URL(instance.consoleUrl);
      consoleOrigin = url.origin;
      assert.equal(url.hostname, "127.0.0.1");
      const token = new URLSearchParams(url.hash.slice(1)).get("t");
      assert.ok(token);
      const response = await fetch(new URL("/agents", url), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), [], "the direct manager serves its actual empty inventory");
      const denied = await fetch(new URL("/agents", url), { signal: AbortSignal.timeout(5000) });
      assert.equal(denied.status, 401, "the native endpoint still requires its console credential");
    } catch (error) {
      primaryError = error;
    } finally {
      try { await instance.stop(); }
      catch (error) { throw primaryError ? new AggregateError([primaryError, error], "manager lifecycle and cleanup failed") : error; }
    }
    if (primaryError) throw primaryError;
    await instance.stop();
    await assert.rejects(fetch(new URL("/agents", consoleOrigin), { signal: AbortSignal.timeout(2000) }), "the stopped manager closed its native HTTP listener");
    return { outcome: "started-and-stopped", registration: observation.registration, runtime: "pty", consoleOrigin, authenticatedInventoryCount: 0, anonymousStatus: 401, stoppedListenerClosed: true, stopIsIdempotent: true, spawnedSeat: false, cliOrchestrationExercised: false, authority: "fresh open-mode broker; no auth callbacks or guard bypass" };
  });

}
