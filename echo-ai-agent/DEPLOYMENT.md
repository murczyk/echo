# Echo AI agent deployment

Each agent VM serves its assigned Echo namespaces. The default host is `echo-ai-agent-vm`; the Ukrainian canary uses `echo-ai-agents-ua` ([rollout](../docs/ai/kharkiv-canary.md)). Run section 1 once per host, then
repeat sections 2–6 for each authorized Echo server with a separate key and
namespace.

For fleet inventory and guarded harness-only upgrades, use
[`just ai-control-panel`](CONTROL_PANEL.md). It retains templates by release
and upgrades selected namespaces without changing other namespaces' selections.

## 1. Deploy the host

From the repository root:

```bash
cd echo-ai-agent
just check
just preflight-bootstrap --server=echo-ai-agent-vm
# First installation only: creates /dev/sda2 and moves admin SSH to port 22.
just setup --server=echo-ai-agent-vm --dangerously-acknowledge
just preflight --server=echo-ai-agent-vm
just deploy-host --server=echo-ai-agent-vm --dangerously-acknowledge
just build-template --server=echo-ai-agent-vm --dangerously-acknowledge
just verify --server=echo-ai-agent-vm
```

Omit `setup` on existing installations. `--dangerously-acknowledge` takes no
value and is required on each mutating command. Stop if `build-template`
reports an older protected template; it must be audited before replacement.

## Cross-tailnet connectivity

Before adding an Echo deployment from another tailnet, share/grant the
required nodes in both directions and verify the paths from their actual
callers:

- Echo must reach the AI-agent dispatcher on TCP 22031 and the vLLM router on
  TCP 8000;
- the AI-agent VM must reach the Echo proxy upstream on TCP 443;
- Echo must reach the configured Mattermost webhook host on TCP 443 when
  security review is enabled.

Do not rely on connectivity from the operator workstation. Test from the Echo
and AI-agent hosts themselves before importing or enabling the profile. Keep
Mattermost chat monitoring disabled unless its separate inbound integration is
intentionally configured.

## 2. Create a dispatcher key

On the Echo server being added (example: `echo-staging`):

```bash
echo_server=echo-staging
sudo install -d -o root -g root -m 0755 /etc/echo/ai-agent
sudo test ! -e /etc/echo/ai-agent/dispatcher_ed25519 && \
  sudo ssh-keygen -q -t ed25519 -N '' \
    -C "${echo_server}-ai-agent" \
    -f /etc/echo/ai-agent/dispatcher_ed25519
sudo chmod 0600 /etc/echo/ai-agent/dispatcher_ed25519
sudo chmod 0644 /etc/echo/ai-agent/dispatcher_ed25519.pub
```

From the repository root, set the Echo SSH alias and provision its public key:

```bash
echo_server=echo-staging
ssh "$echo_server" \
  'sudo cat /etc/echo/ai-agent/dispatcher_ed25519.pub' \
  > "/tmp/${echo_server}-ai-agent.pub"
(cd echo-ai-agent && \
  just provision-key "/tmp/${echo_server}-ai-agent.pub" \
    --server=echo-ai-agent-vm \
    --echo-server="$echo_server" \
    --dangerously-acknowledge)
(cd echo-ai-agent && just dispatcher-user --echo-server="$echo_server")
```

Use the printed dispatcher user in section 3. Never copy the private key from
the Echo server.

## 3. Pin the host key

From the repository root:

```bash
echo_server=echo-staging
(cd echo-ai-agent && just host-key --server=echo-ai-agent-vm) \
  > /tmp/echo-ai-agent-known-hosts
scp /tmp/echo-ai-agent-known-hosts \
  "$echo_server":/tmp/echo-ai-agent-known-hosts
ssh "$echo_server" \
  'sudo install -o root -g root -m 0644 \
    /tmp/echo-ai-agent-known-hosts /etc/echo/ai-agent/known_hosts && \
   rm -f /tmp/echo-ai-agent-known-hosts'
```

Verify the fingerprint printed by `host-key`. Keep the dispatcher user printed
by `dispatcher-user`; it is entered in the web UI after Echo is deployed.

