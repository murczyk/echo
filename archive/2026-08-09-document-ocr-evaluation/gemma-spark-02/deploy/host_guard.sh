#!/usr/bin/env bash

set -euo pipefail

EXPECTED_HOSTNAME=echo-gpu-spark-02
EXPECTED_TAILSCALE_IP=100.95.57.33
EXPECTED_GPU_UUID=GPU-a2db5163-9f88-101b-6db3-df4f83412d48

guard_host() {
    test "$(hostname)" = "$EXPECTED_HOSTNAME"
    test "$(tailscale ip -4)" = "$EXPECTED_TAILSCALE_IP"
    test "$(nvidia-smi --query-gpu=uuid --format=csv,noheader,nounits)" = "$EXPECTED_GPU_UUID"
}

guard_host

