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

**Latest errors** for the
[dashboard]([http://echo-greptime.alpines-banded.ts.net:4000/dashboard/#/dashboard/logs-query?editorType=text](http://echo-greptime.alpines-banded.ts.net:4000/dashboard/#/dashboard/logs-query?editorType=text&timeLength=180&editorSql=SELECT%250A%2520%2520greptime_timestamp%252C%250A%2520%2520host%252C%250A%2520%2520%2522_SYSTEMD_UNIT%2522%252C%250A%2520%2520message%250AFROM%250A%2520%2520logs%250AWHERE%250A%2520%2520greptime_timestamp%2520%253E%253D%2520%2524timestart%250A%2520%2520AND%2520greptime_timestamp%2520%253C%253D%2520%2524timeend%250A%2520%2520AND%2520(%250A%2520%2520%2520%2520host%2520NOT%2520LIKE%2520'%2525starobilsk%2525'%250A%2520%2520%2520%2520AND%2520(%250A%2520%2520%2520%2520%2520%2520message%2520LIKE%2520'%2525ERR%2525'%250A%2520%2520%2520%2520%2520%2520OR%2520message%2520ILIKE%2520'%2525err%2525'%250A%2520%2520%2520%2520)%250A%2520%2520%2520%2520AND%2520message%2520NOT%2520LIKE%2520'%2525Perro%2525'%250A%2520%2520%2520%2520AND%2520message%2520NOT%2520LIKE%2520'%2525AoeRR%2525'%250A%2520%2520%2520%2520AND%2520message%2520NOT%2520LIKE%2520'%2525WARN%2525'%250A%2520%2520%2520%2520AND%2520message%2520NOT%2520LIKE%2520'%2525INFO%2525'%250A%2520%2520%2520%2520AND%2520message%2520NOT%2520LIKE%2520'%2525level%253Ddebug%2525'%250A%2520%2520%2520%2520AND%2520message%2520NOT%2520LIKE%2520'%2525serverReceived%2525'%250A%2520%2520)%250AORDER%2520BY%250A%2520%2520greptime_timestamp%2520DESC%250ALIMIT%252010000%253B))
(also check out
[metabase](http://echo-greptime.alpines-banded.ts.net:3030/dashboard/2-main#refresh=600))

```
SELECT
  greptime_timestamp,
  host,
  "_SYSTEMD_UNIT",
  message
FROM
  logs
WHERE
  greptime_timestamp >= $timestart
  AND greptime_timestamp <= $timeend
  AND (
    host NOT LIKE '%starobilsk%'
    AND (
      message LIKE '%ERR%'
      OR message ILIKE '%err%'
    )
    AND message NOT LIKE '%Perro%'
    AND message NOT LIKE '%AoeRR%'
    AND message NOT LIKE '%WARN%'
    AND message NOT LIKE '%INFO%'
    AND message NOT LIKE '%level=debug%'
    AND message NOT LIKE '%serverReceived%'
  )
ORDER BY
  greptime_timestamp DESC
LIMIT 10000;
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

## Average and Maximum per specific endpoint bucketed

```
WITH calls AS (
  SELECT
    date_trunc('hour', ts) AS hour_bucket,
    response_time_ms
  FROM activity_details
  WHERE
    ts > NOW() - INTERVAL '24 hours'
    AND request_path = '/api/rer/callsign-info-batch'
)
, stats AS (
  SELECT
    hour_bucket,
    AVG(response_time_ms) OVER w    AS avg_rt,
    MAX(response_time_ms) OVER w    AS max_rt,
    ROW_NUMBER() OVER (PARTITION BY hour_bucket ORDER BY hour_bucket) AS rn
  FROM calls
  WINDOW w AS (PARTITION BY hour_bucket)
)
SELECT
  hour_bucket,
  avg_rt,
  max_rt
FROM stats
WHERE rn = 1
ORDER BY hour_bucket;
```
