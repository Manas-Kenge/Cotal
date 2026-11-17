/**
 * Throwaway proof for DAV-408 step 1 (plans/agent-prompts-on-the-control-surface.md, sections 4.3,
 * 4.6, 13, 17). No product code: every credential carries the rows the shipped callout mints today,
 * plus hand-built principal-route rows. A raw responder plays the agent. Real nats-server, operator
 * mode. A leaf node is started only for the remote-interest observation.
 *
 * Run: npx tsx implementations/auth/smoke/prin-route-proof.smoke.ts
 */
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, headers, jwtAuthenticator, PermissionViolationError, type Msg, type NatsConnection } from "@nats-io/transport-node";
import { encodeAccount, encodeOperator, encodeUser, fmtCreds } from "@nats-io/jwt";
import { createAccount, createOperator, createUser } from "@nats-io/nkeys";
import { epServeGrantRows, isReachable, mintLifecycleUid, permissionsFor, spacePrefix } from "@cotal-ai/core";
import { calloutPermissions, deriveOwnerToken, USER_TOKEN_VER, type AclResolver, type ValidatedUserToken } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, createSuite, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

const { check, finish } = createSuite();
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (n = 12) => randomBytes(n).toString("hex");
async function until(done: () => boolean, ms = 2000): Promise<boolean> {
  for (const end = Date.now() + ms; !done(); await wait(20)) if (Date.now() > end) return false;
  return true;
}

const space = `prin${hex(4)}`;
const P = spacePrefix(space);
const CMDS = ["describe", "prompts", "prompt", "prompt-answer"] as const;
const HOLD_MS = 125_000;

// ---- broker ---------------------------------------------------------------------------------
const op = createOperator(), sys = createAccount(), acct = createAccount(), signer = createAccount();
const limits = { subs: -1, conn: -1, leaf: -1, imports: -1, exports: -1, data: -1, payload: -1, wildcards: true };
const sysJwt = await encodeAccount("SYS", sys, {}, { signer: op });
const acctJwt = await encodeAccount("space", acct, { limits, signing_keys: [signer.getPublicKey()] }, { signer: op });
const opJwt = await encodeOperator("prin-op", op, { system_account: sys.getPublicKey() });
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const HUB = await pickFreePort(), LEAF_LISTEN = await pickFreePort(), LEAF = await pickFreePort();
const base = (port: number) => [`port: ${port}`, "host: 127.0.0.1", `operator: ${opJwt}`, `system_account: ${sys.getPublicKey()}`,
  "max_control_line: 65536", "resolver: MEMORY", `resolver_preload: { ${sys.getPublicKey()}: ${sysJwt}, ${acct.getPublicKey()}: ${acctJwt} }`];
writeFileSync(join(dir, "hub.conf"), [...base(HUB), `leafnodes { listen: "127.0.0.1:${LEAF_LISTEN}" }`, ""].join("\n"));
const brokers: ChildProcess[] = [];
async function startBroker(conf: string, port: number): Promise<ChildProcess> {
  const child = spawn("nats-server", ["-c", join(dir, conf)], { stdio: ["ignore", "ignore", process.env.PRIN_DEBUG ? "inherit" : "ignore"] });
  teardownOnSignal(child, dir);
  brokers.push(child);
  for (let n = 0; !(await isReachable(`nats://127.0.0.1:${port}`)); n++) {
    if (n >= 50) throw new Error(`${conf} failed readiness`);
    await wait(100);
  }
  return child;
}
await startBroker("hub.conf", HUB);

// ---- principals -----------------------------------------------------------------------------
const A = deriveOwnerToken("s".repeat(32), "better-auth|alice");
const B = deriveOwnerToken("s".repeat(32), "better-auth|bob");
interface Who { name: string; owner: string; actor: string; uid: string; rt: string; kind: "interactive" | "managed-agent"; scope: string[]; view?: "admin" | "manager-caller" }
const who = (name: string, owner: string, actor: string, kind: Who["kind"], extra: Partial<Who> = {}): Who =>
  ({ name, owner, actor, kind, scope: [], uid: mintLifecycleUid(), rt: `rt_${hex(6)}`, ...extra });
