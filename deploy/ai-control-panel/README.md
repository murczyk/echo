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

Before each authenticated connection test during rollout, Echo refreshes the
existing agent's scope and direct private-group memberships from its linked
human. It preserves agent and container identities and rejects revoked human
access. Bootstrap authorization remains enforced. Verification errors return a
failed protocol response while keeping the maintenance lease and channel open,
so the controller can recover containers and finish restoring settings.

`just deploy` and `just deploy-from-local` finish with `deploy-notice.py` after
service checks and deployment cleanup. It compares the running application's
required release with the namespace's selected template and managed agents.
Backups and other namespaces do not count. An empty namespace uses its template;
configured instances are checked even with AI disabled. Unconfigured instances
are skipped. Unknown status produces a warning and a manual scan command.
The check uses bounded, read-only SSH operations, needs no local Rust build,
does not upgrade agents, and preserves the deploy result even if it fails.
`--silent` suppresses deployment notifications, not the final harness notice.

Run the notice independently:

```bash
python3 deploy/ai-control-panel/deploy-notice.py echo-cbr
python3 -m unittest discover -s deploy/ai-control-panel -p 'test_*.py'
python3 -m unittest discover -s echo-ai-agent/tests -p test_control_panel.py
```
