import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(message);
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
async function putCreds(path, creds) {
  const temp = `${path}.new`;
  await writeFile(temp, creds, { mode: 0o600 });
  await rename(temp, path);
}

export async function createProtocolFixtures({ core, scratch, startBroker }) {
  const endpoints = [];
  const renewers = [];
  const spaces = [];
  const ttl = 6;
  try {
    for (let i = 0; i < 2; i++) {
      const space = `tui-feas-${randomUUID().slice(0, 8)}`;
      const dir = join(scratch, `protocol-${i}`);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const port = await freePort();
      const servers = `nats://127.0.0.1:${port}`;
      const auth = await core.createSpaceAuth(space);
      const config = join(dir, "server.conf");
      const store = join(dir, "js");
      await writeFile(config, core.serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: store }), { mode: 0o600 });
      await startBroker(["-c", config], store);
      await until(() => core.isReachable(servers), "broker did not become reachable");
      const provisionerCreds = await core.mintCreds(auth, core.newIdentity(), "provisioner");
      await core.setupSpaceStreams({ servers, space, creds: provisionerCreds });
      const provisioner = new core.CotalEndpoint({ space, servers, creds: provisionerCreds, card: { name: "provisioner", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: false });
      provisioner.on("error", () => {});
      endpoints.push(provisioner);
      await provisioner.start();
      const observerCreds = await core.mintCreds(auth, core.newIdentity(), "delivery");
      const observerCredsPath = join(dir, "observer.creds");
      await putCreds(observerCredsPath, observerCreds);
      const identities = [];
      for (const name of ["candidate", "sender"]) {
        const identity = core.newIdentity();
        const lifecycleUid = core.mintLifecycleUid();
        const opts = { lifecycleUid, subscribe: [], allowSubscribe: [], allowPublish: [], ...(name === "candidate" ? { expiresInSeconds: ttl } : {}) };
        const credsPath = join(dir, `${name}.creds`);
        await putCreds(credsPath, await core.provisionAgent(provisioner, auth, identity, opts));
        identities.push({ identity, opts, public: { id: identity.id, principal: core.principalKey(core.DEV_OWNER, identity.id).key, lifecycleUid, credsPath } });
      }
      const delivery = new core.CotalEndpoint({ space, servers, creds: observerCreds, card: { name: "delivery", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: true, heartbeatMs: 300, ttlMs: 1500 });
      delivery.on("error", () => {});
      endpoints.push(delivery);
      await delivery.start();
      const acl = new Map(identities.map(({ public: peer }) => [peer.principal, []]));
      await delivery.startPlane3((owner) => acl.get(owner));
      const candidate = identities[0];
      let stopped = false;
      let renewalFailure;
      let task = Promise.resolve();
      const timer = setInterval(() => {
        task = task.then(async () => {
          if (!stopped) await putCreds(candidate.public.credsPath, await core.mintCreds(auth, candidate.identity, "agent", candidate.opts));
        }).catch((error) => { renewalFailure = error; stopped = true; });
      }, 1000);
      renewers.push(async () => { stopped = true; clearInterval(timer); await task; if (renewalFailure) throw renewalFailure; });
      spaces.push({ space, servers, candidate: candidate.public, sender: identities[1].public, observerCredsPath });
    }
    return { data: { spaces, renewalTtlSeconds: ttl }, close: async () => {
      const stopped = await Promise.allSettled([...renewers.map((stop) => stop()), ...endpoints.reverse().map((endpoint) => endpoint.stop())]);
      const errors = stopped.filter((result) => result.status === "rejected").map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, "protocol fixture cleanup or credential renewal failed");
    } };
  } catch (error) {
    const stopped = await Promise.allSettled([...renewers.map((stop) => stop()), ...endpoints.reverse().map((endpoint) => endpoint.stop())]);
    const errors = stopped.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (errors.length) throw new AggregateError([error, ...errors], "protocol preparation and cleanup failed");
    throw error;
  }
}