const W = {
  coder: who("alice.coder", A, "coder", "managed-agent"),
  helper: who("alice.helper", A, "helper", "managed-agent"),
  web: who("alice.web", A, "web", "interactive"),
  bobWeb: who("bob.web", B, "web", "interactive"),
  builder: who("bob.builder", B, "builder", "managed-agent"),
  admin: who("bob.console(admin view)", B, "console", "interactive", { scope: ["admin"], view: "admin" }),
  mgrCaller: who("alice.ops(manager-caller view)", A, "ops", "interactive", { view: "manager-caller" }),
};
const coderNext: Who = { ...W.coder, name: "alice.coder(next lifecycle)", uid: mintLifecycleUid(), rt: `rt_${hex(6)}` };
const ledger = new Map([...Object.values(W), coderNext].map((w) => [w.uid, w]));
const resolveAcl: AclResolver = (t) => {
  const w = ledger.get(t.act.lifecycleUid!);
  if (!w) throw new Error(`no ledger row for ${t.owner}.${t.act.actor}`);
  return { allowSubscribe: [], allowPublish: [], lifecycleUid: w.uid, scope: w.scope, kind: w.kind };
};
const shippedMint = calloutPermissions(resolveAcl, async () => {});

// ---- hand-built principal-route rows (plan 4.3) ---------------------------------------------
type Rows = { pub: string[]; sub: string[] };
const replyRow = (c: Who) => `${P}.ep.prin-reply.*.*.*.*.*.${c.owner}.${c.actor}.${c.uid}.*`;
const serveRows = (w: Who): Rows => ({
  sub: [`${P}.ep.prin.agent.${w.owner}.${w.actor}.${w.uid}.*.*.*.*.*.*.*`],
  pub: [`${P}.ep.prin-reply.agent.${w.owner}.${w.actor}.${w.uid}.*.*.*.*.*`],
});
const ownerRows = (c: Who): Rows => ({ pub: CMDS.map((cmd) => `${P}.ep.prin.agent.${c.owner}.*.*.*.${cmd}.owner.${c.owner}.${c.actor}.${c.uid}.*`), sub: [replyRow(c)] });
const grantRows = (c: Who, t: Who): Rows => ({ pub: CMDS.map((cmd) => `${P}.ep.prin.agent.${t.owner}.${t.actor}.${t.uid}.*.${cmd}.grant.${c.owner}.${c.actor}.${c.uid}.*`), sub: [replyRow(c)] });
const join2 = (...rs: Rows[]): Rows => ({ pub: rs.flatMap((r) => r.pub), sub: rs.flatMap((r) => r.sub) });

interface Perm { pub?: { allow?: string[]; deny?: string[] }; sub?: { allow?: string[]; deny?: string[] }; resp?: unknown }
const withRows = (shipped: Perm, add: Rows): Perm => ({
  ...(shipped.resp === undefined ? {} : { resp: shipped.resp }),
  pub: { ...(shipped.pub ?? {}), allow: [...(shipped.pub?.allow ?? []), ...add.pub] },
  sub: { ...(shipped.sub ?? {}), allow: [...(shipped.sub?.allow ?? []), ...add.sub] },
});

// ---- connections ----------------------------------------------------------------------------
interface Seat { label: string; nc: NatsConnection; nonce: string; refused: { operation: string; subject: string }[]; perms: Perm }
const seats: Seat[] = [];
async function seatFor(label: string, perms: (nonce: string) => Promise<Perm> | Perm, port = HUB): Promise<Seat> {
  const nonce = `ibx${hex(16)}`;
  const p = await perms(nonce);
  const u = createUser();
  const jwt = await encodeUser(label, u, acct, p as never, { signer });
  const nc = await connect({ servers: `nats://127.0.0.1:${port}`, name: nonce, inboxPrefix: `_INBOX_${nonce}`, maxReconnectAttempts: 0, authenticator: jwtAuthenticator(jwt, u.getSeed()) });
  const s: Seat = { label, nc, nonce, refused: [], perms: p };
  void (async () => {
    for await (const st of nc.status())
      if (st.type === "error" && st.error instanceof PermissionViolationError) s.refused.push({ operation: st.error.operation, subject: st.error.subject });
  })().catch(() => {});
  seats.push(s);
  return s;
}
const token = (w: Who): ValidatedUserToken => ({
  owner: w.owner, space, scope: w.scope, ver: USER_TOKEN_VER, exp: Math.floor(Date.now() / 1000) + 600,
  act: { owner: w.owner, actor: w.actor, scope: w.scope, lifecycleUid: w.uid, ...(w.view ? { view: w.view } : {}), ...(w.view === "manager-caller" ? { managerInstanceId: mintLifecycleUid() } : {}) },
});
const userSeat = (w: Who, add: Rows, port = HUB) =>
  seatFor(w.name, async (nonce) => withRows((await shippedMint(token(w), nonce, `rdr${hex(8)}`)) as Perm, add), port);

