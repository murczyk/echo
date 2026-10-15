# Messenger alerts

In `/admin/users-neo`, link a login to an existing **Профіль в месенджері**.
The profile ID is `signal_profile.uuid`, including WhatsApp IDs ending in a
messenger domain. Clearing the field removes the link. Both regular and Delta
logins support it.

The user must enable **Отримувати сповіщення в месенджері** under
Settings → Profile. An absent or NULL preference means false.

In `/admin/messenger-neo`, edit an account to permit reading and/or sending.
NULL reading permission means true; NULL sending permission means false.
Reading permission controls importing messages into Echo. Echo IM continues
its protocol sync and outbound delivery for an active account when importing
is disabled. Pausing an account stops its worker.

The second tab, **Відправка**, enables alerts and configures an ordered list
of senders that permit sending. Saving enabled alerts without senders is
allowed; the warning banner explains why sending is disabled. Each recipient
uses the first active, linked account of the matching messenger type.

Selecting **Сповістити всіх?** while marking a message important creates
messenger deliveries for eligible in-app mention recipients. The actor is
excluded. Eligibility includes the current group, organization, role and
secret-group access rules, a linked profile, and the user's opt-in. Eligibility
and configuration are checked again before handing a delivery to Echo IM.
Old mentions are not sent retroactively when alerts are enabled.

Each private message contains only:

`Вітаю! Вас згадано у важливому повідомленні, посилання: {URL}`

The URL uses `public_host` and `/rer-analysis-neo?m=…`, preferring the message
UUID, then its message UID, as the Analysis copy-link action does.

Deliveries are durable and unique per notification receipt. The background
worker queues through `echo_im::send_message`, observes its outbox, and records
**Надіслано** only after a successful send. Failed or expired attempts use the
next compatible sender. A still-scheduled attempt is expired after 90 seconds
before trying another sender. An attempt already claimed by Echo IM waits for
its outcome or Echo IM's claim recovery, preventing simultaneous fallback sends.
An unknown/missing outbox result fails the delivery rather than guessing.

The history uses the shared Reports table, 20 rows per page, with cursor-based
pagination. **Оновити** returns to the newest page and refreshes statuses.
Failed deliveries retain their status for inspection; they are not silently
requeued after the configured senders are exhausted.

## Deployment

**Deploy the updated WhatsApp runtime before enabling WhatsApp alerts.**
Echo pins [Echo IM `0.1.1-rc.202610151157` (`06ac238`)](https://github.com/echoua/echo-im/commit/06ac23803f4dbc7bc5e9db471609e89703870125),
which adds private WhatsApp recipient routing and atomic queue claims for both
messengers. These claims prevent canceled or already claimed snapshots from
being sent. Failed Signal attempts can have a timestamp; only transport success
or a received acknowledgment marks a delivery sent.

Install `echo-im-whatsapp` version `0.1.1-rc.202610151157` on Echo hosts,
and restart their `echo-whatsapp-bot@…` instances before enabling
WhatsApp senders. The Signal claim fix is included in the rebuilt Echo binary.
No Echo IM schema or Rust API changes are required.

```bash
cd "$ECHO_IM_CHECKOUT/echo-im-whatsapp/whatsmeow/echo-whatsapp"
go test -vet=off -run Echo3610 -count=1 ./...
go build -o "$ECHO_IM_CHECKOUT/echo-im-whatsapp/deploy/whatsapp-cli" .
cd "$ECHO_IM_CHECKOUT"
cargo test -p echo-im echo_3610
```

Set `ECHO_IM_TEST_DATABASE_URL` to a dedicated `wd_test_…` PostgreSQL database
for those tests. They create and remove an isolated schema. The `-vet=off` flag
avoids existing logging-format vet failures elsewhere in the Go package.

Run the normal migration/deployment sequence. The analytics impact declaration
requests targeted snapshots of `login`, `datasource`, and `user_settings` to
publish their nullable columns, without rebuilding the large message tables.
The alert settings and delivery tables are excluded from analytics; deployment
must synchronize the packaged exclusions before applying migrations.

Alerts remain disabled until an administrator configures the sending tab and
users opt in. Configure `public_host` as the externally reachable Echo host.
