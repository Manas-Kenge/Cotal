import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as core from "@cotal-ai/core";
import * as workspace from "@cotal-ai/workspace";

function errorRecord(error) {
  return { name: error?.name ?? typeof error, message: error?.message ?? String(error), code: error?.code ?? null, stack: error?.stack ?? null, ...(error?.errors ? { errors: error.errors.map(errorRecord) } : {}) };
}

export async function run(config, ui) {
  const results = [];
  const record = async (id, test) => {
    const startedAt = new Date().toISOString();
    try {
      const observation = await test();
      const status = observation?.outcome === "existing-restriction" ? "unsupported" : observation?.outcome === "not-run" ? "not-applicable" : "passed";
      results.push({ id, status, startedAt, observation });
    } catch (error) {
      results.push({ id, status: "failed", startedAt, error: errorRecord(error) });
    }
  };
  const ctx = { ...config, core, workspace, case: record };
  ctx.onProtocolReady = async () => {
    await writeFile(config.whoReady, "ready");
    const deadline = Date.now() + 30_000;
    while (!existsSync(config.whoResult) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
    assert.ok(existsSync(config.whoResult), "independent observer returned its CLI result");
    const observations = JSON.parse(await readFile(config.whoResult, "utf8"));
    assert.ok(observations.every((result) => result.code === 0 && result.candidateVisible), JSON.stringify(observations));
    return { observer: "separate Node CLI process; the candidate host never executes CLI", observations };
  };
  await record("installed-core-workspace-import", async () => ({ core: typeof core.CotalEndpoint, workspace: typeof workspace.readMeshRegistry }));
  await record("installed-extension-single-registry", async () => {
    const extension = await import(pathToFileURL(config.extensionEntry).href);
    assert.equal(extension.registry, core.registry);
    assert.equal(core.registry.resolve("feasibility", "external-proof").value, config.mode);
    return { sameRegistryObject: true, registrationVisible: true, fixture: "separately imported local package with a core peer dependency; not the operator extension installer" };
  });
  await record("offline-machine-records", async () => {
    const root = join(config.scratch, "project");
    core.mkSecretDir(root);
    const ts = new Date().toISOString();
    workspace.recordMesh({ space: "offline-a", server: "nats://127.0.0.1:1", root, mode: "open", origin: "manual", ts });
    workspace.recordMesh({ space: "offline-b", server: "nats://127.0.0.1:2", root, mode: "open", origin: "manual", ts });
    workspace.recordPreparedSpace({ space: "not-started", root, ts: new Date().toISOString() });
    const meshes = workspace.readMeshRegistry();
    assert.equal(meshes.entries.length, 2);
    assert.equal(workspace.loadPreparedSpaces().length, 1);
    await writeFile(join(workspace.homeCotalDir(), "meshes", "damaged.json"), "{", { mode: 0o600 });
    try {
      const partial = workspace.readMeshRegistry();
      assert.equal(partial.entries.length, 2);
      assert.equal(partial.unusable.length, 1);
    } finally {
      await rm(join(workspace.homeCotalDir(), "meshes", "damaged.json"));
    }
    return { registered: 2, prepared: 1, damaged: 1, brokerDialRequired: false, source: "real workspace registries, deliberately unreachable broker addresses" };
  });
  await record("opentui-native-offline-frame", () => ui.renderNative());
  const { runNativeCases } = await import(pathToFileURL(join(config.repoRoot, "scripts/tui-feasibility/native.mjs")).href);
  await runNativeCases(ctx);
  await record("installed-native-provider-registry", async () => {
    assert.equal(core.registry.resolve("local-process", "manager-service").name, "manager-service");
    return { nativeManagerRegistrationVisibleToHost: true };
  });
  const { runProtocolCases } = await import(pathToFileURL(join(config.repoRoot, "scripts/tui-feasibility/protocol.mjs")).href);
  await runProtocolCases(ctx);
  const result = {
    sourceHead: config.sourceHead,
    mode: config.mode,
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    bun: process.versions.bun ?? null,
    executable: process.execPath,
    entries: results,
  };
  await writeFile(config.resultFile, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`TUI_FEASIBILITY_RESULT ${config.mode} ${results.length}`);
  process.exitCode = results.some((entry) => entry.status === "failed") ? 1 : 0;
}
