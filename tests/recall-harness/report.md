# Recall harness report

- generated_at: `2026-05-10T21:47:19.319Z`
- project_root: `/Users/nikolai/PhpstormProjects/trace-mcp`
- fixtures: 8 (8 passed, 0 failed)
- aggregate recall@k: 1.000
- aggregate precision@k: 0.938

| status | id | kind | k | recall | precision | baseline |
|--------|----|------|---|--------|-----------|----------|
| PASS | 01-search-indexer-entry-point | symbol | 5 | 1.000 | 1.000 | 1.000 |
| PASS | 02-search-gather-context | symbol | 5 | 1.000 | 1.000 | 1.000 |
| PASS | 03-search-decision-store | symbol | 5 | 1.000 | 0.500 | 1.000 |
| PASS | 04-search-pack-context | symbol | 5 | 1.000 | 1.000 | 1.000 |
| PASS | 05-context-ask-shared | file | 10 | 1.000 | 1.000 | 1.000 |
| PASS | 06-context-pipeline | file | 10 | 1.000 | 1.000 | 1.000 |
| PASS | 07-decisions-fts-search | decision | 10 | 1.000 | 1.000 | 1.000 |
| PASS | 08-decisions-tag-filter | decision | 10 | 1.000 | 1.000 | 1.000 |

