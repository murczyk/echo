#!/bin/bash
set -Eeuo pipefail

production_container=${1:?production container is required}
experiment_container=${2:?experiment container is required}

if [[ $(incus list "$experiment_container" -c s --format csv) == RUNNING ]]; then
    incus stop "$experiment_container" --force
fi
if [[ $(incus list "$production_container" -c s --format csv) != RUNNING ]]; then
    incus start "$production_container"
fi
