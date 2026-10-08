WITH
  scoped AS (
    SELECT
      d.object_id
    FROM
      app.demo d
      LEFT JOIN {{SCHEMA_NAME}}.assignments a ON a.record_id = d.record_id
    WHERE
      a.lead_id IS NOT NULL
      AND CASE
        WHEN :run_mode = 'full' THEN d.student_id <= (
          SELECT
            max(student_id)
          FROM
            app.demo
        )
        ELSE d.parent_id = ANY (:id_list)
      END
  ),
  emp_age AS (
    SELECT
      split_part(email, '@', 1) AS emp,
      MIN(created_at) AS joining_date
    FROM
      hr.employees
    GROUP BY
      split_part(email, '@', 1)
  )
SELECT
  s.object_id
FROM
  scoped s
  JOIN emp_age e ON TRUE
