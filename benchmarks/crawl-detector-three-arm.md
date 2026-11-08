# Crawl detector — live three-arm measurement (TRA-773)

TRA-757 (PR #836) closed the *mechanism* question for the guard v2 navigation
gate: shadow-replayed over 860 recorded sessions it covers 90.1% of navigation
calls inside a real crawl and fires zero times on a light question. That answers
"does the rule land where it should". It does not answer the question the rule
was built for: **did it get cheaper, and did quality drop.**

This file records the live answer, the harness facts a repeat run should not
have to rediscover, and one defect the measurement uncovered along the way.

Measured 2026-09-04, Claude Code 2.1.239, `claude-sonnet-4-5`, macOS. 11 tasks
× 3 arms × 3 repeats = 99 runs, $12.76. Serial (one run at a time) — the guard
keeps per-project state in `$TMPDIR`, and parallel runs of the same repo
contaminate each other's consultation markers.

## Arms

One variable changes between neighbours.

| arm | MCP | guard hook |
|---|---|---|
| A | none (`--strict-mcp-config` with an empty server map) | none |
| B | trace-mcp | `TRACE_MCP_GUARD_NAV_MIN=1` — intervene on the *first* navigation call (the pre-detector shape that produced TRA-705's 1.45x) |
| C | trace-mcp | `TRACE_MCP_GUARD_NAV_MIN=3` — guard v2, stay silent until the session is crawling |

Both treatment arms run `TRACE_MCP_ENFORCE=strict`. Isolation is
`--setting-sources project` plus an explicit `--settings` file per arm;
transcripts confirm no user-level hook or CLAUDE.md leaked in.

Tasks are outside the tuning contour — the detector was tuned on the burst
histogram of session transcripts, not on these two repositories (a Laravel app
and a Python Telegram bot). Ground truth for every task was derived
mechanically from the repositories before the grid ran.

## Two classes, never one pooled number

The effect points in opposite directions by design, so a single mean would hide
both halves. Cost is the **geometric mean of per-task median ratios**, not the
ratio of summed cost: summing puts most of the weight on whichever task happens
to be longest (here CR1, ~4x the next crawl task) and would report one task's
result as the class result.

### Light navigation questions — 6 tasks, 54 runs

| arm | solved | geo cost vs A | turns | native calls | trace calls | guard denies |
|---|---|---|---|---|---|---|
| A bare | 18/18 | 1.000x | 4.1 | 1.67 | 0.00 | 0 |
| B guard v1 | 18/18 | 0.975x | 3.8 | 0.89 | 1.89 | 5 |
| C detector | 18/18 | **0.888x** | 3.4 | 0.78 | 1.61 | **0** |

Per-task cost vs the bare agent, B then C:

| task | what it asks | B/A | C/A | C/B |
|---|---|---|---|---|
| LT1 | which controller handles `POST /asana/token` | 1.44x | 1.13x | 0.78x |
| LT2 | which file declares the CSRF exemption | 1.72x | 1.22x | 0.71x |
| LT3 | `$fillable` of one named model | 0.87x | 0.88x | 1.01x |
| LT4 | subject line set by one named notification | 0.59x | 0.57x | 0.97x |
| LT5 | default of one named constant in `config.py` | 0.74x | 0.81x | 1.10x |
| LT6 | routes defined in one named file | 0.92x | 0.87x | 0.95x |

### Crawls and multi-step work — 5 tasks, 45 runs

| arm | solved | geo cost vs A | turns | native calls | trace calls | guard denies |
|---|---|---|---|---|---|---|
| A bare | 13/15 | 1.000x | 14.7 | 12.67 | 0.00 | 0 |
| B guard v1 | 12/15 | 0.958x | 14.3 | 4.67 | 8.53 | 17 |
| C detector | 12/15 | **0.883x** | 12.7 | 6.07 | 5.67 | 13 |

Per-task: CR1 1.06x, CR2 1.09x, CR3 0.55x, CR4 0.60x, CR5 1.40x (C vs A).

## Findings

### 1. The regression is a property of the question shape, not of the class

The pre-registered framing assumed "light question" is one bucket that costs
1.45x. It is not. Of six light questions, only two cost more than the bare agent
under guard v1 — LT1 at 1.44x and LT2 at 1.72x — and those are exactly the two
that require *finding* something. The other four name the file, and trace-mcp is
already cheaper there (0.59x–0.92x) because a targeted `get_outline` beats
reading the whole file.

So the 1.45x reproduces, but only on the "where is X" shape. Reported as a class
average it vanishes into noise (B/A = 0.975x) — which is precisely why the issue
required two tables and why a third split is needed next time.

### 2. On that shape, the detector removes most of the regression — not all of it

C/B is 0.78x on LT1 and 0.71x on LT2: the detector cuts about a quarter of the
cost exactly where the regression lives, and leaves the other four light tasks
alone (0.95x–1.10x, i.e. unchanged). Guard denies on light questions: 5 under
v1, **0** under v2 — the shadow run's central claim reproduces live.

But LT1 and LT2 still cost 1.13x and 1.22x the bare agent. **The regression is
reduced, not removed**, and the residual is not the guard's doing: with the gate
silent, what remains is the model electing to spend calls on trace-mcp tools that
are in its tool list. The detector can only stop the guard from pushing; it
cannot stop the model from choosing.

### 3. The measured crawl advantage is ~1.13x, not 1.39x

C/A on crawls is 0.883x. TRA-705's 1.39x does not reproduce at this task size.
Two crawl tasks are actively *worse* through trace-mcp (CR2 1.09x, CR5 1.40x);
two are much better (CR3 0.55x, CR4 0.60x). The detector helps uniformly over
guard v1 (C/B between 0.86x and 1.00x on every crawl task) — it is v1's
intervention volume that was overpriced, not trace-mcp itself.

### 4. Call count did not inflate — the issue's own threat, checked

A rule that buys a cheaper call by forcing an extra turn eats its own saving.
It did not happen. Calls per run (native + trace), A/B/C: light 1.67 / 2.78 /
2.39; crawl 12.67 / 13.20 / **11.73**. The detector is below guard v1 in both
classes and below the bare agent on crawls. Turns follow: 14.7 / 14.3 / 12.7.

### 5. Defect found: the guard's Read branch was degraded everywhere

`mcp_sessions_active` in the status sentinel is initialised to 0 and
`setSessionsActive()` had **no production caller** — the only reference outside
`heartbeat.ts` was a unit test. The guard hook (since #301) treats
`mcp_sessions_active == 0` as proof that no MCP client is attached, sets
`HEARTBEAT_DEAD=1`, and the `Read` branch then takes `allow_with_context`
instead of reaching the navigation gate.

Net effect in production: **on `Read` — the largest navigation class — the guard
has been advisory-only, and the crawl detector has had no effect at all.** Only
`Bash`/`Grep`/`Glob` reached the gate. The shadow run could not see this: it
replays the classifier, not the health check.

Fixed here by initialising `mcp_sessions_active` to 1 for the stdio transport, a
transport where exactly one client exists by construction — it spawned the
process and holds its pipes. `serve-http` keeps 0 until its session registry is
wired to the handle; that is a separate change.

**Every number above was produced on the fixed build.** They describe the
detector as designed. As shipped before this fix, its effect on `Read` is zero.

## Power — stated, not glossed

Light solve rate is 18/18 in all three arms: a ceiling effect, not evidence of
safety. At n=18 the Wilson 95% interval is 82.4–100%, so a real drop of up to
~18 pp would be invisible. This measurement excludes gross degradation on light
questions and nothing finer.

The crawl class is *not* at ceiling (13/15, 12/15, 12/15) — the failures are
concentrated in CR4, which asks for imports that are function-local rather than
top-of-file. But the A-to-C gap there is a single run, well inside noise.

## Threats to validity

- **Task authoring.** Two checks were wrong in the task file and were corrected
  arm-blind after the fact: CR1's `JINA_API_KEY` (the module reads it as a
  Bearer token for a Jina call, not as "its" provider key — the question was
  ambiguous) and CR4's `CheckSubscriptionButtonCallback` (the import at
  `account.py:185` is commented out). Both the as-graded and re-graded solve
  rates are printed by `grid_analyze.py` so the correction is auditable.
- **Cost, not tokens.** Ratios are on `total_cost_usd`. Cache-read tokens
  dominate short runs, so these ratios understate what a long session sees.
- **Two repositories, one model, one machine.** Same limitation as TRA-730.
- **Guard state is per-project in `$TMPDIR`.** Runs were serialised to keep it
  clean; that is why the grid took ~80 minutes of wall time for 99 runs.

## Harness facts worth not rediscovering

- **Claude Code 2.1.239 ignores the per-hook `env` block in a settings file.**
  A hook declared with `"env": {"TRACE_MCP_GUARD_NAV_MIN": "1"}` runs with that
  variable unset. Arm variables must be exported by a wrapper script that
  `exec`s the real hook. This also means
  `scripts/trace-mcp-enable-guard.sh --strict`, which persists
  `TRACE_MCP_ENFORCE` into exactly that block, does not take effect on this
  version — worth its own issue.
- **`--settings <file>` hooks do load** alongside `--setting-sources project`.
- **`$TMPDIR` must match between the agent process and the hook.** A runtime
  that starts with `TMPDIR` unset resolves it to `/tmp` inside the hook while
  `trace-mcp serve` writes the sentinel into the real per-user temp dir; the
  guard then reads "server not running" and allows everything. Pin
  `getconf DARWIN_USER_TEMP_DIR`. This silently neutered the first pilot.
- Reproduction: `tasks.json`, `grid_run.py`, `grid_analyze.py`, `results.jsonl`
  and the per-arm settings files are attached to TRA-773.
