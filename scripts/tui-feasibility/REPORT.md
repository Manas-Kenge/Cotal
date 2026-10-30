# Cotal TUI feasibility

The goal is to establish whether the proposed Bun TUI can use Cotal's current libraries and installed package graph before importing OpenCode's TUI. The feasibility gate does not pass. Direct Bun supports the tested mesh paths, but manager startup, Windows module identity and the compiled host loader block the design as written.

Only proof files and a branch-scoped workflow changed. No product source, default cotal behavior, wire contract or schema changed. No full TUI was imported and nothing was merged. Private .internal access was explicitly waived.

## Reproduce and inspect

Use the commands in [README.md](README.md). The proof source is commit `89fabeb305acca5c7d2b34be7b0cc8cf4342bf82` on `probe/tui-feasibility-20261030`. Product source is unchanged from `dd31f5de0e90ee16ddc150254a78ade420d4f032`.

The final [hosted comparison](https://github.com/Manas-Kenge/Cotal/actions/runs/41023604288) runs on real Linux x64, macOS arm64 and Windows x64. Results are retained under [evidence](evidence/), including exact case errors, runtime versions, source heads, runner metadata, binary hashes and cleanup observations. The SHA-256 manifest covers retained evidence. Full preparation and broker logs are in the workflow artifacts, which expire after 14 days.

The baseline is Node 22, Cotal's supported runtime generation. Bun is pinned to `1.4.4+38afee6c8`, NATS to `2.12.12`, pnpm to `11.28.2`, and the minimal OpenTUI native probe to `0.8.0`. Each environment file records the resolved Node patch and runner image. An additional Linux run uses Node 26.7.0 with experimental FFI.

## Results

| Path | Node, all three OSes | Direct Bun, all three OSes | Compiled Bun |
| --- | --- | --- | --- |
| Read isolated machine registrations without dialing a broker | Pass | Pass | Unverified after bootstrap failure |
| Two independently credentialed spaces, presence and separate CLI who observers | Pass | Pass | Unverified |
| Authenticated DMs, no cross-space receipts, wrong credentials rejected | Pass | Pass | Unverified |
| Reload newer credentials, cross initial expiry, receive another DM | Pass | Pass | Unverified |
| Native process identity and PTY addon import | Pass | Pass | Unverified |
| Windows workspace creation.node binding | Pass on Windows | Pass on Windows | Unverified |
| Exported Manager start, native HTTP inventory, stop and closed listener | Pass | Existing Bun PTY refusal | Unverified |
| Non-CLI detached manager helper | Existing refusal | Existing refusal | Unverified |
| Process-service host | Linux passes; macOS/Windows explicitly unsupported | Same existing platform restriction | Unverified |
| One core Registry shared with disk peer extension and manager provider | Pass | Linux/macOS pass; Windows fails | Unverified |
| OpenTUI native headless frame | Node 22 fails its FFI requirement; local Linux Node 26 passes | Pass | Build succeeds; frame unverified |

Native import is not PTY spawn proof. No agent seat was spawned, no interactive terminal was driven, and the direct Manager test does not exercise the CLI's complete up/down orchestration or detached custody.

The fixture's three brokers are launched and stopped by the Node controller. This establishes live protocol fixtures, not a successful Bun call to Cotal's broker controller. The required complete local broker/manager lifecycle remains blocked and unproved. The probe reaches the existing process-service and non-CLI entry restrictions without spoofing process.argv or bypassing guards.

## Blocking findings

**Compiled installed-host loading fails on all three platforms.** Compilation succeeds, but startup stops before any Cotal case:

```text
ERR_MODULE_NOT_FOUND
Cannot find package '@cotal-ai/core' imported from <installation>/node_modules/cotal-ai/dist/tui-host.mjs
```

The host and Cotal packages are physical copies, with locked third-party dependencies linked into the fixture. Node and direct Bun load that graph. The compiled bootstrap does not. The small independent loader control passes on Linux, including external/autoload variants, so a generic claim that compiled Bun cannot load disk modules would be unsupported. The cause in this Cotal graph is unresolved. No compiled native, messaging, renewal or Registry behavior can be claimed after this failure.

**Windows direct Bun duplicates core module state in this layout.** The extension's Registry is not reference-equal to the host's Registry:

```text
Values have same structure but are not reference-equal:

Registry {}
```

The manager provider then fails lookup in the host:

```text
no local-process registered for "manager-service"
```

Node passes both assertions against the same installed fixture. This is a Bun-specific incompatibility relative to Node in this fixture. No earlier Bun version was tested. Path/junction canonicalization is an investigation lead, not an established cause. The fixture does not establish whether a cold npm installation has the same problem.

**The default manager runtime explicitly refuses Bun.** The existing runtime guard begins:

```text
the pty runtime requires Node.js - the manager is running under Bun (v1.4.4)
```

It refuses both runtime construction and the exported Manager constructor on every tested OS. The underlying spawn-helper hang mentioned by that diagnostic was not reproduced: the guard correctly prevents reaching it. Importing @lydell/node-pty succeeds and does not remove this restriction.

**Detached startup is coupled to the CLI entry.** Both Node and Bun refuse the proof's library entry with:

```text
refusing to re-exec this process as `cotal`:
```

The full error is retained in each runtime result. Replacing process.argv to satisfy the guard would conceal the missing daemon entry contract and is not a remedy.

**The process-service driver already requires Linux.** Node and Bun both return `UNSUPPORTED` on macOS and Windows:

```text
this process-service driver currently requires Linux machine/boot identity; another platform is not silently treated as Linux
```

This is an existing platform restriction, not a Bun regression. It does not prevent the exported Manager's narrower in-process Node test from passing on those OSes.

## Native and renderer conclusions

Workspace ships a Windows creation.node addon. macOS process identity uses ps; there is no equivalent macOS workspace addon to load. Both paths passed in their real target kernels. The native PTY dependency belongs to the manager graph and imported on all three OSes.

OpenTUI is not limited to Bun. Version 0.8.0 declares Node >=26.4.0 with experimental FFI. The hosted Node 22 renderer failure is therefore a runtime requirement, not evidence that Cotal's libraries fail. The additional Linux Node 26.7.0 frame passed. These results do not prove a Node version of OpenCode's full Solid TUI.

Linux Bun compilation uses the upstream [build-time libc definition](https://opentui.com/docs/reference/standalone-executables/). An initial attempt without it requested an absent musl native package; that preparation error was corrected before the retained final comparisons.

## Recommended remedies

1. Keep the manager and PTY ownership under Node. Define an explicit daemon entry and launch contract callable from library operations, independently of the CLI parser. Preserve the existing Bun guard until real PTY spawn evidence justifies changing it.
2. Reduce and resolve the compiled Cotal graph failure before choosing binary packaging. Repeat the exact installed-layout and dynamic-peer checks after any Bun version, resolver or bundling change. Do not bundle a second core copy to make an import appear to work.
3. Treat the Windows single-Registry assertion as a packaging gate. Investigate resolution through physical files, junctions and canonical paths. Prove both peer-extension and native-provider registration visibility before declaring Windows Bun support. Do not introduce a global singleton workaround on this evidence.
4. Decide the supported macOS/Windows service-management contract. The current Linux driver cannot become cross-platform through a new UI. A platform implementation or explicitly narrower scope needs its own reviewed work.
5. Keep Node >=26.4 as a possible OpenTUI alternative, with a separate packaging/full-TUI probe if chosen. It is not yet a proved replacement for Bun in the OpenCode fork.

No remedy is implemented in this milestone. The next investment should address these feasibility blockers before shared-operation extraction or TUI import.

## Proof limits and ownership

Credential replacement uses a parent test issuer and core.reloadCreds. It does not prove workspace's automatic renewal owner, Cloud sign-in, refresh-token handling, or the product's maximum credential lifetime. No customer credentials are used.

The package graph resembles the proposed optional-binary-plus-JS-host layout. It is not a cold npm publish/install/update test, signature verification, every optional target, or the operator extension installer. Linux arm64, Intel macOS, Windows arm64, musl, interactive input, resize and PTY seat execution remain unverified.

Normal runs fence new launches, stop endpoints and await owned child and broker exits before removing scratch. Linux SIGTERM interruption checks observe active compiler, candidate and CLI observer children, verify no observed child remains running and remove the owned scratch only after exit. macOS/Windows interruption ordering is unverified. On interruption, the harness retains stores and records the owning scratch path rather than deleting them before confirmed exit.

The isolated unmerged worktree and compact evidence remain for review. The probe/tui-feasibility-20261030 lane owns the retained worktree, about 724 MiB including dependencies, and the local evidence directory, about 2 MiB. Remove them after review and after confirming no process owns them. The shared pnpm store, original worktree and unrelated files are outside this cleanup scope.