const refusedNow = (s: Seat, operation: string, subject: string) => s.refused.some((r) => r.operation === operation && r.subject === subject);
async function publishRefused(s: Seat, subject: string, opts?: { reply?: string; headers?: ReturnType<typeof headers> }): Promise<boolean> {
  s.nc.publish(subject, enc("{}"), opts);
  await s.nc.flush();
  return until(() => refusedNow(s, "publish", subject));
}
async function subscribeRefused(s: Seat, subject: string): Promise<boolean> {
  s.nc.subscribe(subject, { callback: () => {} });
  await s.nc.flush().catch(() => {});
  return until(() => refusedNow(s, "subscription", subject));
}
async function subscribeAccepted(s: Seat, subject: string): Promise<boolean> {
  s.nc.subscribe(subject, { callback: () => {} });
  await s.nc.flush();
  return !(await until(() => refusedNow(s, "subscription", subject), 1000));
}

// ---- subjects (plan 4.2) --------------------------------------------------------------------
type Target = Pick<Who, "owner" | "actor" | "uid" | "rt">;
const reqSubj = (t: Target, cmd: string, authority: string, c: Who, nonce: string) =>
  `${P}.ep.prin.agent.${t.owner}.${t.actor}.${t.uid}.${t.rt}.${cmd}.${authority}.${c.owner}.${c.actor}.${c.uid}.${nonce}`;
const replySubj = (t: Target, c: Who, nonce: string) => `${P}.ep.prin-reply.agent.${t.owner}.${t.actor}.${t.uid}.${t.rt}.${c.owner}.${c.actor}.${c.uid}.${nonce}`;
const sentinel = (c: Who, nonce: string) => `${P}.ep.prin-reply._nr._nr._nr._nr._nr.${c.owner}.${c.actor}.${c.uid}.${nonce}`;

/** The agent: subscribes only its own runtime, derives the reply from the subject, never uses the transport reply. */
function serve(s: Seat, w: Who, rt: string, mode: { holdMs?: number; liar?: boolean } = {}) {
  const counts = { received: 0, replied: 0, at: [] as number[] };
  s.nc.subscribe(`${P}.ep.prin.agent.${w.owner}.${w.actor}.${w.uid}.${rt}.*.*.*.*.*.*`, {
    callback: (err, m) => {
      if (err) return;
      counts.received++;
      const t = m.subject.split(".");
      if (mode.liar) {
        const h = headers(503, "No Responders");
        s.nc.publish(`${P}.ep.prin-reply._nr._nr._nr._nr._nr.${t[11]}.${t[12]}.${t[13]}.${t[14]}`, new Uint8Array(), { headers: h });
        return;
      }
      const body = enc(JSON.stringify({ command: t[9], by: { authority: t[10], caller: `${t[11]}.${t[12]}.${t[13]}` } }));
      const send = () => { s.nc.publish(`${P}.ep.prin-reply.agent.${t[5]}.${t[6]}.${t[7]}.${t[8]}.${t[11]}.${t[12]}.${t[13]}.${t[14]}`, body); counts.replied++; counts.at.push(Date.now()); };
      if (mode.holdMs) setTimeout(send, mode.holdMs); else send();
    },
  });
  return counts;
}

