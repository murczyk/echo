# Echo AI agent deployment

One `echo-ai-agent-vm` serves every Echo deployment. Run section 1 once, then
repeat sections 2–6 for each authorized Echo server with a separate key and
namespace.

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
