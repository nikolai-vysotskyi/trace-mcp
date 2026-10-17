WITH all_transactions AS MATERIALIZED (
  SELECT 1 AS id
),
parent_collections AS MATERIALIZED (
  SELECT 2::int AS id
)
SELECT * FROM all_transactions
UNION ALL
SELECT * FROM parent_collections