type Outcome =
  | { kind: "reply"; subject: string; body: { command: string; by: { authority: string; caller: string } }; ms: number }
  | { kind: "no-responders"; subject: string; ms: number }
  | { kind: "deadline"; ms: number }
  | { kind: "refused" }
  | { kind: "stray"; subject: string };
/** The caller (plan 4.6): wildcard-head reply subscription with an exact nonce, transport reply = sentinel. */
async function call(s: Seat, c: Who, t: Target, cmd: string, authority: string, deadlineMs = 2000): Promise<Outcome> {
  const nonce = hex(10);
  const got: { m?: Msg; err?: Error }[] = [];
  const sub = s.nc.subscribe(`${P}.ep.prin-reply.*.*.*.*.*.${c.owner}.${c.actor}.${c.uid}.${nonce}`, { callback: (err, m) => got.push({ m, err: err ?? undefined }) });
  await s.nc.flush();
  const subject = reqSubj(t, cmd, authority, c, nonce);
  const start = Date.now();
  s.nc.publish(subject, enc(JSON.stringify({ op: { endpoint: "agent", command: cmd } })), { reply: sentinel(c, nonce) });
  await s.nc.flush();
  await until(() => got.length > 0 || refusedNow(s, "publish", subject), deadlineMs);
  sub.unsubscribe();
  const ms = Date.now() - start;
  if (refusedNow(s, "publish", subject)) return { kind: "refused" };
  const first = got[0];
  if (!first) return { kind: "deadline", ms };
  if (first.err) return { kind: "stray", subject: `error:${first.err.message}` };
  const m = first.m!;
  if (m.subject === sentinel(c, nonce) && m.headers?.code === 503) return { kind: "no-responders", subject: m.subject, ms };
  if (m.subject === replySubj(t, c, nonce)) return { kind: "reply", subject: m.subject, body: JSON.parse(dec(m.data)), ms };
  return { kind: "stray", subject: m.subject };
}
const describe = (o: Outcome) => (o.kind === "reply" ? `reply(${o.body.by.authority}) ${o.ms}ms` : o.kind === "no-responders" ? `503 on ${o.subject.split(".").slice(3, 8).join(".")} ${o.ms}ms` : o.kind === "deadline" ? `deadline ${o.ms}ms` : o.kind === "stray" ? `stray ${o.subject}` : "refused");

// ---- seats ----------------------------------------------------------------------------------
const coder = await userSeat(W.coder, serveRows(W.coder));
const helper = await userSeat(W.helper, serveRows(W.helper));
const web = await userSeat(W.web, join2(serveRows(W.web), ownerRows(W.web)));
const bobWeb = await userSeat(W.bobWeb, join2(serveRows(W.bobWeb), ownerRows(W.bobWeb)));
const builder = await userSeat(W.builder, join2(serveRows(W.builder), grantRows(W.builder, W.coder)));
const next = await userSeat(coderNext, serveRows(coderNext));
const admin = await userSeat(W.admin, { pub: [], sub: [] });
const mgrCaller = await userSeat(W.mgrCaller, { pub: [], sub: [] });
const observerWho = who("alice.obs(observer)", A, "obs", "interactive");
const observer = await seatFor(observerWho.name, (nonce) => permissionsFor("observer", space, { owner: A, actor: "obs", connId: nonce, readerId: `rdr${hex(8)}` }, {}) as Perm);
const serviceWho = who("org.example.svc(service serve credential)", A, "svc", "managed-agent");
const service = await seatFor(serviceWho.name, (nonce) => {
  const r = epServeGrantRows(space, { endpoint: "org.example.svc", instanceId: serviceWho.uid, epoch: 1, ephemeralCommands: ["run"] });
  return { pub: { allow: r.pub }, sub: { allow: [...r.sub, `_INBOX_${nonce}.>`] } };
});
console.log(`broker hub :${HUB}, space ${space}, ${seats.length} credentials`);
for (const s of seats) console.log(`  ${s.label}: pub ${s.perms.pub?.allow?.length ?? 0} allow / ${s.perms.pub?.deny?.length ?? 0} deny, sub ${s.perms.sub?.allow?.length ?? 0} allow / ${s.perms.sub?.deny?.length ?? 0} deny`);

