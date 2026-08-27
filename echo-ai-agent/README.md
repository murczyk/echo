# Echo AI agent host harness

This package provisions one shared Incus host for isolated per-user Echo AI
agent containers. Multiple Echo deployments use the same VM with separate
dispatcher users, keys, namespaces, runtime homes, and instance ownership.

Follow [`DEPLOYMENT.md`](DEPLOYMENT.md) for the complete operator procedure,
including per-Echo dispatcher key creation, host-key pinning, configuration,
and validation.

The fixed template is
`echo-ai-agent-019fc7f7-9770-7f83-9c1a-211af29b02e6`. Child instances are named
`echo-ai-agent-<linked-login-uuid>`. The dispatcher accepts an optional UUIDv7
template override only when the corresponding instance is stopped and has
`user.echo.ai.template.ready=true`.
Ready templates are also bound to the installed `HARNESS_RELEASE`; a release
change cannot silently reuse stale runner or bootstrap code.

## Topology and limits

- Host: Debian 13 `amd64`, hostname `echo-ai-agent-vm`.
- Storage: Incus LVM-thin pool `ai-agents` on `/dev/sda2`.
- Network: `incusbr0`, `10.43.74.1/24`, NAT enabled, IPv6 disabled.
- Profile: 2 vCPU, 4 GiB RAM, 20 GiB thin root disk, 512 processes,
  `boot.autostart=false`.
- Container account: locked `echo`, pinned UID/GID `29720:29720`.
- Dispatcher: dedicated OpenSSH daemon on TCP 22031 with one key-only,
  forced-command Unix identity per Echo deployment.
- Capacity: at most six dispatcher-managed, non-template containers running at
  once. The host dispatcher enforces the limit under a lifecycle lock.

Containers can reach the public IPv4 internet. Nftables rejects direct
container traffic to the bridge host, RFC1918, Tailscale CGNAT, loopback,
link-local, multicast, and reserved networks. Incus MAC/IPv4 anti-spoofing and
NIC port isolation plus a bridge-family forward guard independently reject
same-bridge east-west traffic.
Only bridge DHCP and DNS are accepted on the host. Echo and internal vLLM
access instead use Incus proxy devices bound inside the instance:

- `127.0.0.1:18443` connects to the configured Echo TLS upstream. Container
  nginx listens on 443, and Echo's public hostname is mapped to loopback so TLS
  hostname validation remains intact.
- `127.0.0.1:18000` connects to the configured internal OpenAI-compatible
  vLLM upstream when direct HTTP transport is selected.

External OpenAI chat uses the existing TLS Echo route instead. Echo gives the
container a random, request-scoped capability rather than the provider token,
validates the active request, engine, and model on every call, injects the real
token server-side, and streams only the fixed OpenAI Chat Completions endpoint.
The capability is hashed in Redis, expires after 11 minutes, is limited to 256
calls, and is revoked with the request. Switching to this transport removes the
container's direct provider proxy.

The dispatcher resolves configured upstream hostnames to IPv4 before creating
Incus proxy devices. Echo's original public hostname remains mapped inside the
container so end-to-end TLS hostname validation is unchanged.

The firewall replacement is one checked nftables transaction. Container and
template autostart is disabled so a host reboot cannot start an agent before
isolation is active.

## Pinned inputs

[`versions.env`](versions.env) pins:

- Incus Debian/Zabbly package `1:7.3-debian13-202607310348`;
- Node.js `24.19.0` Linux x64 archive SHA-256
  `14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647`;
- `@earendil-works/pi-coding-agent` `0.83.0`, npm integrity
  `sha512-uYhF+FsZxogoSX/AxBcUdiY+ZklubwaXyAoEGA2eQwsHcyEAhUYIKh/WLXe/a8+k8eTCmxb+ZN2Zo9mzQtzbWw==`
  and tarball SHA-256
  `7097fe4b38762dda7ec78001e7b90430c849fbaf717325bfe8109744e32255e6`.

The complete Pi dependency graph and every registry integrity value are locked
in [`package-lock.json`](package-lock.json). Template construction downloads
and verifies the pinned Pi tarball separately, adds that exact archive to npm's
content-addressed cache, and then installs the locked graph with npm integrity
verification. It records the resolved Debian 13 image fingerprint in
`user.echo.ai.source_image` after applying current signed Debian security
updates.

## Host preflight and bootstrap

The audited staging disk uses an MBR/DOS partition table. `/dev/sda1` starts at
sector 2048, ends at sector 124999679, contains the root ext4 filesystem, and is
preserved. The remaining roughly 500 GiB region is unallocated. Preflight
recomputes the bounds from the live block device and accepts no partition other
than the expected `/dev/sda1` and owned `/dev/sda2`.

The first setup safely appends an aligned MBR partition 2 with type `0x8e` and
records its exact start and length in a root-only ownership marker. Before Incus
can initialize that partition, deployment rechecks the marker, partition
bounds, mounts, filesystem signatures, and existing LVM PV ownership. An
existing unmanaged or signed `/dev/sda2` is never reused.

