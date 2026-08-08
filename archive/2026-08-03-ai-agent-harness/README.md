# AI agent harness implementation record — 2026-08-03

Reusable host tooling and current operations are maintained in
[`echo-ai-agent/README.md`](../../echo-ai-agent/README.md). This archive records
the inputs and repository implementation prepared for issue
[#2972](https://github.com/echoua/echo/issues/2972).

## Scope

Stages 0–3 are scoped to `echo-staging` only. The host bundle provides an
Incus LVM-thin pool, isolated bridge and resource profile, fixed Debian 13
template, restricted SSH JSONL dispatcher, instance-bound Echo/vLLM proxies,
and a locked-down Pi SDK runner. It contains explicit preflight, setup, host deploy,
template build, verification, status, logs, public-key provisioning, host-key
pinning, and non-destructive release rollback commands.

The host foundation and fixed template were deployed and verified on
`echo-ai-agent-vm` for `echo-staging`. No production host was modified. No
commit or push was made.

The repository bundle is now release `2026.08.03.11`; its operator commands
require the explicit logical target `--server=echo-ai-agent-vm`, and mutating
commands require the value-free `--dangerously-acknowledge` flag. It supports
separate dispatcher identities for multiple Echo namespaces on the shared VM.
The staging deployment evidence below remains for installed release
`2026.08.03.8`; `.10` has not been deployed or used to rebuild the protected
template.

## Audited staging inputs

The observed target facts used to construct fail-closed guards were:

- hostname `echo-ai-agent-vm`, Debian 13, `amd64`;
- administrative OpenSSH listening on TCP 22031, with TCP 22 free;
- `/dev/sda` using an MBR/DOS partition table;
- only `/dev/sda1`, sectors 2048–124999679, containing the mounted ext4 root;
- disk ending at sector 1182793727, leaving roughly 500 GiB unallocated after
  partition 1;
- Incus initialized with no storage pools, only physical `ens18`/`lo`
  networks, and an empty default profile;
- installed Incus package `1:7.3-debian13-202607310348` from the configured
  Zabbly repository.

The setup therefore preserves partition 1, appends an aligned MBR partition 2
of type `0x8e`, and records its ownership before any LVM initialization. It
also migrates only the recognized main-SSH bootstrap configuration to port 22
before dedicating port 22031 to the forced dispatcher.

## Staging deployment evidence

The guarded setup, host deployment, template build, and verification commands
were run on 2026-08-03 with the explicit `echo-staging` confirmation:

- administrative SSH was moved from port 22031 to port 22 while retaining its
  previously pinned host identity;
- `/dev/sda2` was created only in the audited free region, starting at sector
  `124999680`, with `1057794048` sectors (`541590552576` bytes); `/dev/sda1`
  remained unchanged;
- the root-owned mode-`0600` storage marker records that exact geometry;
- Incus uses the sole `/dev/sda2` PV, VG `ai-agents`, thin pool
  `IncusThinPool`, bridge `incusbr0` at `10.43.74.1/24`, and profile
  `echo-ai-agent` with 2 vCPU, 4 GiB memory, 20 GiB root storage, and 512
  processes;
- the profile disables guest API, nesting, privilege, and IPv6 and enables
  IPv4/MAC filtering and same-bridge port isolation; nftables independently
  rejects host/private/link-local/Tailscale and bridge east-west traffic;
- immutable host release `2026.08.03.8` is installed root-owned and
  non-group/world-writable. Before changing the active release, rollback now
  runs the previous dispatcher's read-only template preflight and fails closed
  if that release is incompatible with the current template;
- the dedicated public-key-only dispatcher is active on port 22031. Its host
  key fingerprint is
  `SHA256:rjHPROUE2mEfdM51qbC6tP2O4NvUmk2laKm4J67vcpg`, and the installed
  `echo-staging` client public key fingerprint is
  `SHA256:QYsdBGb0OGrPW/hUiKrtVRVsMIHp8zDdPMGxPEQzhJI`;
- no private dispatcher key was generated on or copied to the agent VM by this
  work; the existing root-only key and known-hosts files on `echo-staging`
  were used for live protocol verification;
- fixed template `echo-ai-agent-019fc7f7-9770-7f83-9c1a-211af29b02e6` is
  stopped, protected from deletion, attached only to the dedicated profile,
  and attested ready for release `2026.08.03.8`, Node `24.19.0`, Pi `0.83.0`,
  disabled guest API, and container user UID/GID `29720:29720`;
- superseded unused templates, including `.6` and `.7`, were removed only after
  proving each was the sole stopped instance with no dispatcher-managed
  children; the final template was genuinely rebuilt from release `.8`, never
  relabelled;
- a live attempted rollback through the previous `.7` dispatcher refused the
  incompatible `.8` template before changing the active-release symlink, which
  remained on `.8`;
- live calls from `echo-staging` returned a successful empty `list` and a
  successful `preflight` reporting Incus client/server `7.3`, the exact ready
  template, and `running=0`, `max_running=6`;
- caller-supplied namespace and arbitrary SSH command attempts were rejected;
- a disposable namespace-owned container completed clone, status, start,
  proxy configuration, stats, stop, and destroy through the dispatcher. Its
  expanded configuration showed the dedicated profile, 2 vCPU, 4 GiB, 20 GiB,
  512-process limits, MAC/IPv4 filtering, port isolation, and two
  instance-bound loopback proxies;
- in that running clone, `/dev/incus/sock` was absent, the `echo` UID/GID was
  `29720:29720`, and the public Echo hostname resolved to `127.0.0.1`. Echo via
  the local TLS stream proxy returned HTTP 401 as expected without a session,
  vLLM via `127.0.0.1:18000/v1/models` returned HTTP 200, and ordinary public
  internet returned HTTP 200. Direct connections to the Echo/vLLM Tailscale
  addresses and bridge-host SSH were blocked. The disposable instance was then
  stopped and destroyed, and the final dispatcher list was empty;
- the final remote verification passed with `running=0/6`. Local harness
  checks passed 19 dispatcher tests, four rollback-compatibility tests, nine
  runner tests, explicit server-target tests, shell syntax and shellcheck,
  checksum/lock validation, and partition, Incus metadata, and LVM fixtures.

## Pinned template inputs

- Node.js `24.19.0` Linux x64 SHA-256
  `14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647`;
- `@earendil-works/pi-coding-agent` `0.83.0` registry SHA-256
  `7097fe4b38762dda7ec78001e7b90430c849fbaf717325bfe8109744e32255e6`;
- npm integrity
  `sha512-uYhF+FsZxogoSX/AxBcUdiY+ZklubwaXyAoEGA2eQwsHcyEAhUYIKh/WLXe/a8+k8eTCmxb+ZN2Zo9mzQtzbWw==`;
- fixed template name
  `echo-ai-agent-019fc7f7-9770-7f83-9c1a-211af29b02e6`;
- bridge `10.43.74.1/24`, IPv6 disabled;
- maximum six running managed agents.

## Security decisions

- Namespace is derived from a dedicated forced SSH user and never trusted from
  JSON input.
- Only a staging public key is installed on the agent host; private material
  stays on the Echo server. The separate dispatcher has its own pinned host
  key.
- Dispatcher operations and arguments are allowlisted, UUIDv7-scoped, and
  restricted to namespace-owned instances.
- Agent execution has no arbitrary host/container command path. Cancellation
  tears down the fixed `incus exec` child.
- Container egress to host, private, link-local, and Tailscale networks is
  rejected. Only instance-bound proxies can reach Echo and vLLM.
- The Pi SDK exposes only route-registry GET/read-only-POST tools and
  one-sentence progress. Built-in shell and file tools are disabled.
- Single-use bootstrap credentials are exchanged for a session cookie; every
  Echo call carries its correlation header. Tokens and cookies never enter
  SQL, events, or dispatcher errors.
- Hidden reasoning is discarded at the runner boundary.
- Successful Echo source events retain only skill, method, registry path, and
  HTTP status for the canonical audit trail; request/response bodies, headers,
  cookies, credentials, and raw Pi payloads are excluded.
- Request timeout, worker shutdown, and restart recovery revoke credentials,
  disable the linked identity, and reconcile any abandoned physical instance
  without cancelling later queued messages. Maintenance retries stale
  creating, starting, stopping, and error states only after acquiring the
  per-user lifecycle lock and rechecking active work.

## Echo staging deployment

The application was initially deployed on 2026-08-03 and redeployed from the
final reviewed tree on 2026-08-04 with
`just deploy-from-local --server=echo-staging`. The package installation,
ClickHouse table-exclusion reconciliation, migration, systemd restarts, port
8081 check, and analytics health check completed successfully. The deployed
migrations are recorded once, all ten `ai_agent_*` tables exist, and an
unauthenticated request to `/api/ai-agent/configuration` returns HTTP 401.

The dispatcher host, port, user, and `echo-staging` namespace were imported
into the singleton `ai_agent_dispatcher` database row. The legacy TOML section
was removed after verification and is recoverable from
`/etc/echo/config.toml.before-ai-agent-dispatcher-db-20260804T101700Z`; the
root-owned private key and pinned known-hosts file remain at their fixed paths.
Live dispatcher `preflight` and `list` calls after the migration report the
ready fixed template, Incus client/server 7.3, `running=0`, `max_running=6`,
and no managed instances.

The enabled tokenless Gemma router engine
`019fc79a-d3dc-79a2-8523-a55612920ec4` is the sole allowed and default engine
and is prepared as the reviewer. The staging Echo proxy maps
`echo-staging.eagle-atria.ts.net` to `100.64.145.127:443`. Direct health probes
returned HTTP 200 from the vLLM models endpoint and the expected unauthenticated
HTTP 401 from Echo `/api/user`. One and only one background worker holds the AI
agent PostgreSQL singleton lease. After the final deployment, the socket,
background worker, and report worker were active with zero restarts, and the AI
agent worker log contained its successful lease acquisition and no warnings or
errors.

The fixed `ai-agent` template login was reconciled to its configured UUID. It
is disabled, passwordless, has password authentication disabled, and has
exactly the `ApiAgent`, `Rer`, and prepared `Cyber` roles. The user-facing
feature and security review are enabled and the Mattermost webhook is
configured. No requests, reviews, linked users, or containers were created.

## Pending staging acceptance

Acceptance still requires an authorized authenticated effective-`Rer` test
user. Until then, the complete Ziggy workflow remains pending: authenticated
Echo reads through the instance proxy, streamed Pi/vLLM tool calls, request and
audit persistence, asynchronous review and redacted Mattermost delivery,
five-minute idle stop, history-preserving restart, and test-mode seven-day
cleanup.

Production rollout requires separate authorization after that evidence is
recorded.

## Kharkiv2 follow-up — 2026-08-08

Current onboarding instructions, including cross-tailnet prerequisites and
the Echo build-host distinction, are maintained in
[`echo-ai-agent/DEPLOYMENT.md`](../../echo-ai-agent/DEPLOYMENT.md).

`echo-kharkiv2` was added to the shared agent host as the isolated
`echo-kharkiv2` namespace with forced dispatcher identity
`echo-ai-agent-kharkiv2`. Its client key fingerprint is
`SHA256:ToqqD0rlJB5UaKkcZd7kGGUUTvLk0oJDBUFmrOKLVoE`; the private key remains
root-only on the Echo host. Live profile validation passed through the pinned
dispatcher and through the HTTPS Echo proxy
`echo-kharkiv2.comet-vernier.ts.net` to `100.72.214.105:443`.

The sole allowed/default/reviewer engine is the enabled tokenless Gemma router
engine. The AI-agent feature remains disabled. Its security-review pipeline
and CBR Mattermost webhook are configured for later activation, while
Mattermost chat monitoring is disabled. The fixed passwordless template login
has exactly `ApiAgent`, `Rer`, and `Cyber` roles. The CBR-tuned callsign prompt
is enabled with MD5
`a939a0436cd0340feef3651ba3d7d376`, and its worker uses the same Gemma engine.
Final host verification reported five dispatcher identities and
`running=0/6`; Echo had zero linked users, containers, conversations,
requests, or reviews. No end-user harness workflow was created for this
infrastructure-only onboarding.
