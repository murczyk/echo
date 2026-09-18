#!/usr/bin/env python3

import os
import shlex
import sys
from urllib.parse import parse_qs, unquote, urlparse


def main():
    path = os.environ.get("ECHO_SIGNOZ_ENV_FILE", "/opt/signoz/conf/systemd.env")
    try:
        with open(path) as source:
            values = dict(
                line.strip().split("=", 1)
                for line in source
                if "=" in line and not line.lstrip().startswith("#")
            )
        dsn = shlex.split(values["SIGNOZ_TELEMETRYSTORE_CLICKHOUSE_DSN"])
        if len(dsn) != 1:
            raise ValueError("invalid DSN")
        dsn = urlparse(dsn[0])
        if dsn.scheme not in ("tcp", "clickhouse") or dsn.hostname not in (
            "localhost", "127.0.0.1", "::1"
        ):
            raise ValueError("expected local native ClickHouse DSN")
        parameters = parse_qs(dsn.query)
        password = parameters.get("password", [unquote(dsn.password or "")])[0]
        username = parameters.get("username", [unquote(dsn.username or "default")])[0]
        port = dsn.port or 9000
        if not password:
            raise ValueError("missing password")
    except (OSError, KeyError, ValueError):
        sys.exit("Cannot read a local ClickHouse credential from the SigNoz environment file")
    environment = dict(os.environ, CLICKHOUSE_PASSWORD=password)
    os.execvpe("clickhouse-client", [
        "clickhouse-client", "--host", dsn.hostname, "--port", str(port),
        "--user", username, *sys.argv[1:]
    ], environment)


if __name__ == "__main__":
    main()
