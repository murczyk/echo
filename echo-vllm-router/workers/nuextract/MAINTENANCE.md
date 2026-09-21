# NuExtract GPU maintenance

NuExtract runs in `echo-nuextract3` on `echo-gpu-flyingskull`
(`srv-gpu-ubuntu26`). The Incus container shares the host kernel and uses
`nvidia.runtime=true` to receive the host NVIDIA runtime. Maintain the driver
on the **outer host**; do not install a separate kernel driver inside the
container.

On 2026-09-11, unattended upgrades installed NVIDIA 595.91.07 while the host
continued running kernel module 595.71.05. An Incus restart on 2026-09-17
exposed the mismatch: GPU mount hooks failed, leaving NuExtract stopped and
OCR jobs waiting on both CBR instances. On 2026-09-21, a normal module reload
and container start restored service without rebooting the host.

## Install the host policy

Copy `install-host-policy.sh` and `99-echo-gpu-maintenance` together to the
outer host, then run:

```bash
sudo bash ./install-host-policy.sh
```

The installer is safe to repeat. It installs
`/etc/apt/apt.conf.d/99-echo-gpu-maintenance` and checks that every installed
NVIDIA package is excluded from unattended upgrades. Patterns cover future
driver versions, driver libraries, firmware, NVIDIA kernel modules, and the
container toolkit. Ordinary security updates remain enabled. This policy
does not block an administrator's manual `apt upgrade`.

Review pending NVIDIA updates weekly and schedule their installation in a
GPU maintenance window. Do not leave security updates deferred indefinitely.
To roll back this policy, remove only its named APT configuration file;
coordinate subsequent GPU updates before re-enabling unattended installation.

## Update or recover the driver

1. Record `sudo incus list` and check for active package maintenance. Arrange
   a window for shared OCR interruption. Preserve the extractor and Echo job
   queues and their existing concurrency limits.
2. Stop `echo-nuextract3` for planned driver updates. Leave retired GPU
   containers stopped. Inspect `sudo fuser -v /dev/nvidia*`; close GPU
   monitoring tools such as `nvitop` and identify every remaining user before
   proceeding. Never force a module unload or terminate an unknown workload.
3. For an update, install the complete NVIDIA package set together using APT.
   Check `dkms status` for the running kernel and the kernel selected for the
   next boot. A partial or failed package transaction must be repaired before
   starting NuExtract.
4. When no process holds the GPU, activate the installed modules:

   ```bash
   sudo modprobe -r nvidia_drm nvidia_modeset nvidia_uvm nvidia
   sudo modprobe -a nvidia nvidia_uvm nvidia_modeset nvidia_drm
   cat /proc/driver/nvidia/version
   modinfo -F version nvidia
   nvidia-smi
   ```

   Require matching versions and a successful `nvidia-smi`. If normal unload
   fails, stop and arrange a host reboot; `still-staging` and
   `still-signoz-staging` also run on this host. Do not reboot automatically.
5. Start NuExtract and wait for model loading, which may take several minutes:

   ```bash
   sudo incus start echo-nuextract3
   sudo incus exec echo-nuextract3 -- systemctl is-enabled echo-vllm-worker-nuextract.service
   sudo incus exec echo-nuextract3 -- systemctl is-active echo-vllm-worker-nuextract.service
   sudo incus exec echo-nuextract3 -- /opt/echo-vllm-worker/bin/verify-nuextract
   ```

   Inspect the worker journal if verification fails. Preserve the model cache,
   container configuration, and `/var/lib/tailscale` identity.

## Verify OCR and monitoring

From the repository checkout:

```bash
ssh echo-vllm-router 'curl -fsS --max-time 10 http://100.105.172.96:8002/health'
bash echo-document-extractor/bin/verify-clients.sh echo-cbr-staging echo-cbr
```

The client check validates authentication, worker presence, Paddle readiness,
both router dependencies, and their expected model IDs. The extractor's
`/health/ready` checks storage and queue access only; HTTP 200 from `/v1/status`
also does not by itself mean the pipeline is healthy.

Observe new completions and decreasing pending counts in each instance's
`ocr_job` table using read-only transactions with a short statement timeout.
Dependency retries wait 15 minutes and may take longer to drain a backlog.
Do not reset jobs or restart CBR services to accelerate recovery.

The `OCR NuExtract dependency unavailable` SigNoz rule checks the extractor
worker's `echo_document_extractor_dependency_up{dependency="nuextract"}`
series. It requires five minutes of failed dependency checks and also enables
five-minute missing-data detection. Worker telemetry is selected explicitly
so API status polling cannot conceal a stopped worker. Notifications use the
existing `mattermost monitoring` channel, with 30-minute reminders.

To review and apply the checked-in rule, provide an authorized SigNoz API key
through the environment; never put it in a command argument or repository:

```bash
python3 echo-document-extractor/bin/install-nuextract-alert.py
SIGNOZ_URL=https://signoz-echo.eagle-atria.ts.net python3 echo-document-extractor/bin/install-nuextract-alert.py --apply
```

The apply command requires `SIGNOZ_API_KEY`, creates or updates only the named
rule, and verifies its stored settings. Repeated runs reuse the same rule.
Validate outage behavior with historical dependency data and missing-data
queries; do not stop production inference or send test notifications. Missing
data uses [SigNoz's native detection](https://signoz.io/docs/alerts-management/user-guides/how-to-configure-alerts-for-missing-data/).