const coderServe = serve(coder, W.coder, W.coder.rt);
const coderHold = serve(coder, W.coder, `${W.coder.rt}h`, { holdMs: HOLD_MS });
const coderLiar = serve(coder, W.coder, `${W.coder.rt}x`, { liar: true });
const helperServe = serve(helper, W.helper, W.helper.rt);
const nextServe = serve(next, coderNext, coderNext.rt);
await Promise.all([coder, helper, next].map((s) => s.nc.flush()));
check("every serving credential subscribed its own runtime subject without a violation",
  !(await until(() => [coder, helper, next].some((s) => s.refused.length > 0), 1000)), [coder, helper, next].flatMap((s) => s.refused));

// Observation 4 runs in the background from the start: a reply after more than two minutes on a static row.
const holdStart = Date.now();
const held = call(web, W.web, { ...W.coder, rt: `${W.coder.rt}h` }, "prompt", "owner", HOLD_MS + 20_000);

// ---- cells ----------------------------------------------------------------------------------
console.log("\ncell 1: owner's interactive session calls its own agent");
{
  const before = coderServe.received;
  const out = await Promise.all(CMDS.map((cmd) => call(web, W.web, W.coder, cmd, "owner")));
  out.forEach((o, i) => console.log(`    ${CMDS[i]}: ${describe(o)}`));
  check(`cell 1: ${out.filter((o) => o.kind === "reply").length}/4 commands answered on the derived prin-reply subject, authority owner`,
    out.every((o) => o.kind === "reply" && o.body.by.authority === "owner" && o.body.by.caller === `${A}.web.${W.web.uid}`), out);
  check(`cell 1: the agent received exactly 4 requests (${coderServe.received - before})`, coderServe.received - before === 4);
}

console.log("\ncell 2: a managed agent publishes a request addressed to itself");
{
  const before = coderServe.received;
  const r = await Promise.all(["owner", "grant"].map((a) => publishRefused(coder, reqSubj(W.coder, "prompt-answer", a, W.coder, hex(8)))));
  check(`cell 2: ${r.filter(Boolean).length}/2 self-addressed publishes (owner, grant) refused by the broker`, r.every(Boolean));
  check("cell 2: the agent received none", coderServe.received === before);
}

console.log("\ncell 4: a sibling agent of the same owner calls");
{
  const before = coderServe.received;
  const r = await Promise.all(["owner", "grant"].map((a) => publishRefused(helper, reqSubj(W.coder, "prompt-answer", a, W.helper, hex(8)))));
  check(`cell 4: ${r.filter(Boolean).length}/2 sibling publishes refused`, r.every(Boolean));
  check("cell 4: the agent received none", coderServe.received === before);
}

console.log("\ncell 5: a sibling agent subscribes the agent's request subject");
{
  const subs = [
    `${P}.ep.prin.agent.${A}.coder.${W.coder.uid}.${W.coder.rt}.*.*.*.*.*.*`,
    `${P}.ep.prin.agent.${A}.coder.${W.coder.uid}.>`,
    `${P}.ep.prin.agent.${A}.>`,
    `${P}.ep.prin.>`,
  ];
  const r = await Promise.all(subs.map((s) => subscribeRefused(helper, s)));
  check(`cell 5: ${r.filter(Boolean).length}/${subs.length} sibling subscriptions refused`, r.every(Boolean));
}

console.log("\ncell 6: another owner's interactive session calls");
{
  const before = coderServe.received;
  const r = await Promise.all(CMDS.map((cmd) => publishRefused(bobWeb, reqSubj(W.coder, cmd, "owner", W.bobWeb, hex(8)))));
  check(`cell 6: ${r.filter(Boolean).length}/4 publishes by bob.web refused`, r.every(Boolean));
  check("cell 6: the agent received none", coderServe.received === before);
}

