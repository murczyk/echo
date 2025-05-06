## Play

```
cat input01.txt | vector -c ./vector_play.yaml | jq .
```

## Deploy

Configure nginx as:

```
log_format timed_combined '$remote_addr - $remote_user [$time_local] '
	'"$request" $status $body_bytes_sent '
	'"$http_referer" "$http_user_agent" '
	'$request_time $upstream_response_time $pipe';

access_log /var/log/nginx/access.log timed_combined;
```

# Kibana
1. create policy at /app/management/data/index_lifecycle_management/policies:
   1. hot for 1 day
   2. warm after 1 day
   3. cold after 2 day
   4. delete when 5 days old

2. Add dashboards: 
    1. TBD