---
title: "Quality Gates Reference — complexity, security, and coverage thresholds"
description: "How trace-mcp's quality_gates.rules in .trace-mcp.json override CLI defaults for cyclomatic complexity, security findings, and coverage — with this project's own thresholds as a worked example."
---

# Quality gates — this project's thresholds

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "TechArticle",
  "headline": "Quality gates \u2014 this project's thresholds",
  "description": "How .trace-mcp.json quality-gate thresholds are configured and calibrated.",
  "url": "https://trace-mcp.com/quality-gates.html",
  "datePublished": "2026-07-02",
  "dateModified": "2026-07-02",
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
`.trace-mcp.json`'s `quality_gates.rules` overrides the CLI's generic defaults
(`max_cyclomatic_complexity: 30`, `max_security_critical_findings: 0`) with
numbers calibrated against this codebase's actual, reviewed state. Re-derive
these after any large refactor round — don't treat them as permanent.

## max_cyclomatic_complexity: 130 (warning)

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

## max_security_critical_findings: 2 (error)

`scan_security` is a regex-based scanner with no data-flow analysis (a full
taint/dataflow rewrite was explicitly scoped out — see `docs/comparisons.md`).
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

## max_circular_import_chains: 0 (error), max_tech_debt_grade: D (warning)

Unchanged from the CLI defaults — no evidence-based reason to relax either.
