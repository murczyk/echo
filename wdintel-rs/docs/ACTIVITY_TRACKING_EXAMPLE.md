# Activity Tracking Example

## Redis Data Structure

After requests are processed, the data in Redis looks like this:

### Sorted Set: `echo-md-requests`

```
ZRANGE echo-md-requests 0 -1 WITHSCORES
1) "1704123456:550e8400-e29b-41d4-a716-446655440000"
2) "1704123456"
3) "1704123457:660e8400-e29b-41d4-a716-446655440001"
4) "1704123457"
```

### Individual Activity Data

```
GET echo-md-requests:1704123456:550e8400-e29b-41d4-a716-446655440000
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
GET echo-md-requests:1704123457:660e8400-e29b-41d4-a716-446655440001
```

Returns:
```json
{
  "request_id": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": 1704123457,
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

### Get TTL of a specific activity
```bash
redis-cli TTL "echo-md-requests:1704123456:550e8400-e29b-41d4-a716-446655440000"
```

### Check collection TTL
```bash
redis-cli TTL echo-md-requests
```
