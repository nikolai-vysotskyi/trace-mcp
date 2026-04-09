---
name: trace-mcp-refactoring
description: Safe refactoring workflow using trace-mcp — assess risk, find candidates, check impact, and rename symbols across all files without missing import sites or cross-file references.
---

# trace-mcp — Refactoring Workflow

Use this skill whenever you are about to rename, restructure, extract, or otherwise refactor code in a project indexed by trace-mcp. The goal is to never break cross-file references and never guess at what is affected.

## When to Use

- Renaming a class, function, method, variable, or file
- Extracting a function or method
- Restructuring a module or splitting a file
- Changing a function signature
- Any change that touches more than one call site

## Refactoring Workflow

### 1. Assess before touching anything

```
assess_change_risk({ file_path: "src/foo.ts" })
# or
assess_change_risk({ symbol_id: "<id>" })
```

This returns the risk level of the target change based on churn, complexity, fan-in/fan-out, and test coverage. Use it to decide whether to proceed, add tests first, or split the change.

### 2. Find what actually needs refactoring

```
get_refactor_candidates()
```

Do not guess. This surfaces high-complexity, high-churn, and anti-pattern-laden symbols that are the real refactor targets.

### 3. Know what will break

```
get_change_impact({ symbol_id: "<id>" })
```

Returns the reverse-dependency graph: every file, symbol, and test that depends on the target. Review this list before editing.

### 4. Quantify complexity

```
get_complexity_report({ file_path: "src/foo.ts" })
```

Gives you a baseline so you can verify the refactor actually reduced complexity.

## Renaming a Symbol — MANDATORY Flow

**Never** rename with `Edit` and `replace_all`. It silently misses import sites, re-exports, type references, and cross-file usages.

```
# 1. Collision detection first
check_rename({ symbol_id: "<id>", target_name: "newName" })

# 2. Apply rename across ALL files (definition + every reference)
apply_rename({ symbol_id: "<id>", new_name: "newName" })
```

`apply_rename` updates the definition, imports, re-exports, call sites, JSX usages, and tests in one atomic operation.

## Extracting a Function

```
extract_function({
  file_path: "src/foo.ts",
  start_line: 42,
  end_line: 67,
  new_name: "computeTotals"
})
```

Let trace-mcp handle the variable capture analysis — manual extraction routinely misses closure variables.

## After the Refactor

1. `register_edit` on each edited file to reindex
2. `get_complexity_report` again to confirm the reduction
3. `get_tests_for` the changed symbols — run them
4. `check_quality_gates` with `scope: "changed"` to verify no regressions
