# TUI feasibility platforms

This probe compares the current Cotal CLI under Node 22, Bun 1.4.4, and a Bun-compiled executable.
It also probes the minimum OpenTUI native dependency.
It does not establish support for a complete TUI or change Cotal's entry point.

The isolated workflow runs only after a push to `probe/tui-feasibility-*`.
It does not run on pull requests or `main`.

| Runner | Architecture | Additional preparation |
| --- | --- | --- |
| `ubuntu-latest` | Recorded by the proof | Build the filtered Cotal dependency graph. |
| `macos-latest` | Recorded by the proof, commonly arm64 | Build the filtered Cotal dependency graph. |
| `windows-latest` | x64 | Copy the source-matched `creation.node` and receipt from `workspace-native.yml` before building Cotal. |

Runner labels can change their images. `environment.json` records the actual platform, architecture, image, source, and run.
Results apply to that recorded environment. They do not establish Linux arm64, Intel macOS, or Windows arm64 support.

The workflow installs dependencies from the existing pnpm lockfile with lifecycle scripts disabled.
It pins Bun to 1.4.4 and reads pnpm 11.28.2 from `packageManager`.
Node 22 is the baseline and its resolved patch version appears in `toolchain.log`.

NATS server 2.12.12 is built with Go 1.25.11 from the versioned Go module.
`GOSUMDB=sum.golang.org` verifies module content and `GOTOOLCHAIN=local` prevents an implicit toolchain download.
This follows the server's [versioned Go requirements](https://github.com/nats-io/nats-server/blob/v2.12.12/go.mod).

Each platform attempts the proof runner and retains its aggregate result, including failed cases. A failed bootstrap or prerequisite can leave later cases unverified.
The matrix uses `fail-fast: false`. A failed Windows native build does not skip the other platforms.
A failed proof leaves the job failed and still uploads its results.
If installation or compilation fails first, the artifact contains the preparation logs and the proof has not run.

The `tui-feasibility-<runner>-<attempt>` artifact contains `results/`, environment metadata, and preparation logs.
The runner creates its temporary homes, credentials, broker configuration, and stores outside that artifact directory.
CI uses no customer credentials and publishes no package or deployment.

Hosted runners do not provide an interactive terminal session.
Passing a native import or renderer probe does not prove ConPTY behavior, interactive input, resize handling, rendering quality, or release packaging.
Those require separate evidence before a TUI implementation can be approved.
