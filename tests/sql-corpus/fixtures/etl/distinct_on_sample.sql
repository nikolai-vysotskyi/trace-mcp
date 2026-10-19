WITH pay AS (
  SELECT DISTINCT ON (pe.student_id)
    pe.student_id,
    pe.amount
  FROM
    app.payments pe
  WHERE
    CASE
      WHEN :run_mode = 'full' THEN TRUE
      ELSE pe.student_id = ANY (:id_list)
    END
)
SELECT * FROM pay
