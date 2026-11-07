# Development

## Checking a change on staging as a real user

`issue-session` prints a session cookie for a staging host, so a deployed change
can be checked in a real browser without a password or a pasted cookie:

```bash
umask 077
ssh echo-cbr-staging 'sudo wdintel-rs --mode=live issue-session --login ziggy' \
  | grep '^id=' > "$scratch/session-cookie"
```

The cookie is the one `id=<value>` line on stdout. If `grep` finds none, the
command failed: read its output instead of using the file.

The command starts the session through the server's real login code and session
middleware, so it behaves like a normal session once issued. It skips the
password and 2FA, which is why it only runs on staging. Disabled and deleted
accounts are still refused.

Use it with `curl -b "$(cat "$scratch/session-cookie")"`, or in Playwright:

```ts
await context.addCookies([
  { name: 'id', value, domain: host, path: '/', secure: true, httpOnly: true },
]);
```

Rules:

- It only runs on staging. It refuses any host whose `public_host` does not start
  with a `*-staging` name, and there is no override. Do not add one, and do not
  reproduce it by hand on production: a session there is a real login to a real
  account.
- It changes a real environment, so it needs approval naming the host and the
  login, as [AGENTS.md](./AGENTS.md) requires. Use only an account its owner
  named.
- Keep the cookie in a private file outside the checkout, with `umask 077`. Never
  print it or put it in a commit, a PR, a log or a chat. Codex and other review
  tools read the checkout and send it elsewhere.
- Log out when finished: `GET /api/user/logout` with the cookie ends that session
  only. Otherwise it expires after 12 idle hours.

`sudo` records who ran the command, in the host's auth log.

## What a staging check has to prove

A check counts only if it reaches the changed code. Before relying on one, work
out which code path the test data takes, and prove that the check fails without
the change.

For example, encrypted media inside the 24-hour retention window is served from
a local decrypted copy and never reaches the decrypt path. The first check for
[#4006](https://github.com/echoua/echo/issues/4006) passed for that reason, and
the failure appeared a day later. See
[messenger media delivery](./docs/messenger-media-delivery.md).
