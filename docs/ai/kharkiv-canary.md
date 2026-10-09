# Kharkiv government AI canary

`echo-kharkiv2` uses government `glm-5.3` for agents, reviews, callsigns,
settlements, positions, summaries, and report suggestions. Government
`gpt-6-luna` supplies vision through the `openai_vision` OCR profile. Azure
application credentials are reused from Tsur, decrypted for transfer, and
re-encrypted using Kharkiv's existing StrongBox key. Preserve that key and the
existing S3 key. Engine tokens stay empty; provider credentials stay on Echo.

API, background, and report workers run on Kharkiv. Per-user agent containers
run on the separate VM. Native document extraction and OCR use the existing
shared document extractor, including its existing Paddle and GPU routers.

## Agent VM

| Setting | Value |
| --- | --- |
| Proxmox | `pve-hz-4`, VM 130, `srv-echo-ai-agents-ua` |
| OS / hostname | Debian 13 amd64 / `echo-ai-agents-ua` |
| CPU / memory | 16 CPUs / 32 GiB |
| Disks | 64 GiB root; dedicated 128 GiB `/dev/sdb`, serial `echo-ua-agents-data` |
| Network | `vnet0`, reserved DHCP `10.190.254.39`, MAC `BC:24:11:37:24:01` |
| Tailscale | `echo-ai-agents-ua.eagle-atria.ts.net`, `100.88.139.100` |
| SSH | admin 22; forced dispatcher 22031 |
| Harness | `2026.10.09.12`, matched by the canary Echo build |
| Capacity | six running containers total; each 2 CPUs, 4 GiB RAM, 20 GiB root |

The `ua` host profile uses a dedicated disk and validates its hostname, OS,
serial, size, signatures, mount state, and ownership marker. It refuses to
initialize a root disk or an unmanaged disk. The original profile preserves the
audited geometry of VM 129. Profile selection is outside immutable releases:
`/etc/echo-ai-agent/host-profile` contains `ua`, owned by root, mode 0644.

Run host recipes with `--server=echo-ai-agents-ua`. They select the `ua` profile
automatically. The admin account needs passwordless sudo and membership of
`incus-admin`; dispatcher identities are created by `provision-key`, with
forced commands and namespace ownership checks. For control-panel operations:

```sh
wdintel-rs ai-control-panel --repo . \
  --agent-host echo@echo-ai-agents-ua.eagle-atria.ts.net \
  --host echo-kharkiv2 scan
```

Kharkiv uses its existing dedicated public key and namespace `echo-kharkiv2`.
Its dispatcher hostname resolves to `10.190.254.39` through `/etc/hosts`; its
Echo TLS proxy upstream is `10.190.254.11:443`, with the public hostname for
certificate verification. Admin and dispatcher host keys are pinned separately.
No other Echo installation or agent namespace is moved during this rollout.

## Shared extractor access

Direct Kharkiv-to-extractor TCP access currently needs Tailscale sharing/ACL
configuration. Until available, the new VM provides a private TCP relay:
`10.190.254.39:8000` forwards over Tailscale to `100.93.77.92:8000`.
The socket binds only the VM's private LAN address, and its separate nftables
table accepts only `10.190.254.11`. Agent-container traffic remains blocked by
the agent host firewall. Bearer authentication is checked by the extractor;
the relay stores no credentials and does not log payloads.

The relay units and firewall script are in `deploy/ai-document-relay/`. Install
its three units into `/etc/systemd/system`, install `apply-firewall.sh` as
`/usr/local/libexec/echo-document-extractor-relay-firewall`, reload systemd,
and enable `echo-document-extractor-relay.socket` on the new VM only.

The extractor's owned nftables table retains all original seven source hosts
and additionally accepts Kharkiv and the relay VM. The source parser accepts a
nonempty list of unique host/address pairs instead of requiring exactly seven.
Kharkiv's `[ocr]` uses the relay as `base_url`, `instance_id="echo-kharkiv2"`,
`gateway_url="http://100.72.214.105:8081"`, and at most two jobs in flight.
The extractor can reach that callback over Tailscale. Its bearer and Kharkiv's
fresh callback signing key are root-readable in `/etc/echo/ocr.env`.

