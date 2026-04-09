---
name: trace-mcp-pre-commit
description: Run trace-mcp security, quality-gate, and antipattern checks before committing or opening a PR. Activate when the agent is about to create a commit or pull request in a project indexed by trace-mcp.
---

# trace-mcp — Pre-Commit & Pre-PR Checks

Before creating a commit or opening a pull request, run the trace-mcp validation suite. Fix any critical or high findings before committing.

## When to Use

- The user asks to commit, stage, or push changes
- The user asks to open a PR
- The agent has finished implementing a feature or fix and is about to hand off

## Checklist

### 1. Security scan

```
scan_security({ rules: ["all"] })
```

OWASP Top-10 vulnerability scan across the changed scope. If the change touches untrusted data flows, add:

```
taint_analysis({})
```

Trace untrusted sources to sensitive sinks (SQL, shell, file system, HTTP).

### 2. Quality gates on the changed scope

```
check_quality_gates({ scope: "changed" })
```

Validates complexity, coverage, duplication, and any project-configured gates on only the files you changed.

### 3. Antipattern scan

```
detect_antipatterns({})
```

Flags N+1 queries, eager loading, inefficient iteration, and language-specific performance footguns.

### 4. Symbol-level diff for the PR description

```
compare_branches({ branch: "current" })
```

Produces a symbol-level diff (functions added/removed/modified, signatures changed, exports changed). Use this as the basis for an accurate PR description instead of a raw line diff.

### 5. Bug prediction (optional, for risky changes)

```
predict_bugs({})
get_risk_hotspots({})
```

Flags files where the combination of high complexity and high churn makes regressions likely. If your change touches a hotspot, add extra tests.

## Fix or Escalate

- **Critical / High findings:** fix before committing. Do not suppress without discussion.
- **Medium findings:** fix if cheap, otherwise note in the PR description.
- **Low / Info findings:** note in the PR description.

## After Commit

If the commit is part of a larger series, consider:

```
get_changed_symbols({ since: "<base-ref>" })
```

to generate an accurate changelog entry grounded in the symbol graph rather than commit messages.
