# Echo Messengers

Echo Messengers provides the messenger integration API and workers. It is a
standalone workspace package deployed as `echo-messengers.service` with its
configuration in `/etc/echo-messengers/config.toml`.

Build and package locally:

```bash
just build-local
just package-local
```

Build on the configured builder and deploy independently:

```bash
just deploy --server <server>
```

Override the builder or branch when needed:

```bash
just deploy --server <server> --builder <builder> --branch <branch>
```

The deploy migrates an existing `/etc/echo-swapp/config.toml`, deactivates the
legacy `echo-swapp` service/process, and installs the Signal and WhatsApp
runtime packages.

See [API.md](API.md) for the HTTP API.

## Chat administration

The `Чати` tab is available when at least one active `echo_client` has
`show_chats_admin_panel = true`. Each enabled client has private/group
allowlist or denylist settings, optional replacement/removal of webhook URLs,
and a `Store data for 30 days` retention switch. Stored webhook URLs are never
returned by the API.

Unread IDs use versioned Redis keys bound to the account link timestamp.
PostgreSQL chat history remains available when Redis is down; unread counts and
read mutations report that degraded state, and ingestion replays from its
durable PostgreSQL watermark after Redis reconnects. Redis is installed and
health-checked by the deploy recipe.

Inbound webhook events are JSON with `version`, stable `eventId`, opaque
`chatId`, and the same version-1 message DTO returned by chat history. The DTO
includes attachment metadata and scoped URLs but never attachment bytes.
Network and non-2xx failures retry with bounded exponential backoff; terminal
failures remain in `echo_chat_webhook_delivery.failed_at` for diagnostics.
Targets must use credential-free HTTPS and resolve only to public IP addresses;
delivery pins the validated DNS result and does not follow redirects.

Outbound chat media is stored under
`/var/lib/echo-messengers/chat-attachments`. The package creates that directory
with service ownership. Enabling 30-day storage retains seen inbox messages,
all inbox/outbox messages, and sent outbound media, then restarts the client
worker. A failed restart is returned to the UI and retrying the same save is
safe.

Diagnostics:

```bash
redis-cli ping
systemctl status redis-server echo-messengers --no-pager
journalctl -u echo-messengers -n 200 --no-pager
```
