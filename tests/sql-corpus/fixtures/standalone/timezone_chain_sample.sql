WITH events AS (
  SELECT created_at AT TIME ZONE 'UTC' AS created_utc
  FROM app.events
),
event_logs AS (
  SELECT event_id FROM events
),
crat AS (
  SELECT 1 AS ok FROM event_logs
)
SELECT * FROM crat
