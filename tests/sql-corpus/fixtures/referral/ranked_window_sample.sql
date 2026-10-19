WITH touched AS (
  SELECT id FROM app.audit_trails WHERE created_at >= :start_date
),
ranked AS (
  SELECT *, row_number() OVER (PARTITION BY id ORDER BY created_at DESC) AS rn
  FROM touched
)
SELECT * FROM ranked WHERE rn = 1
