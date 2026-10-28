import json
import subprocess
import unittest
from unittest.mock import patch

from tenant import TenantError, goi_host, raster_path, source_url, _goi_host


class TenantTests(unittest.TestCase):
    def setUp(self):
        _goi_host.cache_clear()

    def whois(self, peer_ip, host, addresses=None):
        return subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout=json.dumps(
                {
                    "Node": {
                        "Name": host + ".",
                        "Addresses": addresses or [peer_ip + "/32"],
                    }
                }
            ),
        )

    def test_source_is_bound_to_calling_goi_host(self):
        peer_ip = "100.66.50.102"
        with patch("tenant.subprocess.run", return_value=self.whois(peer_ip, "goi-prod-05.chimp-tiaki.ts.net")):
            self.assertEqual(
                source_url(peer_ip, "/etc/goi/public/rasters/map.tif"),
                "https://goi-prod-05.chimp-tiaki.ts.net/etc/goi/public/rasters/map.tif",
            )

    def test_same_raster_name_has_distinct_source_per_host(self):
        def whois(args, **kwargs):
            peer_ip = args[-1]
            host = {
                "100.66.50.102": "goi-prod-05.chimp-tiaki.ts.net",
                "100.88.196.117": "goi-stg.chimp-tiaki.ts.net",
            }[peer_ip]
            return self.whois(peer_ip, host)

        with patch("tenant.subprocess.run", side_effect=whois):
            prod = source_url("100.66.50.102", "/etc/goi/public/rasters/map.tif")
            staging = source_url("100.88.196.117", "/etc/goi/public/rasters/map.tif")
        self.assertNotEqual(prod, staging)

    def test_other_peer_cannot_claim_a_goi_host(self):
        peer_ip = "100.66.50.102"
        whois = self.whois(peer_ip, "goi-prod-05.chimp-tiaki.ts.net", ["100.1.2.3/32"])
        with patch("tenant.subprocess.run", return_value=whois):
            with self.assertRaises(TenantError):
                goi_host(peer_ip)

    def test_non_goi_peer_is_rejected(self):
        peer_ip = "100.66.50.102"
        with patch("tenant.subprocess.run", return_value=self.whois(peer_ip, "personal-laptop.chimp-tiaki.ts.net")):
            with self.assertRaises(TenantError):
                goi_host(peer_ip)

    def test_rejects_other_sources_and_traversal(self):
        for url in (
            "https://goi-prod-05.chimp-tiaki.ts.net/etc/goi/public/rasters/map.tif",
            "/etc/goi/public/rasters/../secret.tif",
            "/etc/goi/public/rasters/map%2ftest.tif",
            "/etc/goi/public/rasters/map.tif?x=1",
            "/etc/goi/public/rasters/map.png",
        ):
            with self.subTest(url=url), self.assertRaises(TenantError):
                raster_path(url)


if __name__ == "__main__":
    unittest.main()
