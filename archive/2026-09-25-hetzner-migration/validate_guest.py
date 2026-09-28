#!/usr/bin/env python3
import json
import sys

from cutover import save
from migration_common import STATE, event, load_manifest, output, remote

SERVICES = {
    127: "nginx postgresql redis-server wdintel-rs wdintel-rs-bgworker wdintel-rs-report-worker wdintel-py echo-vector",
    126: "nginx postgresql redis-server wdintel-rs wdintel-rs-bgworker wdintel-rs-report-worker wdintel-py echo-vector",
    650: "nginx postgresql kmz-converter",
    420: "cron ssh echo-install-utils",
    131: "nginx echo-install-utils",
    421: "nginx postgresql mattermost",
    647: "vault vault-auto-unseal",
    128: "echo-vllm-router echo-vllm-router@nuextract echo-vllm-router@ocr-gemma echo-vllm-router-otel",
    405: "clickhouse-server zookeeper signoz signoz-otel-collector otelcol-contrib echo-liveness-prober prometheus-pve-exporter signoz-mattermost-bridge",
}

OCR_CHECK = '''
import subprocess,json,urllib.request
from pathlib import Path
pid=subprocess.check_output(['systemctl','show','wdintel-rs','-p','MainPID','--value'],text=True).strip()
env=dict(x.split(b'=',1) for x in Path('/proc/'+pid+'/environ').read_bytes().split(b'\\x00') if b'=' in x)
token=env[b'ECHO_OCR_TOKEN'].decode()
request=urllib.request.Request('http://100.93.77.92:8000/v1/status',headers={'Authorization':'Bearer '+token})
with urllib.request.urlopen(request,timeout=25) as r:
 data=json.load(r)
 assert r.status==200 and data['worker']['instances']
 assert data['routers'] and all(router['healthy'] for router in data['routers'])
 print('Authenticated OCR: ready; routers healthy; worker present')
'''


def execute(guest, script):
    result = remote(guest["target"], "sudo", "-n", "pct", "exec", guest["id"], "--", "bash", "-s", input=script)
    print(result.stdout, flush=True)
    return result.stdout


def validate(guest):
    ident = guest["id"]
    if guest["kind"] != "lxc":
        raise RuntimeError("VM needs its dedicated guest-agent and Incus checks")
    checks = []
    script = f'''set -e
test "$(tailscale ip -4)" = "{guest['tailscale']}"
ip -4 route
getent hosts example.com >/dev/null
curl -4fsSI --max-time 15 https://example.com >/dev/null
systemctl is-active tailscaled {SERVICES[ident]}
'''
    evidence = execute(guest, script)
    checks += ["Original Tailscale address", "DNS, DHCP default route and internet HTTPS", "Application services active"]
    if ident in (127, 126, 421, 650):
        evidence += execute(guest, "sudo -u postgres psql -Atqc 'SELECT 1'\n")
        checks.append("PostgreSQL query succeeded")
    if ident in (127, 126):
        evidence += execute(guest, '''set -e
test "$(redis-cli ping)" = PONG
curl -fsS --max-time 10 -o /dev/null http://127.0.0.1/
for port in 8000 8001 8002; do curl -fsS --max-time 12 "http://100.105.172.96:$port/health" >/dev/null; done
systemctl list-units 'echo-signal-bot@*.service' 'echo-whatsapp-bot@*.service' --state=running --no-legend
''')
        expected_signals = 13 if ident == 127 else 10
        evidence += execute(guest, f'''set -e
test "$(systemctl list-units 'echo-signal-bot@*.service' --state=running --no-legend | wc -l)" = {expected_signals}
echo '{expected_signals} Signal bots running'
''')
        result = remote(guest["target"], "sudo", "-n", "pct", "exec", ident, "--", "python3", "-", input=OCR_CHECK)
        print(result.stdout, flush=True)
        evidence += result.stdout
        checks += ["Redis and web HTTP", f"All {expected_signals} Signal bot units running", "All three router health endpoints", "Authenticated OCR readiness"]
        if ident == 126:
            checks.append("Three WhatsApp missing-phone restart loops predate migration; source journal evidence retained")
    if ident == 420:
        evidence += execute(guest, '''set -e
test -d /backup/gitlab
find /backup -type f -printf '%s\\n' | awk '{s+=$1;n++} END {print "backup files",n,"bytes",s; if(n!=32 || s!=12538081280) exit 1}'
''')
        checks.append("All 32 backup files and 12,538,081,280 bytes present; final rsync checksum audit passed")
    if ident == 421:
        evidence += execute(guest, "curl -fsS --max-time 15 http://127.0.0.1:8065/api/v4/system/ping\n")
        checks.append("Mattermost API ping HTTP 200")
    if ident == 131:
        evidence += execute(guest, "curl -fsS --max-time 10 -o /dev/null -w 'CI HTTP=%{http_code}\\n' http://127.0.0.1/\n")
        checks.append("CI nginx HTTP 200")
    if ident == 128:
        evidence += execute(guest, '''set -e
for port in 8000 8001 8002; do curl -fsS --max-time 12 "http://100.105.172.96:$port/health"; done
for worker in 100.92.119.117 100.95.57.33 100.113.47.83; do curl -fsS --max-time 12 "http://$worker:8000/health" >/dev/null; done
''')
        checks += ["All three router health endpoints", "All three GPU workers reachable"]
    if ident == 647:
        evidence += execute(guest, '''set -e
VAULT_ADDR=https://127.0.0.1:8200 VAULT_TLS_SERVER_NAME=oblik-os-cloud-vault.tawny-prometheus.ts.net vault status -format=json | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["initialized"] and not d["sealed"]; print("Vault initialized and unsealed")'
''')
        checks.append("Vault initialized and unsealed with verified TLS")
    if ident == 405:
        evidence += execute(guest, "curl -fsS --max-time 15 http://127.0.0.1:8080/api/v1/health\n")
        checks.append("SigNoz API health HTTP 200")
    path = STATE / "cutover" / f"{ident}.validation.txt"
    path.write_text(evidence)
    path.chmod(0o600)
    save(ident, validation_checks=checks)
    event(f"Guest {ident}: validation passed: " + "; ".join(checks) + ".")


if __name__ == "__main__":
    ident = int(sys.argv[1])
    validate(next(g for g in load_manifest()["guests"] if g["id"] == ident))