console.log("\ncell 7: admin, observer, manager-caller view and a service credential");
{
  const before = coderServe.received;
  const callers: [Seat, Who][] = [[admin, W.admin], [observer, observerWho], [mgrCaller, W.mgrCaller], [service, serviceWho]];
  let pubs = 0, subs = 0;
  for (const [s, w] of callers) {
    const p = await Promise.all([
      publishRefused(s, reqSubj(W.coder, "prompt-answer", "owner", w, hex(8))),
      publishRefused(s, reqSubj(W.coder, "prompt-answer", "grant", w, hex(8))),
      publishRefused(s, `${P}.ep.prin-reply.agent.${A}.coder.${W.coder.uid}.${W.coder.rt}.${A}.web.${W.web.uid}.${hex(8)}`),
    ]);
    const q = await Promise.all([`${P}.ep.prin.>`, `${P}.ep.prin-reply.>`, `${P}.ep.*.agent.>`].map((sub) => subscribeRefused(s, sub)));
    pubs += p.filter(Boolean).length; subs += q.filter(Boolean).length;
    console.log(`    ${s.label}: ${p.filter(Boolean).length}/3 publishes refused, ${q.filter(Boolean).length}/3 subscriptions refused`);
  }
  check(`cell 7: ${pubs}/12 publishes and ${subs}/12 subscriptions refused across 4 credentials`, pubs === 12 && subs === 12);
  check("cell 7: the agent received none", coderServe.received === before);
}

console.log("\ncell 8: a caller publishes with another caller's tokens in the tail");
{
  const before = coderServe.received;
  const forged = [
    reqSubj(W.coder, "prompt-answer", "owner", W.bobWeb, hex(8)),
    reqSubj(W.coder, "prompt-answer", "owner", { ...W.web, actor: "other" }, hex(8)),
    reqSubj(W.coder, "prompt-answer", "owner", { ...W.web, uid: mintLifecycleUid() }, hex(8)),
  ];
  const r = await Promise.all(forged.map((s) => publishRefused(web, s)));
  check(`cell 8: ${r.filter(Boolean).length}/3 forged-tail publishes refused (other owner, other actor, other uid)`, r.every(Boolean));
  check("cell 8: the agent received none", coderServe.received === before);
}

console.log("\ncell 10: the agent publishes a reply under another principal's head");
{
  const tail = `${A}.web.${W.web.uid}.${hex(8)}`;
  const heads = [
    `${P}.ep.prin-reply.agent.${A}.helper.${W.helper.uid}.${W.helper.rt}.${tail}`,
    `${P}.ep.prin-reply.agent.${A}.coder.${coderNext.uid}.${coderNext.rt}.${tail}`,
    `${P}.ep.prin-reply.agent.${B}.builder.${W.builder.uid}.${W.builder.rt}.${tail}`,
    `${P}.ep.prin-reply.other.${A}.coder.${W.coder.uid}.${W.coder.rt}.${tail}`,
  ];
  const r = await Promise.all(heads.map((s) => publishRefused(coder, s)));
  check(`cell 10: ${r.filter(Boolean).length}/4 foreign-head replies refused (sibling, own later lifecycle, other owner, other endpoint)`, r.every(Boolean));
}

console.log("\ncell 11: a caller subscribes another caller's reply subject");
{
  const r = await Promise.all([
    subscribeRefused(bobWeb, `${P}.ep.prin-reply.*.*.*.*.*.${A}.web.${W.web.uid}.*`),
    subscribeRefused(bobWeb, `${P}.ep.prin-reply.>`),
    subscribeRefused(web, `${P}.ep.prin-reply.*.*.*.*.*.${B}.web.${W.bobWeb.uid}.*`),
    subscribeRefused(builder, `${P}.ep.prin-reply.*.*.*.*.*.${A}.web.${W.web.uid}.*`),
  ]);
  check(`cell 11: ${r.filter(Boolean).length}/4 foreign reply subscriptions refused`, r.every(Boolean));
}

console.log("\ncell 12 + observation 1: a request names a runtime id nobody serves");
{
  const before = coderServe.received;
  const o = await call(web, W.web, { ...W.coder, rt: "rt_gone" }, "prompt-answer", "owner");
  console.log(`    ${describe(o)}`);
  check("cell 12: no-responders, never a reply", o.kind === "no-responders", o);
  check("observation 1: the 503 arrived on the caller's sentinel subject through the wildcard-head subscription",
    o.kind === "no-responders" && o.subject.includes(".ep.prin-reply._nr._nr._nr._nr._nr."));
  check("cell 12: the agent received none", coderServe.received === before);
}