Immediately before appending partition 2, setup saves a root-only, non-empty
`sfdisk --dump` copy at
`/var/lib/echo-ai-agent/sfdisk-before-sda2.dump`. A pre-existing backup must
match the still-unmodified table; it is never overwritten.

At audit time the main administrative SSH daemon used port 22031 and port 22
was free. The first setup recognizes only that exact bootstrap state, backs up
`/etc/ssh/sshd_config`, changes its single `Port 22031` directive to `Port 22`,
validates the configuration, reloads the main daemon, and verifies the new
listener. The existing setup connection survives the reload. The dedicated
dispatcher can then own 22031. The main administrative SSH service remains
enabled and is not managed by rollback.

Run local checks and the read-only bootstrap preflight first:

```bash
cd echo-ai-agent
just check
just preflight-bootstrap --server=echo-ai-agent-vm
```

Every mutating command requires an explicit dangerous-operation flag:

```bash
just setup --server=echo-ai-agent-vm --dangerously-acknowledge
```

The flag takes no value, is not a secret, and is not tied to an Echo server
namespace. It only confirms that the operator intends to run that command's
host mutation.

Run these commands from the operator checkout, not inside the VM. The required
`--server=echo-ai-agent-vm` parameter is the logical target: bootstrap resolves
it to the existing local SSH alias on port 22031, while post-setup operations
resolve it to `echo@echo-ai-agent-vm.eagle-atria.ts.net` on port 22. Any other
server value is rejected.

## Deploy and build the template

After setup reconnects successfully on port 22:

```bash
just preflight --server=echo-ai-agent-vm
just deploy-host --server=echo-ai-agent-vm --dangerously-acknowledge
just build-template --server=echo-ai-agent-vm --dangerously-acknowledge
just verify --server=echo-ai-agent-vm
```

Host deployment reconciles the storage pool, bridge, profile, firewall,
release symlink, and dedicated SSH daemon. Template construction is
fail-closed: an existing instance with the fixed name must already be the
expected stopped, ready template or the build refuses to replace it.

The Debian 13 template contains Node, the locked Pi installation, nginx stream
support, curl, DNS tools, Git, jq, Python, ripgrep, and basic inspection tools.
The `echo` OS account is password-locked and has the requested container-local
passwordless sudo. No SSH host keys or login service remain in the template.

## Dispatcher key and host-key pin

No private key is generated or copied to the agent VM. Generate a dedicated
private key on each Echo server, retain it there with mode 0600, and transfer
only its `.pub` file. Install or rotate a public key with its namespace:

```bash
just provision-key /secure/path/echo-staging-ai-agent.pub \
  --server=echo-ai-agent-vm \
  --echo-server=echo-staging \
  --dangerously-acknowledge
```

The host creates a separate Unix identity and root-owned namespace mapping for
each Echo server and rejects public-key reuse. The separate daemon disables
shell commands, PTYs, forwarding, tunnels, passwords, root, and user-controlled
environment. The forced-command wrapper derives the namespace only from the
authenticated Unix identity. Each identity receives an isolated mode-`0700`
runtime home recreated when the dispatcher starts.

Create the exact known-hosts entry before configuring Echo:

```bash
just host-key --server=echo-ai-agent-vm \
  > /secure/path/echo-ai-agent-known-hosts
```

The fingerprint is printed separately on stderr for operator comparison. Each
Echo server pins the same VM host key but uses its own dispatcher user, private
key, and namespace.

## JSONL protocol

The SSH client opens no remote command and writes one JSON object per line.
Every request has a caller-generated `id` and allowlisted `operation`.
Namespace comes exclusively from the forced SSH identity.

```json
{"id":"019fc...","operation":"status","agent_id":"019fc7f7-9770-7f83-9c1a-211af29b02e6"}
```

Non-streaming success ends with:

```json
{"id":"019fc...","ok":true,"done":true,"result":{}}
```

Runner events precede the terminal envelope:

```json
{"id":"019fc...","ok":true,"event":{"type":"assistant_delta","delta":"..."}}
```

Errors are bounded and contain no submitted payload or credential:

```json
{"id":"019fc...","ok":false,"done":true,"error":"..."}
```

Supported operations are `preflight`, `list`, `status`, `clone`, `start`,
`stop`, `destroy`, `stats`, `configure_proxies`, `run_request`, and
`test_connection`. UUID arguments must be lowercase UUIDv7. `clone` accepts
`agent_id` and optional `template_id`; proxy configuration accepts only a
validated Echo hostname, the fixed `direct_http` or `echo_gateway` transport,
and `host:port` upstreams for direct transport. Request execution invokes only
`/usr/local/bin/echo-ai-agent-runner`; there is no arbitrary command or argument
facility.

