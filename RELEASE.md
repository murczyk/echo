# Release process

A release has two phases, run from a clean `stable` checkout:

- **Prepare**: sync branches, bump the version, deploy to canary servers.
- **Make**: deploy to every other active server.

"Prepare release", "make release", and "prepare and make release" mean these
phases.

## Approval

A user message asking for a phase approves exactly that phase's operations and
targets, as AGENTS.md allows. Prepare covers pushing `stable` and `main`, and
deploying the canaries. Make covers deploying the remaining active servers.

Everything else still needs separate approval, including:

- `just deploy-docs`;
- `just ai-control-panel upgrade` and other harness changes;
- configuration changes, one-off commands, and resnapshots from 👷 changelog
  entries;
- rollbacks and recovery from a failed deploy.

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
   `echo-cbr-staging`, `echo-kharkiv2`. Check logs after each one (see
   [Checking a server](#checking-a-server)).

   ```bash
   just deploy --server <server>             # CI built the deb
   just deploy-from-local --server <server>  # CI did not build it
   ```

   `just deploy` refuses to run on `main`.

7. Report the version, the canary results, the `👷`/`🚨` entries, and any harness
   upgrade notices.

## Make

Deploy every server in `just servers-active` that is not a canary, one by one,
in the listed order. Check logs after each one before starting the next. Use
`just deploy` or `just deploy-from-local` as in Prepare. Do not use
`just deploy-many`, because it leaves no log check between servers.

For "prepare and make release", start Make straight after Prepare if the
canaries are clean.

## Checking a server

Wait about 5 minutes after the deploy so there is real traffic in the logs.

1. Confirm the deploy printed `✅✅✅ deploy OK`.
2. Read the AI harness notice at the end of the deploy output. If it says an
   upgrade is needed, the server's AI chat may stay unavailable until the
   upgrade, so report it.
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

Compare with the pre-deploy period, because some errors are existing noise.

## Stopping

Stop the rollout and report if a deploy fails, new errors appear, or a service
is unhealthy. Do not deploy further servers or start recovery without approval.

## Notifications

Run `just notify "<text>"` after each long successful step:

- the CI build finished;
- each server is deployed and its logs are checked;
- the phase is complete.

Also send one when the rollout stops on a problem.
