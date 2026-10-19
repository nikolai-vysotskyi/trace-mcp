"""Synthetic ETL runner for loads_sql fixture tests (generic app layout)."""

SQL_FILE = "etl/two_cte_join_sample.sql"


def run_with_constant():
    read_sql_file(SQL_FILE)


def run_with_literal():
    read_sql_file("etl/incremental_keys_sample.sql")