console.log("\ncell 13 + observation 2: a serving credential publishes on the sentinel subject");
{
  const subj = sentinel(W.web, hex(8));
  const r = await Promise.all([
    publishRefused(coder, subj, { headers: headers(503, "No Responders") }),
    publishRefused(builder, sentinel(W.builder, hex(8))),
    publishRefused(web, sentinel(W.web, hex(8))),
  ]);
  check(`observation 2: ${r.filter(Boolean).length}/3 sentinel publishes refused (agent forging a 503, a grantee on its own sentinel, an interactive session on its own)`, r.every(Boolean));
}

console.log("\ncell 14: a serving agent runs a request and tries to make the caller see no-responders");
{
  const before = coderLiar.received;
  const forgedBefore = coder.refused.length;
  const o = await call(web, W.web, { ...W.coder, rt: `${W.coder.rt}x` }, "prompt-answer", "owner", 2000);
  console.log(`    ${describe(o)}`);
  const refused = await until(() => coder.refused.slice(forgedBefore).some((r) => r.operation === "publish" && r.subject.includes(`._nr._nr._nr._nr._nr.${A}.web.${W.web.uid}.`)), 1000);
  check("cell 14: the agent received the request and its forged 503 was refused", coderLiar.received - before === 1 && refused);
  check("cell 14: the caller saw a deadline, never no-responders", o.kind === "deadline", o);
}

console.log("\ncell 15: a credential from another lifecycle of the agent subscribes this uid");
{
  const r = await Promise.all([
    `${P}.ep.prin.agent.${A}.coder.${W.coder.uid}.${W.coder.rt}.*.*.*.*.*.*`,
    `${P}.ep.prin.agent.${A}.coder.${W.coder.uid}.>`,
    `${P}.ep.prin.agent.${A}.coder.*.*.*.*.*.*.*.*.*`,
  ].map((s) => subscribeRefused(next, s)));
  check(`cell 15: ${r.filter(Boolean).length}/3 subscriptions by the later lifecycle refused`, r.every(Boolean));
  const own = await subscribeAccepted(next, `${P}.ep.prin.agent.${A}.coder.${coderNext.uid}.rt_other.*.*.*.*.*.*`);
  check("cell 15 control: the later lifecycle subscribes its own uid", own);
}

console.log("\ncell 16: a hand-built grant row for one agent lifecycle calls that agent");
{
  const before = coderServe.received;
  const out = await Promise.all(CMDS.map((cmd) => call(builder, W.builder, W.coder, cmd, "grant")));
  out.forEach((o, i) => console.log(`    ${CMDS[i]}: ${describe(o)}`));
  check(`cell 16: ${out.filter((o) => o.kind === "reply").length}/4 commands answered, by.authority grant`,
    out.every((o) => o.kind === "reply" && o.body.by.authority === "grant" && o.body.by.caller === `${B}.builder.${W.builder.uid}`), out);
  check(`cell 16: the agent received exactly 4 requests (${coderServe.received - before})`, coderServe.received - before === 4);
}

console.log("\ncell 17: the same grant row calls another agent of that owner, or a later lifecycle");
{
  const h = helperServe.received, n = nextServe.received;
  const r = await Promise.all([
    publishRefused(builder, reqSubj(W.helper, "prompt-answer", "grant", W.builder, hex(8))),
    publishRefused(builder, reqSubj(coderNext, "prompt-answer", "grant", W.builder, hex(8))),
    publishRefused(builder, reqSubj({ ...W.coder, owner: B }, "prompt-answer", "grant", W.builder, hex(8))),
  ]);
  check(`cell 17: ${r.filter(Boolean).length}/3 grant publishes off the named lifecycle refused (sibling, later lifecycle, other owner)`, r.every(Boolean));
  check("cell 17: neither the sibling nor the later lifecycle received anything", helperServe.received === h && nextServe.received === n);
}

