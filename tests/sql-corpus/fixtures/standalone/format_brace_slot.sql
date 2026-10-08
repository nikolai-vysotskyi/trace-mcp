WITH pools AS (
  SELECT pool_date
  FROM app.metric_pools
  WHERE {pool_date_filter}
)
SELECT * FROM pools
