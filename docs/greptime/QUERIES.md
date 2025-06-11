## How many logs per 5m per host?

**WARNING**: do not run, very slow (see flow)

```
SELECT 
    ts,
    public_host,
    COUNT(*) RANGE('5m') FILL 0 AS count
FROM activity_page_visit
  WHERE ts >= NOW() - INTERVAL '6 hours'
  ALIGN '5m' TO '2025-04-01T00:00:00' BY (public_host) 
  ORDER BY ts ASC;
```

Via flow (see [FLOWS_GREPTIMEDB.md](../../deploy/FLOWS_GREPTIMEDB.md)):

```
SELECT 
    time_window,
    public_host,
    sum(total) RANGE('5m') FILL 0 AS count
FROM sink_activity_page_visit_per_host_per_minute
  WHERE time_window >= NOW() - INTERVAL '6 hours'
  ALIGN '5m' TO '2025-04-01T00:00:00' BY (public_host) 
  ORDER BY time_window ASC;
```

## Format date

```
date_format(ts::TIMESTAMP, '%Y-%m-%d %H:%M:%S.%3f')
```

## Logs

Latest:

```
select greptime_timestamp, host, "_SYSTEMD_UNIT", message from logs order by timestamp desc limit 10;
```

Graph per host:

```
SELECT 
    "logs"."greptime_timestamp" as ts,
    host,
    COUNT(*) RANGE('1m') FILL 0 AS count
FROM logs
  WHERE "logs"."timestamp" >= NOW() - INTERVAL '6 hours'
  ALIGN '1m' TO '2025-04-01T00:00:00' BY (host) 
  ORDER BY "logs"."greptime_timestamp" ASC;
```

## Slow endpoints

```
select
  request_hostname,
  date_format (ts::TIMESTAMP, '%Y-%m-%d %H:%M:%S.%3f') as datetime,
  response_time_ms,
  request_path, 
  request_body
from
  activity_details
where
  ts > NOW() - INTERVAL '4 hours'
  and request_method = 'POST'
  and response_time_ms > 2000
order by
  ts
limit
  100;
```

## Average and Maximum per specific endpoint

This is for `/api/rer/callsign-info-batch` in last 20 minutes:

```
WITH calls AS (
  SELECT
    date_trunc('minute', ts) AS minute_bucket,
    response_time_ms
  FROM activity_details
  WHERE
    ts > NOW() - INTERVAL '20 minutes'
    AND request_path = '/api/rer/callsign-info-batch'
)
, stats AS (
  SELECT
    minute_bucket,
    AVG(response_time_ms) OVER w    AS avg_rt,
    MAX(response_time_ms) OVER w    AS max_rt,
    ROW_NUMBER() OVER (PARTITION BY minute_bucket ORDER BY minute_bucket) AS rn
  FROM calls
  WINDOW w AS (PARTITION BY minute_bucket)
)
SELECT
  minute_bucket,
  avg_rt,
  max_rt
FROM stats
WHERE rn = 1
ORDER BY minute_bucket;
```
