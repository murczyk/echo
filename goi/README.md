# GOI

Deploy with `just deploy --server <server>`. Linux deploy artifacts are built
on `goi_builder` from `~/workspace/echo`; change the variable at the top of the
justfile or override it with `just deploy --server <server> --builder <builder>`.
Use `--fix` to force the deploy to pause GOI, remove `node_modules`, reinstall
dependencies, and start GOI again even when the pinned Node version is unchanged.

GOI deploy delegates the messenger build and deployment to
[`echo-messengers/justfile`](../echo-messengers/justfile). The messenger service
can also be deployed independently from that directory with
`just deploy --server <server>`. GOI deploy deactivates the legacy
`echo-swapp.service` and verifies that its process has stopped before deploying
`echo-messengers.service`.

The regular and first-deploy flows install and enable `redis-server`, require a
successful `redis-cli ping`, and only then deploy `echo-messengers`. Redis owns
chat unread state; durable chat history, ingestion watermarks, settings, and
webhook delivery state remain in PostgreSQL. If Redis is unavailable, the chat
history API stays online and the service retries Redis in the background.

GOI also manages the legacy Node services:
- port 4000: process goi, data a /etc/goi
- port 4002: process swapp, data at /etc/swapp
- port 4003: process swapp-alt, data at /etc/swapp-alt; it's another swapp instance, useful if you need 2 separate accounts like JF (1 account sends from goi, 2nd reads messages and resends them to different chats) 

## New Version Release

- download new version like `goi-1.3.3.zip`, unzip under `goi/goi/goi-1.3.3`
- edit `justfile` `goi_version`
- run `just release`
