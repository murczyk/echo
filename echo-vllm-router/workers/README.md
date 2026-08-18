# OCR vLLM workers

These profiles deploy the two homogeneous OCR backends consumed by the router.
They are separate from the historical loopback-only evaluation deployments.
Neither profile changes an Echo instance or deploys `echo-document-extractor`.

| Pool | Production host endpoint | Served model | Runtime |
| --- | --- | --- | --- |
| OCR-Gemma | `100.95.57.33:8000` | `echo/ocr-gemma-4-26B-A4B-it` | Docker on Spark-02 |
| NuExtract | `100.113.47.83:8000` | `numind/NuExtract3` | systemd in a dedicated Tailscale-connected Incus container on Flyingskull |

## OCR-Gemma on Spark-02

Seed the pinned Gemma revision under
`/srv/echo-ocr-gemma/cache/huggingface` before installation. Reusing the
verified model files is allowed; do not start the archived
`echo-gemma-ocr-vllm` experiment container as the production service. From a
checkout copied to Spark-02, run:

```bash
cd echo-vllm-router/workers/ocr-gemma
./install.sh
```

The production container binds only `100.95.57.33:8000`, uses the pinned image
digest and model revision, and advertises the OCR-only alias rather than the
general Gemma model ID. vLLM admits up to two concurrent sequences so the
shared extractor can batch two active documents.

## NuExtract on Flyingskull

NuExtract3 used about 14.4 GiB of the 16 GiB GPU during evaluation. Before this
rollout, explicitly approve moving or retiring the current
`echo-gpu-pve5-echo-gpu` workload. Do not run both workloads concurrently.

Create a fresh production Incus container; do not reuse
`numarkdown-eval-20260808`. Give it the GPU, install the tested vLLM `0.26.0`
environment at `/opt/vllm-venv`, and seed the pinned model snapshot under
`/var/lib/echo-vllm-worker/huggingface`. Copy the `nuextract` profile into that
container, then run inside it:

```bash
sudo ./install.sh
```

Install Tailscale inside the container and preserve its identity in
`/var/lib/tailscale` when migrating it. Share the `echo-nuextract3` node with
the router tailnet; keep authentication keys out of Git. The checked-in worker
profile binds vLLM only to the container's Tailscale address
`100.113.47.83:8000`, with no Incus proxy device or host listener. It admits
up to two concurrent sequences.

Confirm `ss -H -ltn 'sport = :8000'` inside the container reports only
`100.113.47.83:8000`. The router preflight then verifies health, exact model
ID, metrics, and reachability for both workers before any router service
changes.

## Rollback

Stop only the affected router instance first. Remove the OCR-Gemma production
container with `docker compose down`, or stop the NuExtract unit. Restore
Flyingskull's previous production container when rolling NuExtract back. Model
caches and production containers are retained until the rollback soak is
complete.
