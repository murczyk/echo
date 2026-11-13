# Release process

A release has two phases, run from a clean `stable` checkout:

- **Prepare**: sync branches, bump the version, deploy to canary servers and
  upgrade their AI harness.
- **Make**: deploy to every other active server and upgrade its AI harness.

"Prepare release", "make release", and "prepare and make release" mean these
phases. "Prepare stable release", "make stable release", and "prepare and make
stable release" release what is on `stable` without merging `main`; see
[Stable release](#stable-release).

## Approval

A user message asking for a phase approves exactly that phase's operations and
targets, as AGENTS.md allows. Prepare covers pushing `stable` and `main`,
deploying the canaries, and upgrading their AI harness. Make covers deploying
the remaining active servers and upgrading their AI harness. A stable release
covers the same, except that its Prepare pushes only `stable`.

Everything else still needs separate approval, including:

- `just deploy-docs`;
- harness changes other than the upgrade `just deploy` runs;
- configuration changes, one-off commands, and resnapshots from 👷 changelog
  entries;
- rollbacks and recovery from a failed deploy or harness upgrade.

## Prepare

1. Merge `stable` into `main`. This is usually only a check, or just the
   previous release's bump commit:

   ```bash
   git switch stable
   git fetch origin
   git log --oneline origin/main..origin/stable
   ```

   If the log is not empty, merge `stable` into `main` and push `main`.

2. Merge `main` into `stable`, without pushing:

   ```bash
   git pull --ff-only origin stable
   git merge --ff-only origin/main
   ```

   Do not push yet: every `stable` push builds packages, so the merge and the
   bump should go out together.

3. Check that CI passed on the `main` head. Builds from `stable` skip the tests,
   so this is their only test run. List the `👷` and `🚨` entries this release
   adds, for the final report:

   ```bash
   git diff origin/stable origin/main -- CHANGELOG.md | grep -E '^\+.*(👷|🚨)'
   ```

4. Bump the version and push. CI then builds the deb:

   ```bash
   just bump-version-push
   ```

5. Wait for the `CI Build Test and Publish (amd64)` run for that commit:

   ```bash
   gh run list --limit 20 --json databaseId,headSha,status,conclusion
   gh run watch <run-id> --exit-status
   ```

6. Deploy the canaries one by one, in this order: `echo-staging`,
   `echo-cbr-staging`, `echo-kharkiv2`. The deploy also upgrades the server's AI
   harness (see [Upgrading the AI harness](#upgrading-the-ai-harness)). Check
   logs after each one (see [Checking a server](#checking-a-server)).

   ```bash
   just deploy --server <server>             # CI built the deb
   just deploy-from-local --server <server>  # CI did not build it
   ```

   `just deploy` refuses to run on `main`.

7. Report the version, the canary results, the harness release on each canary,
   and the `👷`/`🚨` entries.

## Make

Deploy every server in `just servers-active` that is not a canary, one by one,
in the listed order. Check logs after each one before starting the next. Use
`just deploy` or `just deploy-from-local` as in Prepare. Do not use
`just deploy-many`, because it leaves no log check between servers.

For "prepare and make release", start Make straight after Prepare if the
canaries are clean.

## Stable release

A stable release ships what is already on `stable`, for example a hotfix while
`main` holds work that is not ready. It never merges `main` into `stable` and
leaves `main` untouched. The next normal release brings `stable` back into
`main` in Prepare step 1.

"Prepare stable release" replaces Prepare steps 1 to 3 with these two steps, then
continues from Prepare step 4:

1. Update `stable` and list what came after the last bump:

   ```bash
   git switch stable
   git pull --ff-only origin stable
   last_bump=$(git log -1 --format=%h --grep='^bump: ')
   git log --oneline "$last_bump"..
   git diff "$last_bump" -- CHANGELOG.md | grep -E '^\+.*(👷|🚨)'
   ```

   If the log lists only `[skip ci]` commits, the last bump's deb already is this
   release, so also skip Prepare steps 4 and 5.

2. Check that each listed commit passed the tests. Builds from `stable` skip
   them, so that run is on the commit's PR or on `main`, and a commit pushed
   straight to `stable` has none. Report any such commit with the `👷`/`🚨`
   entries.

"Make stable release" is [Make](#make) as written, because Make merges nothing.
For "prepare and make stable release", start it straight after Prepare if the
canaries are clean.

## Upgrading the AI harness

Echo requires the exact harness release its running application was built for.
Until they match, every AI chat request on that server fails.

`just deploy` and `just deploy-from-local` upgrade the harness themselves,
straight after the application: they preview the upgrade to the release the
application requires, run it, and check again. Run deploys from the release
checkout, because the upgrade uses its harness bundle and control panel. No
local Rust build is needed.

A deploy that synced the harness ends with
`AI harness: <server> is current (<release>; …)`, or `not configured … skipped`
on servers without AI agents. If the harness could not be synced, the deploy
prints `🔴🔴🔴` after `✅✅✅ deploy OK` and exits 1. The application is deployed,
but AI chat on that server stays down until the harness matches:

- Queued or running AI requests on the server block the upgrade. Steps that
  find the agent VM busy with other servers' requests wait and retry on their
  own. If an upgrade still fails, the panel recovers the previous containers.
  When the restored harness doesn't match the running Echo build, AI stays
  disabled and the error says so.
- The retry, once the VM is quiet or the cause is fixed, finishes the upgrade
  and switches AI back on. It is recovery from a failed harness upgrade, so it
  needs approval:

  ```bash
  python3 deploy/ai-control-panel/deploy-notice.py --sync <server>
  ```

After a deploy that upgraded the harness, confirm AI is still on:

```bash
just ai-control-panel scan --host <server> --json 2>/dev/null | grep '^{"hosts"' | python3 -c 'import json,sys; print(json.load(sys.stdin)["hosts"][0]["enabled"])'
```

The scan must print `True` unless AI was already off on that server before the
upgrade.

## Checking a server

Wait about 5 minutes after the deploy so there is real traffic in the logs.

1. Confirm the deploy printed `✅✅✅ deploy OK`.
2. Confirm the deploy ended with the AI harness current or not configured. If
   it printed `🔴🔴🔴` instead, stop and report it (see
   [Upgrading the AI harness](#upgrading-the-ai-harness)).
3. Read the service logs. Match the level in the text: the services log to stdout,
   so `journalctl -p warning` shows nothing even when there are errors.

   ```bash
   ssh <server> 'sudo journalctl --since "-10 min" --no-pager -o cat \
     -u wdintel-rs -u wdintel-rs-bgworker -u wdintel-rs-report-worker -u wdintel-py \
     | grep -E "\b(ERROR|WARN|WARNING|CRITICAL)\b|panicked" | tail -n 100'
   ```

4. Query SigNoz if the logs are unclear or you need to compare with the period
   before the deploy. Hosts are usually `ct-<server>`, and
   [MONITORING.md](docs/MONITORING.md#for-agents-over-ssh) has the queries.

5. If the host rebooted since the last check, confirm PostgreSQL bound its
   addresses. See
   [After a host reboot](deploy/clickhouse/README.md#after-a-host-reboot).

Compare with the pre-deploy period, because some errors are existing noise.

## Stopping

Stop the rollout and report if a deploy or harness upgrade fails, new errors
appear, or a service is unhealthy. Do not deploy further servers or start
recovery without approval.

## Notifications

Run `just notify "<text>"` after each long successful step:

- the CI build finished;
- each server is deployed and its logs are checked;
- the phase is complete.

Also send one when the rollout stops on a problem.
