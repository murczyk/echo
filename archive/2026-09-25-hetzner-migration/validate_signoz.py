#!/usr/bin/env python3
import datetime
import json
import time
import urllib.request
import uuid

from cutover import read_state, save
from migration_common import RUN, STATE, event, remote, write_json

probe = f"hetzner-migration-{RUN}-{uuid.uuid4().hex}"
state = read_state(405)
assert state["phase"] in ("awaiting_validation", "migrated")
booted_ms = int(datetime.datetime.fromisoformat(state["booted"]).timestamp() * 1000)
payload = {"resourceLogs": [{
    "resource": {"attributes": [{"key": "service.name", "value": {"stringValue": "echo-migration-check"}}]},
    "scopeLogs": [{"scope": {"name": "migration-validation"}, "logRecords": [{
        "timeUnixNano": str(time.time_ns()), "severityNumber": 9, "severityText": "INFO",
        "body": {"stringValue": probe},
    }]}],
}]}
request = urllib.request.Request("http://100.71.235.10:4318/v1/logs",
    data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
with urllib.request.urlopen(request, timeout=20) as response:
    assert response.status == 200
    response.read()

script = r'''
from pathlib import Path
import base64,json,shlex,sys,time,urllib.parse,urllib.request
env={}
for line in Path('/opt/signoz/conf/systemd.env').read_text().splitlines():
 key,sep,value=line.partition('=')
 if sep:
  words=shlex.split(value)
  env[key]=words[0] if words else ''
dsn=urllib.parse.urlsplit(env['SIGNOZ_TELEMETRYSTORE_CLICKHOUSE_DSN'])
params=urllib.parse.parse_qs(dsn.query)
user=urllib.parse.unquote(dsn.username or params.get('username',['default'])[0])
password=urllib.parse.unquote(dsn.password or params.get('password',[''])[0])
auth=base64.b64encode((user+':'+password).encode()).decode()
def query(sql):
 req=urllib.request.Request('http://127.0.0.1:8123/',data=sql.encode(),headers={'Authorization':'Basic '+auth})
 with urllib.request.urlopen(req,timeout=20) as r: return json.load(r)['data'][0]
probe=sys.argv[1]
assert all(c.isalnum() or c=='-' for c in probe)
cutoff=time.time_ns()-300_000_000_000
sql=f"SELECT count() AS matched FROM signoz_logs.distributed_logs_v2 WHERE timestamp>{cutoff} AND body='{probe}' SETTINGS max_execution_time=10,max_threads=2 FORMAT JSON"
for attempt in range(20):
 if int(query(sql)['matched'])>0: break
 time.sleep(2)
else: raise SystemExit('Synthetic telemetry was not found in ClickHouse')
cutoff_ms=max(int(time.time()*1000)-300000,int(sys.argv[2]))
for attempt in range(20):
 metrics=query(f'SELECT max(unix_milli) AS latest FROM signoz_metrics.distributed_samples_v4 WHERE unix_milli>{cutoff_ms} SETTINGS max_execution_time=10,max_threads=2 FORMAT JSON')
 latest=int(metrics['latest'])
 if latest>cutoff_ms: break
 time.sleep(2)
else: raise SystemExit('No fresh production metrics after target boot')
print(json.dumps({'synthetic_log_found':True,'latest_metric_unix_milli':latest,'metric_age_seconds':round(time.time()-latest/1000,1)}))
'''
result = remote("pve-hz-3-ziggy", "sudo", "-n", "pct", "exec", "405", "--",
                "python3", "-", probe, booted_ms, input=script)
evidence = json.loads(result.stdout)
write_json(STATE / "cutover" / "405.telemetry-validation.json", evidence)
checks = read_state(405).get("validation_checks", [])
checks += ["External OTLP log accepted and found in ClickHouse", "Production metrics newer than target boot and younger than five minutes"]
save(405, validation_checks=checks)
event("Guest 405: end-to-end external OTLP log ingestion and fresh production metrics verified.")
print(json.dumps(evidence))
