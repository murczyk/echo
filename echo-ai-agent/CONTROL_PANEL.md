# AI control panel

Run from an Echo checkout:

```bash
just ai-control-panel
just ai-control-panel --host echo-extra
just ai-control-panel scan --json
just ai-control-panel upgrade --host local --release 2026.09.27.2 --reconcile-orphans --dry-run
just ai-control-panel upgrade --host local --release 2026.09.27.2 --reconcile-orphans
just ai-control-panel recover --host local
target/debug/wdintel-rs --mode=debug ai-control-panel --repo /path/to/echo
```

The panel reads `just servers-ai`, includes the checkout's local configuration,
and accepts SSH aliases or `user@hostname`. Manual additions last for this session.
SSH ports, jump hosts, and credentials remain in the operator's SSH configuration.
Python 3.9+, `just`, SSH, and a terminal are required locally. Production inspection
uses operator SSH and noninteractive sudo; the shared host uses the existing
`echo@echo-ai-agent-vm.eagle-atria.ts.net` admin connection and pinned host key.

## Inventory and compatibility

Opening the panel scans the fleet with four concurrent workers and bounded
timeouts. `s` scans all hosts; `r` refreshes the highlighted host. Each row shows
its scan time, namespace, observed container releases, and the running Echo
build's exact harness requirement. A failed scan never reuses an old successful
version as current evidence. Shared dispatcher and default-template versions
appear separately from container versions. Backup containers are not deployments.

The panel writes a timestamped session log to a private
`/tmp/echo-ai-control-panel-*.log` file (or the configured temporary directory).
Its path appears above the progress pane and is printed after exit, including
when the panel returns an error. The file retains full scan snapshots, commands,
timings, worker exit codes, and error traces beyond the on-screen history limit.

For a running-build mismatch, the details and log identify the process IDs,
executable identities, and restart action. Local workers started from the
repository root or `wdintel-rs/` belong to the same checkout. After rebuilding,
restart the local backend and workers (`just dev-tmux-stop && just dev-tmux`) and rescan;
upgrades remain blocked while a process uses an older executable.

Use `[` and `]` to select a target release. The catalog contains retained shared-host
bundles and the current checkout, distinguishing missing templates and unknown
compatibility. Release IDs are immutable: different bytes under an installed ID
block preparation. Bump the synchronized harness version and manifest instead.
`release.json` declares the protocol/runtime versions, supported runner releases,
and required Echo migrations; it is checked against the bundle's existing constants.

Older Echo installations remain inspectable through read-only PostgreSQL queries
against their standard local `wd` database. They cannot be upgraded until their
installed and running Echo build supplies the panel's status and maintenance
interfaces. Missing metadata is **unknown compatibility**, not permission to
upgrade. Application deployment, migrations, provider selection, and initial
dispatcher-key provisioning remain separate operations.

Shared preparation publishes a backward-compatible dispatcher bundle without
restarting SSH, changing the host's firewall or profiles, or clearing dispatcher
homes. Infrastructure and runtime changes require a separate deployment. Each
existing namespace is pinned to its previous template, then preflighted before
publication. Unselected Echo installations need not supply maintenance helpers
for this compatible publication; upgrading their own agents still requires them.

## Upgrade and recovery

The CLI runs the same worker as the TUI, prints its parameters before scanning,
and exits nonzero on failure. Repeat `--host` to select a batch; omitted hosts are
never implicitly upgraded. `scan --json` emits JSON-lines events. Ctrl-C requests
cancellation at a safe boundary. `upgrade --dry-run` checks inventory and eligibility
without mutation; actual preparation additionally checks shared infrastructure.

Rows marked `absent` in Echo's database are normal and need no replacement.
For stopped containers whose database identity has disappeared, press `o` (CLI:
`--reconcile-orphans`) to retain them as `ai-orphan-*` backups during upgrade.
Running or inconsistently identified orphans remain blocked. Names are logged and
recorded in recovery journals. An empty namespace is upgraded by pinning and
checking its template; the next AI request creates its agent normally.

Select hosts with Space, choose a release, and press `u`. Review the preview and
press Enter to execute. The controller re-scans and checks the release digest
before changing anything. Busy, stale, mismatched, or unconfigured targets block
the batch. Execution orders local development, staging, then production and stops
on the first failure. `c` cancels after shared preparation or the current namespace;
it does not terminate an in-progress container replacement.

The shared updater builds names such as `echo-ai-agent-template-2026-09-27-1` (Incus requires
hyphens; release labels retain dots), retains the legacy
fixed template, and stores root-owned namespace selections under
`/etc/echo-ai-agent/namespace-releases/`. Existing namespaces retain their previous
template selection. A dispatcher accepts only supported, stopped, isolated
templates with matching release metadata. Shared infrastructure preparation can
be retried with the same bundle after a partial failure.

For each selected namespace, a database advisory lease prevents new AI lifecycle
operations and settings changes. Queued/running requests block acquisition.
The previous feature flag is saved before disabling AI. An independent namespace
lock and durable marker prevent dispatcher operations during replacement, including
after an operator disconnects. Existing containers are stopped and renamed as
backups; their identities, proxies, and database conversations are preserved.

Replacement containers are started one at a time, checked through Echo's existing
authenticated test-connection flow, and returned to their previous running/stopped
states. Successful completion restores the previous AI flag. No model request or
provider-token transfer is needed for this connectivity check.

Local journals are stored under `.dev-runtime/ai-control-panel/`; root-owned shared
journals live under `/var/lib/echo-ai-agent/rollouts/`. Keep these files until the
rollout completes. Failures attempt namespace recovery and stop the batch. If
recovery cannot be verified, AI remains disabled and the progress pane identifies
the journal. Highlight the host and press `x`, then Enter, to retry recovery.
Restoring an older harness that the running Echo build does not support leaves
AI disabled. Shared infrastructure is never automatically downgraded.

## Validation

`python3 -m unittest discover -s echo-ai-agent/tests -p 'test_*.py'` covers dispatcher
namespace isolation, operational inventory and compatibility checks, destructive
operation guards, and recovery ownership. The Rust test
`ai_control_panel::probe::tests::rollout_lease_excludes_lifecycle_until_released`
uses a dedicated test database to exercise actual PostgreSQL advisory locks.

Before production use, validate a complete upgrade, cancellation, interrupted
replacement, and recovery on a disposable Incus host, then staging. Check that
an unselected namespace can still start and create its older-release agents.
The control panel does not automatically bootstrap a fresh Incus host.
