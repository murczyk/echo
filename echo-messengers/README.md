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