console.log("\ncell 22: an owner caller sends the grant word, and the reverse");
{
  const before = coderServe.received;
  const r = await Promise.all([
    publishRefused(web, reqSubj(W.coder, "prompt-answer", "grant", W.web, hex(8))),
    publishRefused(bobWeb, reqSubj({ ...W.builder }, "prompt-answer", "grant", W.bobWeb, hex(8))),
    publishRefused(builder, reqSubj(W.coder, "prompt-answer", "owner", W.builder, hex(8))),
    publishRefused(builder, reqSubj({ ...W.coder, owner: B }, "prompt-answer", "owner", W.builder, hex(8))),
  ]);
  check(`cell 22: ${r.filter(Boolean).length}/4 wrong-word publishes refused`, r.every(Boolean));
  check("cell 22: the agent received none", coderServe.received === before);
}

// ---- observation 3: remote interest ---------------------------------------------------------
console.log("\nobservation 3: a responder that is gone behind remote interest");
{
  const u = createUser();
  writeFileSync(join(dir, "leaf.creds"), fmtCreds(await encodeUser("leaf-link", u, acct, {}, { signer }), u), { mode: 0o600 });
  writeFileSync(join(dir, "leaf.conf"), [...base(LEAF),
    `leafnodes { remotes: [ { url: "nats-leaf://127.0.0.1:${LEAF_LISTEN}", credentials: ${JSON.stringify(join(dir, "leaf.creds"))}, account: ${acct.getPublicKey()} } ] }`, ""].join("\n"));
  const leaf = await startBroker("leaf.conf", LEAF);
  const remote = await userSeat({ ...W.coder, rt: `${W.coder.rt}l` }, serveRows(W.coder), LEAF);
  const remoteServe = serve(remote, W.coder, `${W.coder.rt}l`);
  await remote.nc.flush();
  const target = { ...W.coder, rt: `${W.coder.rt}l` };
  let live: Outcome = { kind: "deadline", ms: 0 };
  for (let i = 0; i < 25 && live.kind !== "reply"; i++) { live = await call(web, W.web, target, "prompts", "owner", 400); if (live.kind !== "reply") await wait(200); }
  console.log(`    responder on the leaf, link up: ${describe(live)}`);
  check("observation 3 control: a responder behind the leaf link answers a hub caller", live.kind === "reply" && remoteServe.replied >= 1, live);

  leaf.kill("SIGSTOP");
  const stopped = await call(web, W.web, target, "prompt-answer", "owner", 3000);
  console.log(`    leaf server frozen (SIGSTOP), its interest still held by the hub: ${describe(stopped)}`);
  check("observation 3: gone behind remote interest gives a timeout, not a 503", stopped.kind === "deadline", stopped);
  leaf.kill("SIGCONT");
  await wait(500);

  await remote.nc.close();
  let after: Outcome = { kind: "deadline", ms: 0 };
  for (let i = 0; i < 25 && after.kind !== "no-responders"; i++) { after = await call(web, W.web, target, "prompt-answer", "owner", 400); if (after.kind !== "no-responders") await wait(200); }
  console.log(`    responder closed cleanly, its unsubscribe propagated over the link: ${describe(after)}`);
  check("observation 3 contrast: once the leaf withdraws the interest, the hub answers 503 again", after.kind === "no-responders", after);
}

// ---- observation 4: static reply row past two minutes ---------------------------------------
console.log(`\nobservation 4: waiting for the held reply (${HOLD_MS / 1000}s hold)`);
{
  const o = await held;
  console.log(`    ${describe(o)}, ${Math.round((Date.now() - holdStart) / 1000)}s after the request`);
  check("observation 4: a reply published more than two minutes after the request is accepted on the static row",
    o.kind === "reply" && o.ms > 120_000 && coderHold.replied === 1 && !coder.refused.some((r) => r.subject.includes(`.${W.coder.rt}h.`)), o);
}

console.log(`\nrefusals the broker reported: ${seats.reduce((n, s) => n + s.refused.length, 0)} across ${seats.length} credentials`);
for (const s of seats) await s.nc.close().catch(() => {});
for (const b of brokers) await killAndAwaitExit(b);
rmSync(dir, { recursive: true, force: true });
finish();
