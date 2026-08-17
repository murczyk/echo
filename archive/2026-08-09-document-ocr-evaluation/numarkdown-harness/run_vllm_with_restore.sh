#!/bin/bash
set -Eeuo pipefail

production_container=echo-gpu-pve5-echo-gpu
experiment_container=numarkdown-eval-20260808
restore_unit=numarkdown-vllm-prod-restore-20260808
vllm_unit=numarkdown-vllm-20260808
snapshot=/workspace/numarkdown-eval/hf-cache/hub/models--numind--NuMarkdown-8B-Thinking/snapshots/8dfc5236ae68b799d86308aae2f9717fdb50286e
cuda_home=/opt/vllm-venv/lib/python3.13/site-packages/nvidia/cu13
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
    --served-model-name numind/NuMarkdown-8B-Thinking \
    --trust-remote-code \
    --quantization bitsandbytes \
    --load-format bitsandbytes \
    --dtype bfloat16 \
    --max-model-len 12288 \
    --gpu-memory-utilization 0.95 \
    --max-num-seqs 1 \
    --limit-mm-per-prompt '{"image":1}' \
    --enforce-eager \
    --host 127.0.0.1 \
    --port 8000

for _ in $(seq 1 180); do
    if sudo incus exec "$experiment_container" -- \
        curl --silent --fail http://127.0.0.1:8000/health >/dev/null; then
        break
    fi
    if ! sudo incus exec "$experiment_container" -- \
        systemctl is-active --quiet "$vllm_unit"; then
        sudo incus exec "$experiment_container" -- \
            journalctl -u "$vllm_unit" --no-pager -n 200
        exit 1
    fi
    sleep 2
done

if ! sudo incus exec "$experiment_container" -- \
    curl --silent --fail http://127.0.0.1:8000/health >/dev/null; then
    sudo incus exec "$experiment_container" -- \
        journalctl -u "$vllm_unit" --no-pager -n 200
    exit 1
fi

sudo incus exec "$experiment_container" -- \
    /opt/vllm-venv/bin/python \
    /workspace/numarkdown-eval/run_vllm_eval.py
