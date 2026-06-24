import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


try:
    import tomllib
except ModuleNotFoundError:
    import toml as tomllib

with open(sys.argv[1], "rb") as config_file:
    config = tomllib.loads(config_file.read().decode())

initial_users = config.get("system", {}).get("security", {}).get("initial_users", [])
if not initial_users:
    print("No Iggy initial users configured.")
    raise SystemExit

http = config.get("http", {})
if not http.get("enabled", False):
    raise RuntimeError("Iggy HTTP API must be enabled to ensure users")

address = urllib.parse.urlsplit(f"//{http['address']}")
host = address.hostname
if host in {"0.0.0.0", "::"}:
    host = "127.0.0.1"
if not host or not address.port:
    raise RuntimeError(f"Invalid Iggy HTTP address: {http['address']}")
if ":" in host:
    host = f"[{host}]"
base_url = f"http://{host}:{address.port}"

GLOBAL_PERMISSION_NAMES = (
    "manage_servers",
    "read_servers",
    "manage_users",
    "read_users",
    "manage_streams",
    "read_streams",
    "manage_topics",
    "read_topics",
    "poll_messages",
    "send_messages",
)
STREAM_PERMISSION_NAMES = (
    "manage_stream",
    "read_stream",
    "manage_topics",
    "read_topics",
    "poll_messages",
    "send_messages",
)
TOPIC_PERMISSION_NAMES = (
    "manage_topic",
    "read_topic",
    "poll_messages",
    "send_messages",
)


def complete_permissions(values, names):
    return {name: values.get(name, False) for name in names}


def normalize_permissions(permissions):
    if permissions is None:
        return None

    normalized = {
        "global": complete_permissions(
            permissions.get("global", {}),
            GLOBAL_PERMISSION_NAMES,
        ),
        "streams": None,
    }
    streams = permissions.get("streams")
    if streams is None:
        return normalized

    normalized["streams"] = {}
    for stream_id, stream in streams.items():
        normalized_stream = complete_permissions(stream, STREAM_PERMISSION_NAMES)
        normalized_stream["topics"] = None
        topics = stream.get("topics")
        if topics is not None:
            normalized_stream["topics"] = {
                topic_id: complete_permissions(topic, TOPIC_PERMISSION_NAMES)
                for topic_id, topic in topics.items()
            }
        normalized["streams"][stream_id] = normalized_stream

    return normalized


def permissions_for_existing_user(configured_permissions, existing_user):
    permissions = normalize_permissions(configured_permissions)
    if permissions is None:
        return None

    if configured_permissions.get("streams") is None:
        existing_permissions = existing_user.get("permissions") or {}
        existing_streams = existing_permissions.get("streams")
        if existing_streams is not None:
            permissions["streams"] = existing_streams

    return permissions


def request(method, path, body=None, token=None):
    headers = {"Accept": "application/json"}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    if token:
        headers["Authorization"] = f"Bearer {token}"

    req = urllib.request.Request(
        f"{base_url}{path}",
        data=data,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            payload = response.read()
    except urllib.error.HTTPError as error:
        details = error.read().decode(errors="replace")
        raise RuntimeError(
            f"{method} {path} failed with HTTP {error.code}: {details}"
        ) from error

    return json.loads(payload) if payload else None


auth_user = initial_users[0]
login_error = None
for _ in range(30):
    try:
        identity = request(
            "POST",
            "/users/login",
            {
                "username": auth_user["username"],
                "password": auth_user["password"],
            },
        )
        break
    except urllib.error.URLError as error:
        login_error = error
        time.sleep(1)
else:
    raise RuntimeError("Iggy HTTP API did not become ready") from login_error

token = identity["access_token"]["token"]
existing_users = {
    user["username"]: user for user in request("GET", "/users", token=token)
}

ordered_users = initial_users[1:] + initial_users[:1]
for user in ordered_users:
    username = user["username"]
    existing_user = existing_users.get(username)
    configured_permissions = user.get("permissions")
    if existing_user is not None:
        user_id = existing_user["id"]
        if user_id == 0:
            print(f"Iggy root user unchanged: {username}")
            continue
        existing_user = request("GET", f"/users/{user_id}", token=token)
        permissions = permissions_for_existing_user(
            configured_permissions,
            existing_user,
        )
        request(
            "PUT",
            f"/users/{user_id}",
            {
                "username": None,
                "status": user.get("status", "active"),
            },
            token=token,
        )
        request(
            "PUT",
            f"/users/{user_id}/permissions",
            {"permissions": permissions},
            token=token,
        )
        print(f"Updated Iggy user: {username}")
        continue

    permissions = normalize_permissions(configured_permissions)
    request(
        "POST",
        "/users",
        {
            "username": username,
            "password": user["password"],
            "status": user.get("status", "active"),
            "permissions": permissions,
        },
        token=token,
    )
    print(f"Created Iggy user: {username}")
