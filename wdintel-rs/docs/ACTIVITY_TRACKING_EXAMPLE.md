# Activity Tracking Example

## Redis Data Structure

After requests are processed, the data in Redis looks like this:

Members use `<unix-second>:<request-id>:<event-type>`, preserving request and
response records even when they occur in the same second. The payload and member
are published atomically. The exporter also accepts previously buffered members
without the event-type suffix; no data migration is required.

Request headers retain only referer, origin, user-agent, content-type, accept,
host, and x-request-id. Request bodies remain unrecorded.

### Sorted Set: `echo-md-requests`

```
ZRANGE echo-md-requests 0 -1 WITHSCORES
1) "1704123456:550e8400-e29b-41d4-a716-446655440000:request"
2) "1704123456"
3) "1704123456:550e8400-e29b-41d4-a716-446655440000:response"
4) "1704123456"
```

### Individual Activity Data

```
GET echo-md-requests:1704123456:550e8400-e29b-41d4-a716-446655440000:request
```

Returns:
```json
{
  "request_id": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": 1704123456,
  "request_method": "POST",
  "request_path": "/api/v1/messages",
  "request_query_params": {
    "debug": "true"
  },
  "request_headers": {
    "content-type": "application/json",
    "user-agent": "Mozilla/5.0...",
    "accept": "*/*"
  },
  "request_body": null,
  "request_content_type": "application/json",
  "response_status": null,
  "response_time_ms": null,
  "event_type": "request",
  "client_ip": "192.168.1.100",
  "user_agent": "Mozilla/5.0..."
}
```

```
GET echo-md-requests:1704123456:550e8400-e29b-41d4-a716-446655440000:response
```

Returns:
```json
{
  "request_id": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": 1704123456,
  "request_method": "POST",
  "request_path": "/api/v1/messages",
  "request_query_params": null,
  "request_headers": null,
  "request_body": null,
  "request_content_type": null,
  "response_status": 200,
  "response_time_ms": 145,
  "event_type": "response",
  "client_ip": "192.168.1.100",
  "user_agent": "Mozilla/5.0..."
}
```

## Query Examples

### Get all activities in the last hour
```bash
redis-cli ZRANGEBYSCORE echo-md-requests $(($(date +%s) - 3600)) +inf
```

### Count total activities
```bash
redis-cli ZCARD echo-md-requests
```

This counts buffered lifecycle records, not distinct HTTP requests. Deduplicate
by `request_id` for HTTP totals. The existing 10,000-record cap and one-hour TTL
remain; retaining both records can reduce request coverage during a backlog.

### Get TTL of a specific activity
```bash
redis-cli TTL "echo-md-requests:1704123456:550e8400-e29b-41d4-a716-446655440000:request"
```

### Check collection TTL
```bash
redis-cli TTL echo-md-requests
```