## 4. Deploy Echo and migrate

From the repository root:

```bash
echo_server=echo-staging
just deploy --server="$echo_server"
```

While in development, deploy the local build with
`just deploy-from-local --server="$echo_server"`. For a manual package
deployment, run on the stopped Echo instance before restarting services:

```bash
/opt/echo-peerdb/bin/source-sync-exclusions-if-needed.sh --yes
sudo /usr/bin/wdintel-rs --mode=live migrate
```

Regular Echo packages target the Ubuntu 22.04 runtime and are built on
`echo-build-main` or through the compatible local build path above. Do not use
`echo-build-deb13-main` for `wdintel-rs`; that builder is reserved for Debian
13 workloads such as ClickHouse and PeerDB.

### Roll out `HARNESS_RELEASE=2026.08.25.2`

This shared-host rollout is staged by namespace. The new dispatcher accepts
existing `2026.08.25.1`, `2026.08.22.1`, and `2026.08.05.2` runners during
the transition, but creates new containers only from the `2026.08.25.2`
template. Dispatcher
preflight attests the current harness release, and Echo refuses to create or
start containers whose release does not match its typed skill registry.

1. Run `just check`, then use the read-only preflight, status, and list
   operations to inventory every namespace and confirm there are no active
   requests.
2. Deploy the host release. Replacing the stopped, protected fixed template is
   a separate destructive operation: verify its exact name and old release,
   obtain explicit approval, and preserve the previous release for rollback.
3. With the AI feature disabled on `echo-cbr-staging`, recreate only that
   namespace's dispatcher-managed containers from the new template. Chat
   history remains canonical in Echo.
4. Deploy Echo to `echo-cbr-staging`, re-enable the feature, and repeat the
   rolling-24-hour all-data summary. Require a completed response and successful
   source events without consecutive tool failures.
5. Roll out one production namespace at a time only after staging succeeds and
   that production deployment is explicitly approved. Recreate its containers
   before deploying the backend with typed request kinds.
6. Keep the previous runner allowance until status/list reports
   `harness_release=2026.08.25.2` for every managed instance. A later host
   release may then remove the allowance.

Rolling back only Echo is safe because the new runner accepts the old request
kinds. Do not roll the shared dispatcher back after new containers exist
without a coordinated container/template rollback.

## 5. Configure Echo

In the `ШІ` administration section:

1. Open `Диспетчер`, enter the VM hostname, port `22031`, dispatcher user, and
   the exact Echo server name as the namespace, then save and test it. The SSH
   key and known-hosts files use the fixed paths created in sections 2–3.
2. Add and test the enabled Echo proxy for the server's public hostname. The
   upstream must terminate HTTPS with a certificate valid for that hostname;
   the test sends a TLS/SNI request to `/api/ping` through the configured
   upstream instead of checking TCP connectivity alone.
3. Select the fixed template login and reconcile its roles.
4. Allowlist the intended providers and select the default engine. Internal
   HTTP `/v1` engines use the instance-bound direct proxy. The exact
   `https://api.openai.com/v1` engine requires a stored token and uses Echo's
   scoped capability gateway; the real token remains in Echo.
5. Select the reviewer engine and configure the Mattermost webhook.
6. Keep the feature and security review disabled until validation succeeds.
7. Open a user's `AI Agent` tab and run `Test connection`; verify the linked
   identity and the exact `ApiAgent`, `Rer`, and `Cyber` roles.

After upgrading an installation that still has `[ai_agent_dispatcher]` in
`/etc/echo/config.toml`, the first start imports it into the database. Confirm
the values under `ШІ` → `Диспетчер`, remove that TOML section, and restart Echo.

## 6. Validate

```bash
(cd echo-ai-agent && just verify --server=echo-ai-agent-vm)
(cd echo-ai-agent && just status --server=echo-ai-agent-vm)
```

With an effective `Rer` user, verify a streamed read-only tool call, audit and
review records, idle stop, restart with retained history, and test-mode cleanup.
Enable the feature only after these checks pass.

