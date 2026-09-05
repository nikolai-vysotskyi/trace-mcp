# Security posture ledger

Scanner *configuration* state — what is on, what is deliberately off, and why.
Not a vulnerability log (those go through `SECURITY.md`), and not a place for
alert counts, which age out in days.

It exists because scanner config is invisible from the code. TRA-899 spent a
run re-deriving that `js/path-injection` should be excluded from CodeQL — six
days after TRA-381 had already excluded it. The alerts it counted were all
created before the fix landed. Read this file before proposing a scanner
change; update it in the same change that touches a setting.

## CodeQL

Config: `.github/codeql/codeql-config.yml`. It carries its own reasoning inline
including the conditions that should make each exclusion be reverted — read it
there, don't restate it here.

- **`js/path-injection` — excluded since 2026-08-30** (TRA-381, #665). Verified
  2026-09-05: zero open alerts for this rule, and none created since
  2026-08-29, the day before the exclusion landed. If a run counts recent
  dismissals of this rule, check their `created_at` before concluding the
  problem is live.
- **Filesystem-taint family** (`js/insecure-temporary-file`,
  `js/file-system-race`, `js/file-access-to-http`, `js/http-to-file-access`) —
  excluded since TRA-518, same trust-boundary reasoning.

## Workflow token permissions

All twelve workflow files carry a top-level `permissions:` block as of
2026-09-05 (TRA-903 gave `ga4-snapshot.yml` the last missing one, `{}`, with
`contents: write` still scoped to the job). Scorecard's `TokenPermissions`
alerts 1230/1231 were about that file.

Check for a regression with:

```sh
for f in .github/workflows/*.yml; do grep -qE '^permissions:' "$f" || echo "$f"; done
```

## Secret scanning

Read the live state with
`gh api repos/nikolai-vysotskyi/trace-mcp --jq .security_and_analysis`.

| Setting | State (2026-09-05) | Note |
| --- | --- | --- |
| `secret_scanning` | enabled | |
| `secret_scanning_push_protection` | enabled | the one that actually blocks a paste |
| `secret_scanning_non_provider_patterns` | **disabled** | wanted; see below |
| `secret_scanning_validity_checks` | **disabled** | wanted; low noise |

Non-provider patterns is what catches generic private keys and base64 key
material — the shape of `CSC_LINK`, the Developer ID `.p12` this project
handles (TRA-901). With it off, that class of paste passes push protection.

**Blocked on a UI toggle, not on a decision.** `PATCH /repos/{owner}/{repo}`
with `security_and_analysis` returns 200 for these two fields and silently
leaves them `disabled` — confirmed 2026-09-05 with a `repo`-scoped token, twice
(form encoding and JSON body). They are settable only from
Settings → Advanced Security. Don't burn another run scripting around this.

When non-provider patterns is turned on: watch one week. This repo is full of
full-SHA action pins and hex fixtures, so false positives are plausible. If it
is unusable, turn it back off **and record that here** rather than leaving the
state ambiguous.

## Known, accepted divergence

Scorecard's `Code-Review` check reads 0/30 and structurally always will: merges
here are gated by the workspace's mandatory second-model review, which leaves
no recorded GitHub approval. Do not "fix" the score by weakening that gate.
