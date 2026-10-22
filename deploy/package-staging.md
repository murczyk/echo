# Package staging and temporary API unavailability

`just deploy` downloads the selected packages and dependencies before stopping
Echo. `just deploy-from-local` uploads and stages its local package first; it can
use cached package metadata without an APT update. A staging failure leaves the
application running. Installation after shutdown uses `--no-download` and a
20-minute deadline, so it cannot extend downtime by fetching missing packages.
Installation/migration failures retain the deployment recipe's recovery behavior;
inspect the reported state before approving any further recovery operation.

The deployment maintenance marker keeps its two-minute TTL, with 30 seconds
between renewal attempts while the deployment process lives. Renewal stops on
exit or loss of the parent process; cleanup also clears the marker on success or
failure. Renewal and its local SSH subprocess are stopped before clearing the
marker, so a failed clear leaves only the remaining TTL, including during later
notification work.

Skhid and Pivnich's nginx site templates map upstream connection failures to JSON
HTTP 503 with `Retry-After: 1` and `no-store`; application-generated errors
retain their responses. The normal application deploy does not install nginx
site templates. Updating the installed site needs separate approval naming the
host and nginx configuration/reload operation. Validate with `nginx -t` before
reloading it.

The #3780 follow-up branch is based on `main`. Review and validate against that
base, including the catalog-aware migration check with `GITHUB_BASE_REF=main`.
Changing the branch base requires an explicit user instruction. These
instructions authorize no environment changes; obtain explicit approval naming
each deployment target and operation first.