export async function runProtocolCases({ core, fixture, case: record, onProtocolReady }) {
  const endpoints = [];
  const candidates = [];
  const senders = [];
  const observers = [];
  const received = [[], []];
  try {
    await record("protocol-connect", async () => {
      for (const [i, space] of fixture.spaces.entries()) {
        const common = { space: space.space, servers: space.servers, heartbeatMs: 300, ttlMs: 1500 };
        const observer = new core.CotalEndpoint({ ...common, creds: await readFile(space.observerCredsPath, "utf8"), card: { name: `observer-${i}`, kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: true });
        const candidate = new core.CotalEndpoint({ ...common, creds: () => readFile(space.candidate.credsPath, "utf8"), lifecycleUid: space.candidate.lifecycleUid, card: { id: space.candidate.id, name: `candidate-${i}`, kind: "endpoint" } });
        const sender = new core.CotalEndpoint({ ...common, creds: await readFile(space.sender.credsPath, "utf8"), lifecycleUid: space.sender.lifecycleUid, card: { id: space.sender.id, name: `sender-${i}`, kind: "endpoint" } });
        for (const endpoint of [observer, candidate, sender]) { endpoint.on("error", () => {}); endpoints.push(endpoint); }
        candidate.on("message", (message, delivery) => { received[i].push(message); delivery.ack(); });
        await observer.start();
        await candidate.start();
        await sender.start();
        observers.push(observer); candidates.push(candidate); senders.push(sender);
      }
      return { spaces: fixture.spaces.map((s) => s.space) };
    });
    if (candidates.length !== 2) return;
    if (onProtocolReady) await record("protocol-independent-cli-who", onProtocolReady);
    await record("protocol-presence", async () => {
      for (let i = 0; i < 2; i++) {
        const s = fixture.spaces[i];
        await until(() => observers[i].getRoster().some((p) => p.card.id === s.candidate.principal && p.lifecycleUid === s.candidate.lifecycleUid && p.status !== "offline"), `candidate ${i} absent from independent roster`);
      }
      return { observed: 2 };
    });
    async function sendAndCheck(label) {
      const bodies = fixture.spaces.map((_, i) => `${label}-${i}-${randomUUID()}`);
      for (let i = 0; i < 2; i++) await senders[i].unicast(fixture.spaces[i].candidate.principal, bodies[i]);
      for (let i = 0; i < 2; i++) await until(() => received[i].some((m) => m.parts.some((p) => p.kind === "text" && p.text === bodies[i])), `DM ${i} was not delivered`);
      await sleep(500);
      for (let i = 0; i < 2; i++) {
        const s = fixture.spaces[i];
        const msg = received[i].find((m) => m.parts.some((p) => p.kind === "text" && p.text === bodies[i]));
        assert.equal(msg.space, s.space);
        assert.equal(msg.from.id, s.sender.principal);
        assert.equal(msg.to, s.candidate.principal);
        assert.equal(received[i].some((m) => m.parts.some((p) => p.kind === "text" && p.text === bodies[1 - i])), false);
      }
      return { delivered: 2, crossSpaceReceipts: 0 };
    }
    await record("protocol-dm-isolation", () => sendAndCheck("initial"));
    await record("protocol-cross-space-auth", async () => {
      for (let i = 0; i < 2; i++) {
        const wrong = await readFile(fixture.spaces[i].candidate.credsPath, "utf8");
        const result = await core.probeConnect(fixture.spaces[1 - i].servers, { creds: wrong, timeoutMs: 3000 });
        assert.equal(result.ok, false);
        assert.equal(result.reason, "auth-required");
      }
      return { rejected: 2 };
    });
    await record("protocol-credential-renewal", async () => {
      const before = [];
      for (const candidate of candidates) before.push(await candidate.reloadCreds());
      await sleep((fixture.renewalTtlSeconds + 2) * 1000);
      for (let i = 0; i < 2; i++) {
        const after = await candidates[i].reloadCreds();
        assert.equal(after.identity, before[i].identity);
        assert.ok(after.exp > before[i].exp, "broker accepted a newer credential generation");
        assert.ok(Date.now() / 1000 > before[i].exp, "first accepted generation expired");
      }
      return sendAndCheck("renewed");
    });
  } finally {
    const stopped = await Promise.allSettled(endpoints.reverse().map((endpoint) => endpoint.stop()));
    await record("protocol-endpoint-cleanup", async () => {
      const errors = stopped.filter((result) => result.status === "rejected").map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, "candidate endpoint cleanup failed");
      return { stopped: stopped.length };
    });
  }
}