## Rollback

Host rollback retains storage, instances, keys, and administrative SSH:

```bash
(cd echo-ai-agent && \
  just rollback --server=echo-ai-agent-vm --dangerously-acknowledge)
```

### Message citations release 2026.09.27.1

This release adds `message_citations` runner events, an `assistant_snapshot`
event for the final cited answer, and citation metadata in conversation history.
Install the matching backend, frontend, and runner. Old conversation responses
remain readable with no citations. Historical answers are not regenerated.

Apply the Echo migration `m20260927_112500_ai_agent_citation_events` before
starting a backend that stores the new events. Rolling that migration back
deletes stored `message_citations` and `assistant_snapshot` events, then
restores the previous event-type check. Saved answer text stays on the request.
Upgrade Echo first, then follow
the namespace rollout with `HARNESS_RELEASE=2026.09.27.1`. The dispatcher
continues accepting `2026.08.25.2` and its existing predecessors while other
namespaces transition. Include both `runner.ts` and `citations.ts` in the
template. Verify no active requests before replacing the stopped template;
recreate only the approved namespace's containers after Echo is upgraded.
Preserve the preceding release for rollback. Validate staging before production.
Do not roll the shared dispatcher back while newer containers remain.

Acceptance requires replaying real requests with their original Kyiv time context
and access scope on Gemma and both configured OpenAI engines. Verify supporting
sources, labels, full previews, analysis links, follow-up requests, and reload.
Keep production prompts, message bodies, credentials, and raw evaluation output
outside Git. A copied database restore discards AI conversation/runtime records:
export replay inputs first and retain the local agent profile during restore.

## Government provider cooldowns (release 2026.10.29.2)

After HTTP 429, government inference calls sharing a model wait for the longest
active `Retry-After` (seconds or HTTP date), defaulting to 60 seconds when absent
or invalid. Different models have independent cooldowns. Waiting consumes the
existing request deadline; cancellation does not clear the shared cooldown.
The runner retains its two retries and never switches models automatically.

Admin technical errors retain an allowlisted provider category and known error code, including
failures delivered inside HTTP-200 event streams. Arbitrary provider error text
is never persisted because it may contain submitted input. Gateway failure logs include
the Echo request ID; HTTP 200 alone does not establish successful generation.
Provider availability is external: retries can still exhaust the request budget.