After direct Tailscale sharing/ACL access is available, first verify authenticated
`/v1/status` from Kharkiv against `http://100.93.77.92:8000`, then change
`[ocr].base_url` to that URL and restart API/background workers. Drain relay
connections before disabling its socket; remove only its owned firewall table
and its extractor allowlist entry. Keep the direct Kharkiv entry.

## Configuration and processing scope

Both government engines retain Tsur's context of 65,536 tokens, compaction
reserve of 16,384 and recent history of 8,192. Kharkiv's GLM generation budget
is 16,384 tokens, including reasoning and visible output; Luna retains 8,192.
GLM is the default and reviewer. Only government engines are allowed for agent conversations;
the old Gemma engine registration is retained for rollback.

GLM agent requests explicitly use maximum reasoning. The runner checks complete
provider context, including the system prompt, tool schemas and the SDK safety
margin, before generation. It checkpoints older evidence between completed tool
rounds and resumes pagination with the original fixed period, findings and
citations. Checkpoints are internal and never appear as assistant answers.
If summarizing the older prefix does not shrink the request, one bounded
fallback checkpoints all completed evidence, including the retained latest
tool batch. The input guard, source audit and continuation cursors still apply.
Complete tool results enter the checkpoint request; the SDK's default
2,000-character tool-result truncation is bypassed. The complete serialized
request must still fit the provider context budget.
When government Luna is enabled and allowed for agents, government GLM requests
use Luna for internal checkpoints, with Luna's configured context and output
budget (8,192 tokens on Kharkiv), bounded by GLM's compaction reserve. GLM retains
maximum reasoning and its 16,384-token budget for report generation. Both engines
share one request-scoped capability, cancellation, revocation and call counter.
Luna's delegated scope rejects tools and output budgets above its grant. It is
rechecked against the enabled engine allowlist on every request. If no allowed
government Luna exists, legacy GLM checkpoints retain their separate output cap
of up to 16,384 tokens. Other engines retain their normal checkpoint output cap.
Checkpoint failures retain their cause
even when the SDK records them as assistant errors.
Provider SSE responses have a separate 16 MiB transport limit for per-token
framing and reasoning metadata. JSON responses retain their 2 MiB limit;
configured output limits still apply. Government GLM requests have a bounded
twenty-minute execution deadline, with up to ten minutes per provider stream.
Other engines retain ten minutes overall and five minutes per provider request.
Provider credentials remain valid through the selected deadline, and their call
counters expire with the credential so a long request cannot reset its limit.
Empty, truncated or ineffective checkpoints fail without replacing source
history. Cancellation also aborts checkpoint generation. Compaction releases
only discarded tool-context allowance; citation registries, invocation limits
and the engine's total execution deadline remain in force.

If a report fails with an output-limit error, inspect the request's provider
gateway logs. A shrinking `max_output_tokens` after successful tool pages
indicates context exhaustion; increasing the output cap alone cannot fix it.
The runner now reserves the full configured output allowance before sending a
request. When a separate checkpoint engine is available, a full-budget
output-limit response triggers one checkpoint of all active evidence followed
by one primary-engine retry of the original prompt with tools disabled, so
completed mutations cannot be replayed. The source audit stays
intact; the exhausted assistant draft is excluded from the recovery checkpoint
so its generated text cannot consume Luna's evidence allowance. A focused synthesis prompt retains tenant instructions, the fixed request
time, scope, citations and completed links while omitting tool workflow guidance.
It directs the engine to produce supported findings from the checkpoint.
Only the working context is replaced. The primary engine, reasoning,
output cap, tool and provider counters, and overall deadline remain unchanged.
Checkpoint failure, cancellation, or another output-limit response ends the
request; deployments without a separate checkpoint engine retain their prior
failure behavior.

