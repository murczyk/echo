# vLLM Router deployment — 2026-08-03

This is the historical record of the `echo-vllm-router` audit and deployment.
Reusable assets and current operator commands are maintained in
[`echo-vllm-router/README.md`](../../echo-vllm-router/README.md).

## Audited state

At audit time, `ct-echo-vllm-router` was a Debian 13 `amd64` systemd host with
Python 3.13.5 and Tailscale IP `100.105.172.96`. Ports 8000 and 29000 were
unused, no router users, paths, or services existed, and passwordless sudo was
available. `python3-venv` was absent and was installed from Debian together
with its standard pip/setuptools wheel dependencies.

The host reached the live Spark worker at `100.92.119.117:8000` and SigNoz
OTLP at `100.71.235.10:4317`. Spark returned healthy `/health`, exposed
`google/gemma-4-26B-A4B-it` from `/v1/models`, and exposed `vllm:*` metrics.
The live backend was not stopped or reconfigured.

## Decisions and deployed inputs

- vLLM Router `v0.1.15`, tag commit
  `1fbcde7443d75b36befb61bc081f64c2a1f13a4b`;
- x86-64 wheel SHA-256
  `2f268b001a546d7921c2e87b510869134a212f0ab2faf138b78eb554c93a2241`;
- fully hashed Python 3.13 dependency lock SHA-256
  `6ce45e202bd0aea85e6b1b9617493aa55610da784455608a85d17ea154e8c50b`;
- SigNoz OTel Collector `v0.144.6`, archive SHA-256
  `a02e2e3ad4a2a62db7ca50c145d1cfcd4e9decaefb34b5565366ab81092fe374`;
- extracted collector binary SHA-256
  `54342207662b7ebe76e7c0c6eb099d64f07929169b5476873c2769b32c7be979`;
- `cache_aware` routing with sole initial worker
  `http://100.92.119.117:8000`;
- router API `100.105.172.96:8000` and loopback-only metrics
  `127.0.0.1:29000`;
- native systemd services under separate unprivileged users;
- Tailscale transport with no additional router token or TLS;
- two OTel metrics pipelines with distinct router/worker resource attributes;
- no dashboard changes and no automated Echo database/settings changes.

## Actions performed

The pinned artifacts were downloaded and checksum-verified locally, copied to
a target-side temporary directory, and verified again before installation.
The deployment created `echo-vllm-router` and `echo-vllm-router-otel`, installed
the immutable Python environment and verified collector, copied the runtime
configuration and hardened systemd units, and enabled both services.

The first start exposed two deployment-package defects: moving a newly created
Python virtual environment left its console-script shebang pointing at the
removed temporary path, and the collector's Sonic JSON loader could not run
under `MemoryDenyWriteExecute`. Both restart loops were stopped. The installer
was corrected to create immutable environments at their final path, and the
collector unit retained its other hardening while removing that incompatible
directive. The idempotent deployment was rerun successfully.
An additional deploy completed with unchanged systemd invocation IDs,
confirming that an unchanged package does not restart either service.

## Final verification

Final verification completed at 2026-08-03 12:08 UTC:

- `echo-vllm-router.service` and `echo-vllm-router-otel.service` were enabled,
  active, and running;
- installed router version was `0.1.15` and the collector binary matched its
  pinned SHA-256;
- the only planned listeners were `100.105.172.96:8000` and
  `127.0.0.1:29000`; no collector port 8888 listener existed;
- router `/health`, `/v1/models`, and Prometheus metrics passed;
- `echo-cbr` reached router health and models over Tailscale;
- a Chat Completions smoke request sent from `echo-cbr` returned model
  `google/gemma-4-26B-A4B-it`, finish reason `stop`, and content `OK.`;
- SigNoz `signoz_metrics.time_series_v4` contained current
  `vllm_router_*` series with `service.name=vllm-router`,
  `service.instance.id=ct-echo-vllm-router`,
  `host.name=ct-echo-vllm-router`, and `echo.vllm.role=router`;
- the same store contained current `vllm:*` worker series with
  `service.name=vllm-worker`, `service.instance.id=echo-gpu-spark`,
  `host.name=echo-gpu-spark`, and `echo.vllm.role=worker`.

SSH to `echo-cbr-staging` still failed with `Permission denied (publickey)`.
Its HTTPS application and admin routes were reachable, but no authenticated UI
session was available for the required staging engine edit and request. The
staging and production Echo AI engine settings were therefore left unchanged;
production rollout must wait for restored SSH access or a recorded manual
staging UI verification.

## Kharkiv2 follow-up — 2026-08-08

Reusable client-onboarding commands are maintained in
[`echo-vllm-router/README.md`](../../echo-vllm-router/README.md). After the
router node was shared/granted into the Kharkiv2 tailnet,
`CLIENT_HOST=echo-kharkiv2 just verify-client` passed health and model checks,
and `CLIENT_HOST=echo-kharkiv2 just smoke` returned `OK.` from
`google/gemma-4-26B-A4B-it`. Echo now uses the router through an enabled
tokenless engine at `http://100.105.172.96:8000/v1`.

## Rollback

Echo traffic rollback edits the existing AI engine, preserving its ID and
callsign-worker association, back to Spark's CBR-tailnet-visible Base URL
`http://100.92.119.116:8000/v1`. The Spark worker remains live throughout.

For a router package rollback, restore the previous deployment-package
revision and rerun `just deploy`; the immutable release selected by that
revision becomes `/opt/echo-vllm-router/current`. After Echo traffic has been
moved away, stop and disable `echo-vllm-router-otel.service` and
`echo-vllm-router.service`. Retain `/opt/echo-vllm-router` and
`/etc/echo-vllm-router` through the rollback soak; removal of paths and users
is a separate destructive decommissioning action.
