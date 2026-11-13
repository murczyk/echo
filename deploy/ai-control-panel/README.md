# Agent host discovery and deployment notices

Run from the Echo checkout, rebuilding the local control panel after updating it:

```bash
cargo build -p wdintel-rs --bin wdintel-rs
just ai-control-panel
just ai-control-panel scan --host echo-cbr --json
just ai-control-panel upgrade --host echo-cbr --release 2026.10.29.4 --dry-run
just ai-control-panel upgrade --host echo-cbr --release 2026.10.29.4
```

The controller probes each Echo instance over operator SSH. Its database's
`ai_agent_dispatcher.host` determines the management connection: `echo@` on
`echo-ai-agent-vm.eagle-atria.ts.net` or `echo-ai-agents-ua.eagle-atria.ts.net`.
The database's `ssh_user` and `port` describe the restricted dispatcher, not
the operator's management connection. SSH credentials, ports, jump hosts and
host keys remain in the operator's SSH configuration. Legacy TOML settings are
imported into the database at Echo startup; the database is authoritative.

`--agent-host` remains an explicit override for either supported management
connection and must match the instance's configured dispatcher. Unsupported or
missing dispatcher settings block management instead of choosing a default VM.
The TUI header shows the highlighted instance's VM; details and previews show
each resolved destination. Mixed-VM batches keep their release catalogs and
namespace selections separate, prepare each selected VM once, then upgrade in
local/staging/production order. A failure stops the batch.

`scan --json` retains `shared` and the usual release fields for a single VM.
All scans also include `shared_hosts`, keyed by management connection,
`agent_host` on each instance, and `agent_hosts` on each release with the
per-VM metadata. For mixed-VM scans, `shared` is empty; use `shared_hosts`.

New rollout journals record their agent VM. Recovery validates that destination
against the instance's current settings. If they changed, restore the original
dispatcher settings before recovering. Older journals lack that binding:
verify their original destination and supply the matching `--agent-host`
explicitly for recovery. Recovery retains the existing namespace and identity
checks. See the [rollout and recovery procedure](../../echo-ai-agent/CONTROL_PANEL.md#upgrade-and-recovery).

Host actions that take their locks before changing anything (inventory, job,
container, replace, finish, cleanup) retry with backoff for about 40 seconds
when an agent VM lock is busy. The dispatcher holds the shared lock while it
serves other servers' agents, so a single busy lock no longer stops a rollout.
If recovery has to restore a harness the running Echo build doesn't support, AI
stays disabled and the local journal records `pending_enable`. The next upgrade
of that server switches AI back on even though the server now reports it off.
A successful upgrade clears the flag.

Before each authenticated connection test during rollout, Echo refreshes the
existing agent's scope and direct private-group memberships from its linked
human. It preserves agent and container identities and rejects revoked human
access. Bootstrap authorization remains enforced. Verification errors return a
failed protocol response while keeping the maintenance lease and channel open,
so the controller can recover containers and finish restoring settings.

`just deploy` and `just deploy-from-local` finish with `deploy-notice.py --sync`
after service checks and deployment cleanup. It compares the running
application's required release with the namespace's selected template and
managed agents. Backups and other namespaces do not count. An empty namespace
uses its template; configured instances are checked even with AI disabled.
Unconfigured instances are skipped. An interrupted rollout of the namespace on
the agent VM, or an unfinished rollout journal of the deploying checkout
(`.dev-runtime/ai-control-panel/<server>.json`), is an unknown status naming
`just ai-control-panel recover`, never current. When the harness differs, it
runs the same preview and upgrade as
`just ai-control-panel upgrade --host <server> --release <required> [--dry-run]`,
then checks again. It runs the deploying checkout's `control.py` directly, so it
needs no local Rust build. The panel runs in its own session and writes a
session log, whose path is printed; a log that can't be written stops logging,
not the upgrade. Ctrl-C, SIGTERM or SIGHUP ask it to stop at a safe boundary,
and so does any error while reading its output. Either way the deploy keeps
reading its output until it has exited, even if the terminal is gone. The deploy exits 1 with a 🔴 message and notification
when the preview, upgrade or final check fails or the status is unknown. The
application deploy itself has succeeded by then. `--silent` suppresses
deployment notifications, not the harness output.

Without `--sync`, the check only reports: bounded, read-only SSH operations, no
local Rust build, and exit status 0 even when the status is unknown.

Run the notice independently:

```bash
python3 deploy/ai-control-panel/deploy-notice.py echo-cbr
python3 deploy/ai-control-panel/deploy-notice.py --sync echo-cbr  # retry a failed deploy sync
python3 -m unittest discover -s deploy/ai-control-panel -p 'test_*.py'
python3 -m unittest discover -s echo-ai-agent/tests -p test_control_panel.py
```