All compatible workers are enabled. Attachment and device summaries and
positions use GLM; OCR uses Luna. The local `wd_files` database uses Kharkiv's
own PostgreSQL credentials. Attachment `backfill_complete` and
`wd_files.file_document_backfill.complete` are set before enabling discovery.
Enable `devices_section_enabled` on the active system settings row so the device
workers can pass their feature gate; preserve the prior value for rollback.
Existing queues are preserved; no historical reparse or full document backfill
is started. OCR retains its normal bounded seven-day discovery window.

Mattermost destinations are `sigint-sec`, `sigint-all-dialogues`, and
`sigint-devices` on the shared Mattermost Echo server. Webhook values are stored
in settings, never in this repository. Dialogue monitoring sends bounded user
prompts using the existing implementation.

## Upgrade and rollback

For the context-exhaustion fix, build the matching application and immutable
`2026.10.09.12` harness from `main`. Preserve the UA host profile and existing
relay configuration. Drain Kharkiv AI requests, close admission, and select
only `echo-kharkiv2` on `echo-ai-agents-ua` through the control panel. Apply
pending application migrations through the normal targeted analytics health
procedure, then verify the authenticated agent connection before reopening.
Keep government Luna enabled, allowed for agents, and configured with its
65,536-token context and 8,192-token output profile. Set only the government GLM
runtime profile's `max_output_tokens` to 16,384;
its context, reserve and recent-history values remain as listed above. An
8,192-token budget can exhaust maximum reasoning before the first tool call.
Validate the original fixed report period in a new conversation; retain the
failed request and its audit. Rollback restores the saved application and
`2026.10.08.3` namespace/template, preserving additive schema and new data.

The control panel reports retained releases with inconsistent compatibility
manifests as unknown compatibility. Their files and container inventory remain
available, but those releases cannot be selected for an upgrade. A valid new
release can still be prepared and selected through the normal guards.

Prepare the extractor package, locked GPU runtime, and native Office/archive
OS dependencies before stopping admission. Stop only its API and allow its
worker to drain accepted jobs. Abort and restore admission if draining takes
more than 15 minutes. Once drained, stop the worker, back up SQLite using its
backup API, preserve configuration, the old package, and the previous runtime,
then install and verify the new application. Keep the model manifest unchanged.
Do not interrupt an active production extraction job.

Rollback artifacts for this rollout are under `/var/backups/echo/3724` on
Kharkiv and `/var/backups/echo-document-extractor/3724` on the extractor. The
extractor spool backup uses hardlinks taken after draining: completed spool
files are immutable, so retention unlinking preserves their backup references.
This protects application rollback, not disk failure; use the normal host
backup mechanism for disaster recovery. Preserve new accepted jobs when
rolling back; do not overwrite the live SQLite database with an old snapshot.

For Kharkiv rollback, disable the newly enabled AI workers first, cancel or drain
canary requests, restore the saved settings in a transaction scoped to the
settings tables, restore its configuration, host mappings, host keys, and binary,
then restart its API/background/report workers. Keep processed documents and
normal ingestion queues. Do not replace the S3 or TOTP encryption keys.

The matching canary application also required refreshing its paired analytics
control release. The reconciliation lock is opened without creating/truncating
an existing file, so root and PostgreSQL can share the same lock under Linux's
protected-regular-file policy. The existing targeted deployment health procedure
handles schema propagation; never bypass it with a full mirror resync.

## Next installations

Onboard `echo-siversk`, `echo-zp2`, `echo-skhid`, and `echo-pivnich` individually
only after observing the canary. Each needs its own public key, dispatcher user,
namespace, pinned template, callback address, and authenticated TLS proxy route.
Use Tailscale between Proxmox hosts: their identical private subnets are isolated.
Share the new VM into each caller's tailnet or provide the required ACL access
before changing its settings. The global six-container limit is shared by all
namespaces. Existing production installations remain on their current agent host
until their own rollout.
