#!/bin/bash
set -Eeuo pipefail

production_container=echo-gpu-pve5-echo-gpu
experiment_container=numarkdown-eval-20260808
restore_unit=nuextract3-prod-restore-20260808
vllm_unit=nuextract3-vllm-bf16-20260808
snapshot=/workspace/numarkdown-eval/hf-cache/hub/models--numind--NuExtract3/snapshots/2e9fca82ee641e6bb6e1f5d905241e994be27a07
cuda_home=/opt/vllm-venv/lib/python3.13/site-packages/nvidia/cu13
client_script=${NUEXTRACT3_CLIENT_SCRIPT:-run_nuextract3_eval.py}
restore_script=/home/hammer/workspace/numarkdown-eval/harness/restore_gpu_production.sh

restore_production() {
    trap - EXIT HUP INT TERM
    set +e
    sudo systemctl stop "${restore_unit}.timer" "${restore_unit}.service" 2>/dev/null
    sudo incus stop "$experiment_container" --force 2>/dev/null
    if [[ $(sudo incus list "$production_container" -c s --format csv) != RUNNING ]]; then
        sudo incus start "$production_container"
    fi
}

trap restore_production EXIT HUP INT TERM

if [[ $(sudo incus list "$experiment_container" -c s --format csv) != RUNNING ]]; then
    sudo incus start "$experiment_container"
fi

sudo systemd-run \
    --unit="$restore_unit" \
    --on-active=60m \
    --timer-property=AccuracySec=1m \
    "$restore_script" "$production_container" "$experiment_container"

if [[ $(sudo incus list "$production_container" -c s --format csv) == RUNNING ]]; then
    sudo incus stop "$production_container" --force || \
        [[ $(sudo incus list "$production_container" -c s --format csv) == STOPPED ]]
fi

sudo incus exec "$experiment_container" -- systemd-run \
    --unit="$vllm_unit" \
    --collect \
    --setenv=HF_HOME=/workspace/numarkdown-eval/hf-cache \
    --setenv=HF_HUB_OFFLINE=1 \
    --setenv=TRANSFORMERS_OFFLINE=1 \
    --setenv=CUDA_HOME="$cuda_home" \
    --setenv=TORCH_CUDA_ARCH_LIST=8.9 \
    --setenv=PATH=/opt/vllm-venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    --setenv=VLLM_USE_FLASHINFER_SAMPLER=0 \
    /opt/vllm-venv/bin/vllm serve "$snapshot" \
    --served-model-name numind/NuExtract3 \
    --trust-remote-code \
    --dtype bfloat16 \
    --max-model-len 16384 \
    --gpu-memory-utilization 0.95 \
    --max-num-seqs 1 \
    --limit-mm-per-prompt '{"image":1,"video":0}' \
    --chat-template-content-format openai \
    --generation-config vllm \
    --enforce-eager \
    --host 127.0.0.1 \
    --port 8000

for _ in $(seq 1 240); do
    if sudo incus exec "$experiment_container" -- \
        curl --silent --fail http://127.0.0.1:8000/health >/dev/null; then
        break
    fi
    if ! sudo incus exec "$experiment_container" -- \
        systemctl is-active --quiet "$vllm_unit"; then
        sudo incus exec "$experiment_container" -- \
            journalctl -u "$vllm_unit" --no-pager -n 240
        exit 1
    fi
    sleep 2
done

if ! sudo incus exec "$experiment_container" -- \
    curl --silent --fail http://127.0.0.1:8000/health >/dev/null; then
    sudo incus exec "$experiment_container" -- \
        journalctl -u "$vllm_unit" --no-pager -n 240
    exit 1
fi

sudo incus exec "$experiment_container" -- \
    /opt/vllm-venv/bin/python \
    "/workspace/numarkdown-eval/$client_script"
