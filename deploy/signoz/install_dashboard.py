#!/usr/bin/env python3
"""Create or update the AI providers dashboard on signoz-echo.

Run it with `just signoz-install-dashboard`. This script sends itself and the
dashboard JSON to signoz-echo over SSH and runs there, because the API key must
not leave that host.

    --check   confirm the API credential works, sending GET requests only
    --verify  run every panel's queries without saving anything

Credential handling follows docs/MONITORING.md: the `claude` service-account key
is read through a read-only SQLite connection and is never printed.
"""

import argparse
import json
import pathlib
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request

SSH_HOST = "signoz-echo"
SIGNOZ_URL = "http://127.0.0.1:8080"
SIGNOZ_DB = "file:/var/lib/signoz/signoz.db?mode=ro"
SERVICE_ACCOUNT = "claude"
ACTIVE_STATUS = "active"
REQUEST_TIMEOUT_SECS = 30
VERIFY_WINDOW_SECS = 6 * 60 * 60
ALL_VALUES = "__all__"
MANAGED_TAG = {"key": "managed-by", "value": "echo-repo"}


class RejectRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


# The API key must only reach loopback, so ignore proxies and refuse redirects.
OPENER = urllib.request.build_opener(
    urllib.request.ProxyHandler({}), RejectRedirects()
)


def account_key():
    connection = sqlite3.connect(SIGNOZ_DB, uri=True, timeout=3)
    connection.row_factory = sqlite3.Row
    row = connection.execute(
        """
        select k.*, a.status as account_status
        from factor_api_key k
        join service_account a on a.id = k.service_account_id
        where a.name = ?
        """,
        (SERVICE_ACCOUNT,),
    ).fetchone()
    if row is None:
        sys.exit(f"No API key for service account {SERVICE_ACCOUNT}")
    if row["account_status"].lower() != ACTIVE_STATUS:
        sys.exit(f"Service account status is {row['account_status']}")
    expires_at = row["expires_at"]
    if expires_at and expires_at < time.time():
        sys.exit("The service-account key has expired")
    return row["key"]


def api_request(key, method, path, payload=None):
    request = urllib.request.Request(
        SIGNOZ_URL + path,
        data=None if payload is None else json.dumps(payload).encode(),
        headers={"SIGNOZ-API-KEY": key, "Content-Type": "application/json"},
        method=method,
    )
    try:
        with OPENER.open(request, timeout=REQUEST_TIMEOUT_SECS) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        body = error.read().decode(errors="replace")[:600]
        sys.exit(f"{method} {path} failed with {error.code}: {body}")


def list_dashboards(key):
    return api_request(key, "GET", "/api/v2/dashboards")["data"]["dashboards"]


def dashboard_title(entry):
    return entry["spec"]["display"]["name"]


def check(key):
    print(json.dumps([dashboard_title(entry) for entry in list_dashboards(key)]))


def dashboard_variables(dashboard, values):
    return {
        variable["spec"]["name"]: {
            "type": "dynamic",
            "value": values.get(variable["spec"]["name"], ALL_VALUES),
        }
        for variable in dashboard["spec"]["variables"]
    }


def panel_series_count(result):
    rows = 0
    for entry in result["data"]["data"]["results"]:
        rows += len(entry.get("data") or [])
        for aggregation in entry.get("aggregations") or []:
            rows += len(aggregation.get("series") or [])
    return rows


def verify_panel(key, panel, variables, now_ms):
    query = panel["spec"]["queries"][0]
    result = api_request(
        key,
        "POST",
        "/api/v5/query_range",
        {
            "schemaVersion": "v1",
            "start": now_ms - VERIFY_WINDOW_SECS * 1000,
            "end": now_ms,
            "requestType": query["kind"],
            "compositeQuery": {
                "queries": query["spec"]["plugin"]["spec"]["queries"]
            },
            "variables": variables,
            "formatOptions": {"formatTableResultForUI": False, "fillGaps": False},
        },
    )
    return panel_series_count(result)


def verify(key, dashboard, values):
    variables = dashboard_variables(dashboard, values)
    now_ms = int(time.time() * 1000)
    failed = False
    for panel in dashboard["spec"]["panels"].values():
        name = panel["spec"]["display"]["name"]
        try:
            print(f"{verify_panel(key, panel, variables, now_ms):>5}  {name}")
        except SystemExit as error:
            failed = True
            print(f"FAILED {name}: {error}")
    if failed:
        sys.exit("Some panels failed")


def managed_dashboard_id(key, title):
    matches = [
        entry
        for entry in list_dashboards(key)
        if dashboard_title(entry) == title
    ]
    if len(matches) > 1:
        sys.exit(f"Found {len(matches)} dashboards titled {title}")
    if not matches:
        return None
    if MANAGED_TAG not in (matches[0].get("tags") or []):
        sys.exit(f"Dashboard {title} exists but is not managed by this repo")
    return matches[0]["id"]


def install(key, dashboard):
    dashboard_id = managed_dashboard_id(key, dashboard["spec"]["display"]["name"])
    if dashboard_id:
        api_request(key, "PUT", f"/api/v2/dashboards/{dashboard_id}", dashboard)
    else:
        created = api_request(key, "POST", "/api/v2/dashboards", dashboard)
        dashboard_id = created["data"]["id"]
    saved = api_request(key, "GET", f"/api/v2/dashboards/{dashboard_id}")["data"]
    print(
        json.dumps(
            {
                "id": dashboard_id,
                "name": saved["name"],
                "tags": saved["tags"],
                "panels": len(saved["spec"]["panels"]),
                "variables": len(saved["spec"]["variables"]),
            }
        )
    )


def run_remote(options):
    key = account_key()
    if options["mode"] == "check":
        check(key)
    elif options["mode"] == "verify":
        verify(key, options["dashboard"], options["values"])
    else:
        install(key, options["dashboard"])


def send_to_host(mode, dashboard_file, values):
    options = {
        "mode": mode,
        "values": values,
        "dashboard": None
        if mode == "check"
        else json.loads(dashboard_file.read_text()),
    }
    program = (
        f"REMOTE_OPTIONS = {json.dumps(json.dumps(options))}\n"
        + pathlib.Path(__file__).read_text()
    )
    result = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", SSH_HOST, "sudo -n python3 -I -"],
        input=program,
        text=True,
    )
    return result.returncode


def main():
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument(
        "--check", dest="mode", action="store_const", const="check"
    )
    modes.add_argument(
        "--verify", dest="mode", action="store_const", const="verify"
    )
    parser.add_argument(
        "--var",
        action="append",
        default=[],
        metavar="NAME=VALUE",
        help="comma-separated dashboard variable values for --verify",
    )
    parser.add_argument(
        "--dashboard",
        type=pathlib.Path,
        default=pathlib.Path(__file__).parent / "dashboards/ai-providers.json",
    )
    arguments = parser.parse_args()
    values = dict(variable.split("=", 1) for variable in arguments.var)
    values = {name: value.split(",") for name, value in values.items()}
    return send_to_host(arguments.mode or "install", arguments.dashboard, values)


if __name__ == "__main__":
    if "REMOTE_OPTIONS" in globals():
        run_remote(json.loads(REMOTE_OPTIONS))
    else:
        sys.exit(main())
