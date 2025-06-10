# Migrations

See [FLOWS_GREPTIMEDB.md](FLOWS_GREPTIMEDB.md) for flows setup/resetup.

## Initial setup of GreptimeDB 2025-04-09

```sql
CREATE DATABASE echo;
USE echo;
```

```sql
CREATE TABLE IF NOT EXISTS echo.activity_page_visit (
    ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP() TIME INDEX,
    "id" STRING,
    public_host STRING,
    username STRING,
    page STRING,
    payload JSON,
    PRIMARY KEY(id)
) WITH ('ttl'='30d', 'append_mode'='true');
```

## 2025-04-10

```sql
ALTER TABLE logs SET ttl='1month';
```

```sql
CREATE TABLE sink_activity_page_visit_per_host_per_minute (
    public_host STRING,
	total BIGINT,
	time_window TIMESTAMP TIME INDEX,
	update_at TIMESTAMP,
	PRIMARY KEY(public_host)
);
```

## 2025-06-10

```sql
CREATE TABLE IF NOT EXISTS echo.activity_details (
    ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP() TIME INDEX,
    request_id STRING,
    request_method STRING,
    request_path STRING,
    request_query_params JSON,
    request_headers JSON,
    request_body STRING,
    request_content_type STRING,
    response_status INT,
    response_time_ms BIGINT,
    event_type STRING,
    client_ip STRING,
    user_agent STRING,
    PRIMARY KEY(request_id, event_type)
) WITH ('ttl'='1month', 'append_mode'='true');
```
