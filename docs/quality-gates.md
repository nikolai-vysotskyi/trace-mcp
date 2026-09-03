---
title: "Quality Gates — configure trace-mcp's thresholds"
description: "The eight quality_gates.rules keys trace-mcp checks, which three run by default, and how this project calibrated its own thresholds as a worked example."
updated: 2026-09-02
---

# Quality gates — configuring thresholds

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "TechArticle",
  "headline": {{ page.title | jsonify }},
  "description": {{ page.description | jsonify }},
  "url": "https://trace-mcp.com/quality-gates.html",
  "datePublished": "2026-07-02",
  "dateModified": {{ page.updated | jsonify }},
  "author": {
    "@type": "Person",
    "name": "Nikolai Vysotskyi",
    "url": "https://github.com/nikolai-vysotskyi"
  },
  "publisher": {
    "@type": "Person",
    "name": "Nikolai Vysotskyi",
    "url": "https://github.com/nikolai-vysotskyi"
  },
  "mainEntityOfPage": {
    "@type": "WebPage",
    "@id": "https://trace-mcp.com/quality-gates.html"
  }
}
</script>
`check_quality_gates` reads the `quality_gates` section of
[`.trace-mcp.json`](configuration.md). Configure nothing and three rules still
run; name a rule and your threshold replaces the built-in one for that rule
only. The second half of this page is this repo's own configuration as a worked
example of how the numbers get chosen.

## What runs when you configure nothing

Three rules ship on by default:

| Rule | Threshold | Severity |
|---|---|---|
| `max_cyclomatic_complexity` | 30 | error |
| `max_circular_import_chains` | 0 | error |
| `max_coupling_instability` | 0.9 | warning |

The other five are only checked once you name them — an absent rule is not a
zero threshold, it is no check at all. There is no coverage rule: coverage is
not one of the signals this gate reads.

## Configuring your own

```json
{
  "quality_gates": {
    "enabled": true,
    "fail_on": "error",
    "rules": {
      "max_cyclomatic_complexity": { "threshold": 60, "severity": "warning" },
      "max_dead_exports_percent": { "threshold": 10, "severity": "warning" },
      "max_security_critical_findings": { "threshold": 0, "severity": "error" }
    }
  }
}
```

The eight rule keys:

| Key | Threshold means |
|---|---|
| `max_cyclomatic_complexity` | highest cyclomatic complexity of any indexed symbol |
| `max_coupling_instability` | highest instability (0–1) of any module |
| `max_circular_import_chains` | number of circular import chains |
| `max_dead_exports_percent` | share of exports nothing imports |
| `max_tech_debt_grade` | worst module grade allowed, `A`–`F` |
| `max_security_critical_findings` | critical findings from `scan_security` |
| `max_antipattern_count` | findings from `detect_antipatterns` |
| `max_code_smell_count` | findings from the code-smell scan |

Every rule takes the same fields: `threshold` (a number, or a letter for the
grade), `severity` (`error` or `warning`) and an optional `message` shown when
it trips. `fail_on` decides what turns into a failing run — `error` (default), `warning`
to fail on both, or `none` to report without failing. `enabled: false` turns the
whole gate off.

Start by running `check_quality_gates` with the defaults, then raise only the
rules your codebase legitimately trips — the worked example below is that
process on this repo.

## Worked example: this repo's own thresholds

The values below live in this repository's `.trace-mcp.json`. They are
calibrated against the codebase's actual, reviewed state — re-derive them after
any large refactor round rather than treating them as permanent.

### max_cyclomatic_complexity: 130 (warning)

The generic default of 30 fires on nearly every language/framework plugin in
this repo — dispatch tables for {{ site.data.counts.languages }} languages and {{ site.data.counts.frameworks }} frameworks are
inherently branchy. After decomposing every class that was a genuine
god-object (`DecisionStore` 262→96, `TopologyStore` 125→49,
`IndexingPipeline` 137→115, plus tool-gate/api-routes/memory-tools splits),
the remaining top offenders are all language/framework plugins whose
complexity is domain-necessary, not accidental: `DartLanguagePlugin` (123),
`FastAPIPlugin` (119), `CppLanguagePlugin` (117), `LaravelPlugin` (105),
`ObjCLanguagePlugin` / `OcamlLanguagePlugin` (103). 130 sits just above that
accepted ceiling — today's classes pass silently, but a genuinely new outlier
above it still trips the warning.

### max_security_critical_findings: 2 (error)

`scan_security` is a regex-based scanner with no data-flow analysis (a full
taint/dataflow rewrite was explicitly scoped out — see [comparisons](comparisons.md)).
It cannot see past a runtime-validated identifier or a value's closed
provenance. Two findings are reviewed and accepted as false positives, not
suppressed silently:

- `src/ai/vec-extension.ts:134` — `this.table` is a single hardcoded literal
  set once at field declaration, additionally guarded by
  `assertSafeSqliteIdentifier()` right before the `DROP TABLE` call
  (defense in depth against future code changes, not because this path is
  reachable today).
- `src/daemon/project-manager.ts:704` — `name` is drawn from
  `sqlite_master`'s own table-name catalog (a fixed, developer-controlled
  enumeration of ~30 literal `CREATE TABLE` names), never from project/user
  input.

The threshold is 2, not 0, so a **third** critical finding — new or
otherwise — still fails the gate and forces review. If either of these two
findings' code changes such that the value could become externally
influenced, re-audit before assuming the finding is still a false positive.

### max_circular_import_chains: 0 (error), max_tech_debt_grade: D (warning)

The circular-import rule is left at its default of 0 — no evidence-based reason
to relax it. The tech-debt grade is not on by default at all; `D` is this repo's
own ceiling, set so a module sliding to `F` fails the run.

The gates are read by `check_quality_gates`, `get_tech_debt` and
`get_circular_imports` ([tools reference](tools-reference.md)); where the file
itself lives and how per-project overrides merge is in
[configuration](configuration.md).
