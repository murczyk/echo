#!/usr/bin/env python3
"""Loopback Prometheus exporter for aggregate /proc/stat CPU time.

hostmetrics cpu cannot be used on Incus: limits.cpu: N reassigns host CPU IDs
in /proc/stat, and the collector utilization calculator then fails forever on
the missing TimesStat. The aggregate `cpu ` line is stable across rebalance.
"""

from __future__ import annotations

import os
from http.server import BaseHTTPRequestHandler, HTTPServer

CPU_MODES = ("user", "nice", "system", "idle", "iowait", "irq", "softirq", "steal")
PROC_STAT = "/proc/stat"
LISTEN_ADDRESS = "127.0.0.1"
LISTEN_PORT = 9100


def parse_aggregate_cpu_seconds(stat_text: str, ticks: int) -> dict[str, float]:
    if ticks <= 0:
        raise ValueError("clk_tck must be positive")
    for line in stat_text.splitlines():
        if not line.startswith("cpu "):
            continue
        fields = line.split()[1:]
        if len(fields) < len(CPU_MODES):
            raise ValueError("aggregate cpu line is shorter than expected")
        return {mode: int(fields[index]) / ticks for index, mode in enumerate(CPU_MODES)}
    raise ValueError("missing aggregate cpu line")


def render_metrics(seconds_by_mode: dict[str, float]) -> str:
    lines = [
        "# HELP echo_host_cpu_seconds_total Aggregate CPU seconds spent in each mode",
        "# TYPE echo_host_cpu_seconds_total counter",
    ]
    for mode in CPU_MODES:
        lines.append(f'echo_host_cpu_seconds_total{{mode="{mode}"}} {seconds_by_mode[mode]}')
    return "\n".join(lines) + "\n"


def metrics_body(stat_text: str | None = None, ticks: int | None = None) -> bytes:
    if ticks is None:
        ticks = os.sysconf("SC_CLK_TCK")
    if stat_text is None:
        with open(PROC_STAT, encoding="utf-8") as handle:
            stat_text = handle.read()
    return render_metrics(parse_aggregate_cpu_seconds(stat_text, ticks)).encode()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path != "/metrics":
            self.send_response(404)
            self.end_headers()
            return
        try:
            body = metrics_body()
        except (OSError, ValueError):
            self.send_response(500)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args: object) -> None:
        return


if __name__ == "__main__":
    HTTPServer((LISTEN_ADDRESS, LISTEN_PORT), Handler).serve_forever()
