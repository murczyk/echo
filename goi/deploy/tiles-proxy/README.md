# GOI tile router

The central router accepts raster tile requests only through a GOI host. Each
GOI Nginx site forwards `/tiles/` to the router over Tailscale. The router uses
`tailscale whois` on the incoming peer IP to select that host's raster origin;
the request cannot select another origin. New GOI hosts need no router prefix or
registration, but must have a `goi-*` Tailscale name in `chimp-tiaki.ts.net`.

Set `remoteTiles` on each GOI instance to its own hostname. For example:

```text
https://goi-prod-05.chimp-tiaki.ts.net/tiles/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?url=$FILE
```

GOI requires an absolute HTTP(S) URL, so the hostname changes per instance.
The checked-in GOI Nginx site handles `/tiles/` on every host. The router's
`nginx-location.conf` belongs in the HTTPS server block on the central proxy;
it forwards `/cog/` to the separate router service on port 4006. Keep the
staging test route on port 4005 until its setting has been migrated.

Roll out the router service and central Nginx location first, then switch
goi-stg to its same-origin `/tiles/` URL and verify tile rendering, missing-file
404, and rejection of an arbitrary source URL. Test concurrent requests and
memory use before switching prod-05. Subsequent GOI deployments already receive
the generic `/tiles/` route from `deploy/nginx/goi`; each new instance only needs
its own hostname in `remoteTiles`. Install and enable `goi-tiles-router-renew-cert.timer` on the
central proxy to keep its Tailscale HTTPS certificate current.

The service uses the versions in `requirements.txt` in its own virtual
environment. It must bind only to loopback so clients cannot forge the
`X-Tailscale-Client-IP` header. The central Nginx must overwrite that header
with `$remote_addr`, and only the central proxy host should accept requests to
its HTTPS endpoint. Disable Nginx tile caching; the service checks that each
raster still exists before rendering a tile. Distinct GOI origins give GDAL
distinct cache keys, so clearing one host's data does not delete another
host's files. A process-wide GDAL cache flush may evict another host's cached
data, causing extra reads but not changing its files.

This routing prevents a caller from supplying another GOI origin to the tile
service. It does not authorize the browser user: anyone who can open another
GOI host's `/tiles/` or raw raster URL can request that host's data. Enforce
GOI host access through Tailscale ACLs or GOI authentication before treating
this as user-level isolation. Capacity on the shared proxy also needs load
testing before routing production traffic.
