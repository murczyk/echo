from urllib.error import HTTPError, URLError
from urllib.request import Request as URLRequest, urlopen

from fastapi import FastAPI, HTTPException, Query, Request
from titiler.core.errors import DEFAULT_STATUS_CODES, add_exception_handlers
from titiler.core.factory import TilerFactory

from tenant import TenantError, source_url


def goi_raster_url(request: Request, url: str = Query(...)) -> str:
    if request.client is None or request.client.host not in {"127.0.0.1", "::1"}:
        raise HTTPException(status_code=403, detail="invalid proxy")
    try:
        raster_url = source_url(request.headers.get("X-Tailscale-Client-IP", ""), url)
    except TenantError as error:
        raise HTTPException(status_code=403, detail=str(error)) from None
    try:
        with urlopen(URLRequest(raster_url, method="HEAD"), timeout=10):
            pass
    except HTTPError as error:
        if error.code == 404:
            raise HTTPException(status_code=404, detail="raster not found") from None
        raise HTTPException(status_code=502, detail="raster source unavailable") from None
    except URLError:
        raise HTTPException(status_code=502, detail="raster source unavailable") from None
    return raster_url


app = FastAPI(title="GOI tiles", openapi_url=None, docs_url=None, redoc_url=None)
cog = TilerFactory(path_dependency=goi_raster_url, router_prefix="/cog")
app.include_router(cog.router, prefix="/cog")
add_exception_handlers(app, DEFAULT_STATUS_CODES)


@app.get("/healthz")
def healthz():
    return {"ok": True}
