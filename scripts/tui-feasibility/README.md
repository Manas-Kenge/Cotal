# Cotal TUI runtime feasibility

This disposable proof compares the current Cotal libraries under Node, Bun 1.4.4 and a Bun-compiled bootstrap. It implements no app screens, shared-operation extraction or launcher remedy. It never changes bare cotal.

Read [REPORT.md](REPORT.md) for the completed comparison, blockers and recommended remedies. Exact retained results are in [evidence/summary.json](evidence/summary.json).

## Run the proof

Use Node 22 or later, Bun 1.4.4, pnpm 11.28.2 and nats-server 2.12.12. Build the source first. Windows also needs the source-matched workspace creation.node binding built through the existing workspace-native workflow.

```sh
pnpm install --frozen-lockfile --ignore-scripts --filter 'cotal-ai...' --filter @cotal-ai/smoke-kit --filter cotal-monorepo
pnpm --filter 'cotal-ai...' build
npm ci --prefix scripts/tui-feasibility/renderer --ignore-scripts --no-audit --no-fund
node --import tsx scripts/tui-feasibility/run.mjs --output /absolute/path/to/evidence
node scripts/tui-feasibility/loader-control.mjs /absolute/path/to/loader-evidence
```

The main proof requires loopback listeners and subprocess permission. It creates isolated home/project directories. A parent Node controller owns three temporary NATS brokers and renews short-lived fixture credentials. Candidate runtime processes open real Cotal endpoints. No customer credentials, existing services or actual user-home records are used.

The Node baseline uses the selected Node executable. On Node 26 it enables experimental FFI for the minimal renderer. Node 22 is below OpenTUI 0.8.0's documented Node minimum, so its renderer result is a separate runtime requirement from Cotal library support.

## Read the result

`report.json` records the source head, native platform and architecture, compilation, every runtime result and cleanup. Individual runtime files preserve exact case errors and stacks. Exit 0 means the exercised cases passed. Exit 1 records a failed case, failed bootstrap or missing result. Exit 2 records existing unsupported paths. A red workflow is expected when a required feasibility path is blocked. It is not a release CI verdict.

The cases cover local machine records with a malformed entry, a real native OpenTUI headless frame, two independently authenticated spaces, participant presence, real DMs, credential isolation and renewal beyond the first accepted expiry. Separate Node CLI observers run `cotal who --all --json` while the candidate endpoints remain connected. The candidate host never executes CLI commands.

Native cases exercise actual process identity, the real Windows binding on Windows, PTY addon import, runtime construction, the exported Manager lifecycle and the current non-CLI detached-entry refusal. Importing an addon is not proof that spawning a PTY works. Direct Manager start/stop is not full up orchestration or detached custody.

## Inspect the package layout

The fixture creates an optional-binary-shaped directory beside a cotal-ai host package. Built Cotal package files are copied into that package graph. Locked third-party dependencies are linked from the worktree. A separately loaded local peer extension and the native manager registration must share the host's core Registry.

This is an installed-layout fixture, not a cold npm publication or the operator extension installer. It does not prove update behavior, all optional package targets or arbitrary third-party extension compatibility. The compiled bootstrap includes the minimal OpenTUI renderer and imports the host from disk. Linux compilation defines OPENTUI_LIBC as glibc, following the upstream standalone procedure. Raw initial compile attempts without that definition are not evidence of a Cotal bug.

`loader-control.mjs` uses a tiny scoped ESM dependency without Cotal. It compares direct execution and compiled external/autoload settings. Its result can narrow a bootstrap failure. It cannot replace a failing installed Cotal graph result.

## Keep evidence and retire fixtures

Only result JSON and sanitized logs belong in the evidence directory. Credentials, configs, native process state and stores remain outside it. The controller fences new launches, stops fixture endpoints, awaits every owned broker exit, verifies its child handles ended, then removes its scratch tree. If handles remain, it retains scratch and reports the owner path. It never kills by process name.

The branch-scoped hosted workflow runs this proof on real Linux, macOS and Windows runners. It uploads failures and preparation logs. See [platforms.md](platforms.md) for target limits. Full OpenCode TUI import, Solid UI behavior, interactive terminal control, user-auth sign-in and production packaging remain outside this proof.
