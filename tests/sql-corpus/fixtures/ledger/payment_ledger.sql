SELECT
  id,
  amount
FROM
  app.payments
WHERE
  created_at BETWEEN :extract_start_dt AND :extract_end_dt
