#!/bin/bash
set -Eeuo pipefail

production_container=echo-gpu-pve5-echo-gpu
experiment_container=numarkdown-eval-20260808
restore_unit=numarkdown-prod-restore-20260808
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
    --on-active=45m \
    --timer-property=AccuracySec=1m \
    "$restore_script" "$production_container" "$experiment_container"

if [[ $(sudo incus list "$production_container" -c s --format csv) == RUNNING ]]; then
    sudo incus stop "$production_container" --force || \
        [[ $(sudo incus list "$production_container" -c s --format csv) == STOPPED ]]
fi
nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader

sudo incus exec "$experiment_container" -- env \
    HF_HOME=/workspace/numarkdown-eval/hf-cache \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    PYTHONUNBUFFERED=1 \
    /opt/numarkdown-venv/bin/python \
    /workspace/numarkdown-eval/run_eval.py \
    --output /workspace/numarkdown-eval/output/numarkdown.raw.json \
    /workspace/numarkdown-eval/input/l54dw_8gZt5foedpH-PY.jpg \
    /workspace/numarkdown-eval/input/J5rHE_ZMsk1H_QDCCn3v.jpg