Deploy the matching Echo build before upgrading the selected namespace with
`just ai-control-panel upgrade --host <approved-host> --release 2026.10.29.2`.
Run its `--dry-run` first, and wait for queued/running requests to finish.
Deployments, namespace upgrades, and live inference tests each require explicit
approval naming the operation and environment, including staging.
Retain prior containers and recovery journals; follow the
[control panel recovery procedure](CONTROL_PANEL.md#upgrade-and-recovery) only
within approved scope. Do not downgrade shared infrastructure as a retry fix.

## GLM Flash research (release 2026.10.29.3)

Only `glm-5.3-flash-uncensored` uses the budget-aware research workflow described
in [Flash research](FLASH_RESEARCH.md). No migration, provider change or preset
configuration change is required. Deploy the matching application first.
For the authorized Kharkiv rollout, preview and then upgrade only its namespace:

```sh
just ai-control-panel --agent-host echo@echo-ai-agents-ua.eagle-atria.ts.net \
  upgrade --host echo-kharkiv2 --release 2026.10.29.3 --dry-run
just ai-control-panel --agent-host echo@echo-ai-agents-ua.eagle-atria.ts.net \
  upgrade --host echo-kharkiv2 --release 2026.10.29.3
just ai-control-panel --agent-host echo@echo-ai-agents-ua.eagle-atria.ts.net \
  scan --host echo-kharkiv2 --json
```

Confirm API/background/report service health and running build identity, matching
required/container harness releases, and successful authenticated connection
checks in the upgrade journal. Preserve other namespace pins, retained templates,
backup containers and recovery journals. A failed upgrade stops the rollout;
recovery outside the approved operation requires separate approval.

## GLM Flash completion (release 2026.10.29.4)

This release increases final synthesis to at most 8,192 tokens and adds one
budget-bounded corrective attempt. It keeps the selected provider and all time
presets unchanged. Deploy the matching application before upgrading agents so
private completion diagnostics are logged by the backend.

```sh
just ai-control-panel --agent-host echo@echo-ai-agents-ua.eagle-atria.ts.net \
  upgrade --host echo-kharkiv2 --release 2026.10.29.4 --dry-run
just ai-control-panel --agent-host echo@echo-ai-agents-ua.eagle-atria.ts.net \
  upgrade --host echo-kharkiv2 --release 2026.10.29.4
```

Verify the running application revision, service health, release match and
authenticated agent connection. Keep prior containers and rollout journals;
verify other namespace selections remain unchanged. See
[Flash completion diagnostics](FLASH_RESEARCH.md#completion-diagnostics).

## GLM Flash checkpoint and pagination recovery (release 2026.10.30.2)

Deploy the matching application, then upgrade the approved installation's
namespace with `ai-control-panel upgrade --host <host> --release 2026.10.30.2`,
previewing with `--dry-run` first. This release requires no migration or provider
change. It preserves other namespace selections and accepts prior runners.

Verify matching application/container releases and authenticated connection
checks. Exercise a Flash request with more than four retrievals, including a
batch that crosses the fourth call: every admitted retrieval must complete, the
next research turn must save its private state, and retrieval must then resume.
Public activity must contain no private state or checkpoint prerequisite errors.
Also exercise an inbox continuation without a saved pagination coverage reason:
it must wait for a private checkpoint, then either resume with a justified
coverage need or switch to focused searches. Verify that a real HTTP failure
still produces a public error with `errorReason` and an allowlisted
`AI agent tool` diagnostic in the worker journal. Private diagnostic frames must
never appear in chat events or disclose source content or arguments. The one
exception is a failed script tool: its diagnostic carries the exception class and
the last traceback line, capped and scrubbed, and only the worker journal sees it.
Retain the prior containers and rollout journal for the control panel's recovery
procedure; recovery beyond the approved operation requires separate approval.

## Bounded research for non-OpenAI engines (release 2026.10.30.3)

Deploy the matching application, then upgrade the approved installation's
namespace with `ai-control-panel upgrade --host <host> --release 2026.10.30.3`,
previewing with `--dry-run` first. No migration or provider change is needed.
The release preserves other namespace selections and accepts prior runners. With
[reasoning presets](../docs/ai/reasoning-presets.md) enabled, GLM-5.3 and other
non-OpenAI engines (not Flash alone) now use the
[bounded research workflow](FLASH_RESEARCH.md) with a doubled synthesis reserve;
raw source excerpts are no longer published as an answer by any engine.

Roll out the application and the harness together: queued requests keep the
policy snapshotted when they were queued and still validate. Verify the matching
application/container releases and authenticated connection checks, then run a
GLM-5.3 Balanced request that pages one search deeply: after three pages the next
page must be refused until a coverage reason is saved, and a request that reaches
its research limit must end with a cited answer or the short notice, never
`Встиг отримати такі уривки джерел`. Check the request's `completion_diagnostic`
log lines. Retain prior containers and the rollout journal; recovery beyond the
approved operation requires separate approval.

## Conversation uploads (release 2026.11.01.1)

Apply the `m20261101_151245_ai_agent_uploads` migration with the matching
application, then upgrade the approved installation's namespace with
`ai-control-panel upgrade --host <host> --release 2026.11.01.1`, previewing with
`--dry-run` first. The runner accepts the new `uploads`, `turnImages` and
`visionInput` payload fields and registers the `upload_*` tools. Echo requires
the exact harness release, so chat requests report that the agent is updating
until the namespace matches.

Uploads need S3 and the native document extractor already used for message
attachments. Vision stays off until an admin enables "Модель приймає зображення"
in an engine's runtime profile; enable it only for engines that accept OpenAI
image parts. Verify the rollout this way:
- A DOCX question is answered from inline text.
- A follow-up question uses `upload_read`.
- A photographed page is answered from OCR on a text-only engine and from the
  image on a vision engine.

See [the upload pipeline](../wdintel-rs/src/ai_agent/uploads/README.md).

## Frequency normalization and DMR color codes (release 2026.11.03.3)

Deploy the matching application, then upgrade the approved installation's
namespace with `ai-control-panel upgrade --host <host> --release 2026.11.03.3`,
previewing with `--dry-run` first. No migration or provider change is needed.
Releases `2026.11.03.1` and `2026.11.03.2` belong to the #3985 branch and are
published on the shared host, so both stay in the compatible runner lists.
The inbox tool accepts `selectedFrequencies`; the runner normalizes them to
Echo's stored four-decimal form (`163.935` → `163.9350`) and the system prompt
lists every frequency named in the conversation with its stored form. Retrieved
messages carry their parsed DMR metadata (`dmr`: color code, call group, sender),
and a query such as `144.8450 Мишаня Якудза, СС3` is read as color code 3, not
as a callsign. Verify that a request naming `163.935` reads messages stored as
`163.9350`, and that a `СС3` request reports color codes from message metadata.

## Conversation documents (release 2026.11.03.4)

Apply the `m20261103_120000_ai_agent_documents` migration with the matching
application, then upgrade the approved installation's namespace with
`ai-control-panel upgrade --host <host> --release 2026.11.03.4`, previewing with
`--dry-run` first. The release also contains the frequency normalization of
`2026.11.03.3`; `2026.11.03.1` and `2026.11.03.2` were this work's staging
builds. The release template adds the Debian `python3-docx`,
`python3-lxml`, `python3-matplotlib`, `python3-openpyxl` and `fonts-dejavu-core`
packages and the `echodoc` library; the build warns when python-docx cannot be
imported. The runner accepts the new `documents` and `documentTarget` payload
fields and registers the `echo_document_*` tools only when the library and
namespace isolation are available. Echo requires the exact harness release, so
chat requests report that the agent is updating until the namespace matches.

Verify the rollout this way:
- Attach a .docx report and ask for the same report with new data: the answer
  links a new document whose preview keeps the template's headers and tables.
- Ask for a change in a follow-up: the document gets a new version and the
  previous one stays in its version list.
- A document request on the previous runner release is rejected as updating.

See [conversation documents](DOCUMENTS.md).

## Template reports and 4-hour Deep (release 2026.11.03.4)

The same release and upgrade as conversation documents above. The runner accepts the new budget tiers: Deep runs up to
4 hours (`maxRuntimeSeconds` 14400) with larger tool, API, provider-call and
event limits, and Fast or Balanced requests that build a document get 30 minutes
(`documentTask: true`). Deep requests queued before the deploy keep their
30-minute policy.

A Deep run holds its conversation and one of the twelve request slots for its
duration; since #4232 the user's other conversations run beside it in the same
container, or in a second one for another model backend. A backend restart or a lost worker lease fails running requests, so
deploys interrupt long Deep runs; the control panel's upgrade waits until the
namespace has no queued or running request.

Verify the rollout this way:
- Attach a .docx report and ask, in Balanced, for the same report from Echo data
  for a period: the policy shows `maxRuntimeSeconds` 1800 and `documentTask`
  true; the agent outlines the template, searches Echo for the period without
  the template's own callsigns, saves the filled document and links it.
- A Deep request's policy shows `maxRuntimeSeconds` 14400.

## Deep continuation of incomplete answers (release 2026.11.05.1)

Deploy the matching application, then upgrade the approved installation's
namespace with `ai-control-panel upgrade --host <host> --release 2026.11.05.1`,
previewing with `--dry-run` first. No migration or provider change is needed.
Echo requires this exact harness, so the chat reports that the agent is updating
until the namespace is upgraded, and the upgrade waits for the namespace to go
idle. Release `2026.11.03.4` stays in the compatible runner lists. Roll back the
application and harness as a pair.

The runner now emits `completion_metadata` for every answer that shows the
incomplete-coverage notice, with reason `incomplete_research` when no budget
limit was reached. Such answers gain the coverage footer, and admins see
`Неповне: incomplete_research`. Verify that a Balanced answer showing the notice
offers **Продовжити глибоким аналізом** both right after it finishes and after
reload, that clicking it queues a Deep request in the same conversation, and that
the composer stays on the remembered mode.

## WGS-84 and MGRS map points (release 2026.11.05.3)

Deploy the matching application, then upgrade the approved installation's
namespace with `ai-control-panel upgrade --host <host> --release 2026.11.05.3`,
previewing with `--dry-run` first. No migration or provider change is needed.
Echo requires this exact harness, so the chat reports that the agent is updating
until the namespace is upgraded. Releases `2026.11.05.2` and `2026.11.05.1` stay
in the compatible runner lists. Roll back the application and harness as a pair.

Verify that pasting `name,latitude,longitude` rows and MGRS references each
produces a map with every point in place, without format probing. Tool failures
log `AI agent tool failed` with the Rust level: `error!` for `tool_error`,
`network_error`, HTTP 5xx and `map_not_published`, `warn!` for
`invalid_arguments` and HTTP 4xx. The SigNoz severity field stays empty for
`wdintel-rs`, so filter on `body CONTAINS 'AI agent tool failed'`.

## Published bytes realigned (release 2026.11.07.1)

Release `2026.11.06.4` was published to the agent hosts before two commits changed the
harness under the same ID, so the merged code and the published bundle differ and
the panel refuses it as an ID collision. This release carries the merged code,
including those two group-scope fixes, under a new ID.

Deploy the matching application, then upgrade each namespace with
`ai-control-panel upgrade --host <host> --release 2026.11.07.1`, previewing with
`--dry-run` first. No migration or provider change is needed. `2026.11.06.4` stays in the
compatible runner lists. Roll back the application and harness as a pair.

## Group scope and failed first calls (release 2026.11.06.4)

Deploy the matching application, then upgrade the approved installation's
namespace with `ai-control-panel upgrade --host <host> --release 2026.11.06.4`,
previewing with `--dry-run` first. No migration or provider change is needed.
Echo requires this exact harness, so the chat reports that the agent is updating
until the namespace is upgraded. Release `2026.11.06.3` stays in the compatible runner
lists. Roll back the application and harness as a pair.

The application change also reaches people: a selection with no accessible group
now returns nothing instead of every accessible group. A saved filter or duty
column whose groups were all revoked or archived goes empty, and clearing the
filter restores it. Before deploying, count saved filters that name archived or
deleted groups; personal browser selections cannot be counted that way.

Verify on GLM-5.3 that a request naming a group shows `джерела «<group>»` in its
activity and cites only that group, and that an unknown group is reported as not
found. Research failures now log `failureKind` and `httpStatus` in the
`AI agent completion` diagnostic, and a retry shows as `outcome: continued`.

## Deep continuation that finishes the work (release 2026.11.06.3)

Deploy the matching application, then upgrade the approved installation's
namespace with `ai-control-panel upgrade --host <host> --release 2026.11.06.3`,
previewing with `--dry-run` first. No migration or provider change is needed.
Echo requires this exact harness, so the chat reports that the agent is updating
until the namespace is upgraded. Releases `2026.11.06.2`, `2026.11.06.1` and `2026.11.05.3` stay in the
compatible runner lists. Use `2026.11.06.3` everywhere: the two before it reached only
echo-staging. `2026.11.06.1` could say that tools did not run, and `2026.11.06.2` could
finish Deep without searching. Roll back the application and harness as a pair.

Balanced on non-OpenAI engines now runs up to 10 minutes and holds the user's
running slot that long; the composer shows the new limit. Verify on GLM-5.3 that a
short question about a callsign with no matches says that nothing was found, that a
map request reports its map, and that Deep shows no coverage notice or footer. Synthesis stays bounded
by each engine's `max_output_tokens` profile, so a host with 8,192 gains nothing
from the higher limit. `AI agent tool` log lines now name `update_research` and
`report_progress`, and validation failures add `fields`; use them to confirm which
constraint models actually break.
