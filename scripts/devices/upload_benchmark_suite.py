#!/usr/bin/env python3
"""Run a balanced upload matrix against an owned benchmark stand."""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time

import upload_benchmark_stand as stand


def sample(root, state, output, stop):
    pids = ",".join(str(record["pid"]) for record in state["processes"].values())
    with output.open("x") as log:
        while not stop.is_set():
            result = subprocess.run(["ps", "-p", pids, "-o", "pid=,rss=,%cpu=,time="], capture_output=True, text=True)
            log.write(json.dumps({"at": datetime.now(timezone.utc).isoformat(), "free_bytes": shutil.disk_usage(root).free,
                                  "processes": result.stdout.splitlines()}) + "\n")
            log.flush()
            stop.wait(1)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--profile", choices=("smoke", "full", "large"), default="smoke")
    parser.add_argument("--resume", action="store_true", help="Continue completed cohorts without overwriting their evidence")
    args = parser.parse_args()
    root, state = stand.load(args.root)
    stand.shared.require(state["stage"] == "ready", "Stand must be ready")
    args.output.mkdir(parents=True, exist_ok=args.resume)
    environment = {key: state[key] for key in ("run", "git_head", "binary_sha256", "api_a_port", "pg_port", "redis_port", "s3_port")}
    if not args.resume:
        environment.update(config_sha256=state["config_sha256"], capacity_profile=state.get("capacity_profile", "defaults"))
    if args.resume:
        previous = json.loads((args.output / "environment.json").read_text())
        stand.shared.require(all(previous[key] == value for key, value in environment.items()), "Cannot resume against another stand")
    else:
        stand.shared.private_write(args.output / "environment.json", json.dumps(environment, indent=2))
    if args.profile == "smoke":
        cohorts = [("smoke", 4, 2, "32768", "16044")]
    elif args.profile == "large":
        cohorts = [("large", 4, 2, "8388608,134217728", "8388652")]
    else:
        cohorts = [("serial", 24, 1, "32768,131072,524288", "16044,64044,256044"),
                   ("concurrent", 512, 8, "32768,131072,524288", "16044,64044,256044"),
                   ("burst", 32, 16, "1048576", "1048620")]
    stop = threading.Event()
    resources = args.output / (f"resources-{time.time_ns()}.jsonl" if args.resume else "resources.jsonl")
    monitor = threading.Thread(target=sample, args=(root, state, resources, stop))
    monitor.start()
    results = json.loads((args.output / "progress.json").read_text()) if args.resume else []
    try:
        for index, (label, count, concurrency, files, audio) in enumerate(cohorts):
            order = [("file", "sync"), ("file", "async"), ("audio", "async"), ("audio", "sync")]
            if index % 2:
                order.reverse()
            for kind, mode in order:
                name = f"{label}-{kind}-{mode}"
                if any(result["cohort"] == name for result in results):
                    continue
                print(f"Starting {name}: count={count}, concurrency={concurrency}", flush=True)
                command = [sys.executable, str(Path(__file__).with_name("upload_benchmark.py")),
                           "--base-url", f"http://127.0.0.1:{state['api_a_port']}",
                           "--credentials", str(root / "credentials.json"), "--kind", kind, "--mode", mode,
                           "--count", str(count), "--concurrency", str(concurrency),
                           "--sizes", files if kind == "file" else audio, "--output", str(args.output / f"{name}.jsonl")]
                with (args.output / f"{name}.log").open("x") as log:
                    result = subprocess.run(command, stdout=log, stderr=log)
                results.append({"cohort": name, "exit_code": result.returncode})
                (args.output / "progress.json").write_text(json.dumps(results, indent=2))
                print(f"Finished {name}: exit={result.returncode}", flush=True)
                if not (args.output / f"{name}.summary.json").exists():
                    raise RuntimeError(f"{name} could not run; inspect its log")
    finally:
        stop.set()
        monitor.join()


if __name__ == "__main__":
    main()
