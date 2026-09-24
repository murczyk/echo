#!/usr/bin/env python3
from __future__ import annotations

import json
import sys


def verify_status(status: dict) -> None:
    if not status["worker"]["instances"]:
        raise ValueError("extractor worker is unavailable")
    if status["paddle"]["required"] is not True or status["paddle"]["ready"] is not True:
        raise ValueError("production Paddle runtime is unavailable")
    routers = {router["name"]: router for router in status["routers"]}
    for name in ("nuextract", "ocr-gemma"):
        router = routers.get(name)
        if router is None or router["healthy"] is not True:
            raise ValueError(f"extractor router is unavailable: {name}")
        if router["expected_model"] not in router["served_models"]:
            raise ValueError(f"extractor router serves the wrong model: {name}")


def main() -> int:
    try:
        verify_status(json.load(sys.stdin))
    except (KeyError, TypeError, ValueError) as error:
        print(f"Extractor readiness failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
