---
name: trace-mcp-codemod
description: Use trace-mcp apply_codemod for any bulk mechanical change instead of repeated Edit calls. Activate whenever the same edit pattern would be applied 2+ times, across one file or many.
---

# trace-mcp — Codemod Workflow

`apply_codemod` is the correct tool for any repeated mechanical change. Using `Edit` for the same pattern twice or more is a waste of tokens and is error-prone.

## When to Use — HARD RULE

If you are about to make the **same kind of change 2 or more times** — whether in one file or across many — stop and use `apply_codemod`. This includes:

- Adding `async`/`await` to a set of functions
- Updating a function signature everywhere it is called
- Fixing import paths after a move
- Adding or removing keywords/decorators
- Wrapping calls in a logger, try/catch, or feature flag
- Replacing a deprecated API usage
- Any regex-replaceable refactor

No exceptions. "It's just three edits" is still a violation — use `apply_codemod`.

## Standard Workflow

### 1. Preview with dry run (default)

```
apply_codemod({
  pattern: "oldFunction\\(",
  replacement: "newFunction(",
  file_pattern: "src/**/*.ts",
  dry_run: true        // default
})
```

Review the preview: matched files, context lines, and replacement correctness. Look for false positives.

### 2. Narrow scope when needed

Use `filter_content` to only touch files that also contain a second marker:

```
apply_codemod({
  pattern:        "extractNodes\\(",
  replacement:    "extractNodes(ctx, ",
  file_pattern:   "src/**/*.ts",
  filter_content: "import.*extractNodes",
  dry_run:        true
})
```

For patterns that cross line boundaries, enable multiline mode:

```
apply_codemod({
  pattern:     "function\\s+foo\\([^)]*\\)\\s*\\{",
  replacement: "async function foo() {",
  multiline:   true,
  dry_run:     true
})
```

### 3. Apply the change

```
apply_codemod({ ..., dry_run: false })
```

If more than 20 files are affected, add `confirm_large: true`.

### 4. Reindex and verify

- `register_edit` is not needed for codemods — `apply_codemod` handles reindexing internally.
- Run the test suite or `check_quality_gates` with `scope: "changed"`.

## Planning Larger Changes

For changes that span packages or require version awareness (e.g. upgrading a dependency), use `plan_batch_change` first:

```
plan_batch_change({
  package:      "lodash",
  from_version: "4.17.0",
  to_version:   "5.0.0"
})
```

This returns an impact report with all affected files and import references. Combine it with `apply_codemod` for the actual rewrite.

## Anti-Patterns to Avoid

- Using `Edit` with `replace_all` for renames — use `apply_rename` (see `trace-mcp-refactoring`).
- Chaining 3–10 `Edit` calls with the same `old_string` pattern shape — use `apply_codemod`.
- Skipping the dry-run preview — always review matches first.
- Forgetting `confirm_large: true` on changes >20 files.