Cancellation closes or terminates the SSH child. The dispatcher then
terminates, waits for, and if necessary kills the `incus exec` process so a Pi
request is not orphaned.

## Pi runner contract

The backend sends a bounded camelCase payload:

```json
{
  "prompt": "...",
  "modelName": "google/gemma-4-26B-A4B-it",
  "providerTransport": "direct_http",
  "history": [{"role":"user","content":"..."}],
  "echoPublicHost": "echo-staging.example",
  "bootstrapToken": "single-use-token",
  "correlationId": "required-expected-uuidv7",
  "timeContext": {
    "timeZone": "Europe/Kyiv",
    "requestStartedAtUtc": "2026-08-04T12:00:00+00:00"
  },
  "skills": [
    {
      "method":"GET",
      "path":"/api/user",
      "skill":"current_user",
      "label":"Перевірка профілю користувача",
      "requestKind":"none"
    }
  ],
  "expectedIdentity": {"id":"...","name":"...","roles":["ApiAgent","Rer","Cyber"]}
}
```

The runner exchanges the single-use token at the fixed
`/api/ai-agent/bootstrap/exchange` route, captures the regular session cookie,
validates the returned UUIDv7 correlation ID, and sends both the cookie and
`X-Echo-Agent-Session` on subsequent requests. Secrets are never emitted.
Provider base URLs are not accepted in the payload: direct transport always
uses local port `18000`, while gateway transport is derived from the validated
Echo public hostname and the fixed `/api/ai-agent/provider/v1` path.

Each registry item becomes `echo_<skill>`. Only fixed GET and read-only POST
paths are accepted. Registry entries carry a localized activity label and a
typed request kind. Date-scoped analysis tools accept rolling hours, recent
Kyiv calendar days, or an explicit inclusive Kyiv date range plus optional
selected groups; the runner converts them to each endpoint's required
epoch-millisecond bounds. Callsign-frequency matching additionally requires
callsigns returned by another tool. Non-analysis POST tools may accept a
bounded JSON body. Harness routes,
redirects, arbitrary URLs, path traversal, other methods, built-in Pi shell,
read, write, and edit tools are unavailable. The only additional tool is
`report_progress`.

Route calls and progress reports share a fail-closed limit of 128 tool
invocations per request. Source events include a distinct display title plus
structured skill, method, registry path, and successful HTTP status fields.
They contain no request or response body, headers, cookies, or credentials and
do not expose a misleading clickable URL for POST-backed sources.

Echo remains canonical for history. The runner restores the supplied user and
assistant messages into an in-memory Pi session. Echo supplies each provider's
`contextWindow`, `maxTokens`, `compactionReserveTokens`, and
`compactionKeepRecentTokens` runtime profile. Pi compacts restored or active
context at that provider-specific threshold, while each tool response and the
aggregate tool context are bounded before they enter the session. The runner
also emits normalized
`assistant_delta`, `progress`, `tool_start`, `tool_update`, `tool_end`, and
`source` events. Progress-tool lifecycle events are suppressed because the tool
already emits its sentence. Route lifecycle events contain both their raw audit
identity and localized `toolLabel`. Raw Pi events are never forwarded, and all thinking/reasoning
events and content are explicitly discarded. The backend owns request-start,
completion, cancellation, and failure terminal events.

Connection testing performs the same bootstrap exchange, calls `/api/user`,
and emits its `{id,name,roles}` identity for backend validation and immediate
credential revocation.

## Operations and rollback

```bash
just status --server=echo-ai-agent-vm
just logs --server=echo-ai-agent-vm
just verify --server=echo-ai-agent-vm
```

`status`, `logs`, preflight, verification, and host-key inspection are
read-only. Rollback requires the dangerous-operation acknowledgement and switches to the
recorded previous immutable harness release, restores its firewall/SSH units,
and restarts only those two harness services:

```bash
just rollback --server=echo-ai-agent-vm --dangerously-acknowledge
```

Rollback deliberately retains `/dev/sda2`, LVM storage, containers, keys, and
the main admin SSH port 22. Removing any of them is a separate destructive
decommissioning operation and is not automated here. Before changing the
release symlink or services, rollback runs the previous dispatcher's read-only
preflight against the current fixed template. A release/template mismatch
fails closed and leaves the current release active; replacing a protected
template remains a separate, explicitly audited operation.

Release `2026.08.25.2` temporarily accepts runner handshakes from
`2026.08.25.1`, `2026.08.22.1`, and `2026.08.05.2` so namespaces can rotate
independently on the shared host. New templates and clones must use
`2026.08.25.2`; dispatcher
preflight attests that release, and status/list output exposes each instance's
`harness_release` for the rollout audit. Echo refuses to start an instance
whose release does not match its typed skill registry. Remove the
previous-release allowance only after every managed instance has been
recreated and verified.

Production Echo servers can be added without another VM or host rebuild; each
onboarding remains a separate authorized deployment action.
