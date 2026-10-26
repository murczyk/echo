import ipaddress
import json
import os
import re
import subprocess
import time
from functools import lru_cache
from pathlib import PurePosixPath
from urllib.parse import quote


RASTERS_DIR = "/etc/goi/public/rasters/"
TAILNET_SUFFIX = os.environ.get("GOI_TAILNET_SUFFIX", "chimp-tiaki.ts.net")
GOI_HOST = re.compile(rf"goi-[a-z0-9-]+\.{re.escape(TAILNET_SUFFIX)}")


class TenantError(Exception):
    pass


def raster_path(url: str) -> str:
    if (
        not url.startswith(RASTERS_DIR)
        or ".." in PurePosixPath(url).parts
        or any(char in url for char in ("%", "?", "#", "\\"))
        or PurePosixPath(url).suffix.lower() not in {".tif", ".tiff"}
    ):
        raise TenantError("invalid raster path")
    return quote(url, safe="/")


@lru_cache(maxsize=512)
def _goi_host(peer_ip: str, time_bucket: int) -> str:
    try:
        result = subprocess.run(
            ["tailscale", "whois", "--json", peer_ip],
            capture_output=True,
            text=True,
            timeout=3,
            check=True,
        )
        node = json.loads(result.stdout)["Node"]
        host = node["Name"].rstrip(".")
        addresses = {str(ipaddress.ip_interface(address).ip) for address in node["Addresses"]}
    except (subprocess.SubprocessError, ValueError, KeyError, TypeError, AttributeError) as error:
        raise TenantError("Tailscale identity unavailable") from error
    if peer_ip not in addresses or not GOI_HOST.fullmatch(host):
        raise TenantError("caller is not a GOI host")
    return host


def goi_host(peer_ip: str) -> str:
    try:
        peer_ip = str(ipaddress.ip_address(peer_ip))
    except ValueError as error:
        raise TenantError("invalid caller address") from error
    return _goi_host(peer_ip, int(time.monotonic() // 30))


def source_url(peer_ip: str, url: str) -> str:
    path = raster_path(url)
    return f"https://{goi_host(peer_ip)}{path}"
