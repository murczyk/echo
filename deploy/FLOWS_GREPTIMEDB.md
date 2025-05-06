# Flows

```
CREATE OR REPLACE FLOW flow_activity_page_visit_per_host_per_minute
SINK TO sink_activity_page_visit_per_host_per_minute
EXPIRE AFTER '1h'
AS
SELECT
    public_host,
    COUNT(*) as total,
    date_bin('1minute'::INTERVAL, ts) AS time_window
FROM activity_page_visit
GROUP BY
    public_host,
    time_window;
```
