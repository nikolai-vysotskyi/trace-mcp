#!/usr/bin/env bash
# mention-sweep.sh
#
# The recurring half of "Sweeping GitHub code search for mentions we did not
# make" in ops/distribution.md. Runs the recorded queries, drops the repos we
# have already read, and prints only what is new since the last sweep.
#
# The point is not the queries — those are four lines anyone can retype. It is
# ops/mentions-seen.txt: without it every run re-reads btraceio/btrace and
# re-discovers that it is somebody else's tracer.
#
#   scripts/mention-sweep.sh            # print new repos
#   scripts/mention-sweep.sh --record   # ...and add them to the seen list
#
# Needs `gh` authenticated. Code search is capped at 10 requests/minute, so the
# queries are spaced; the whole run takes about two minutes.
#
# Two passes, because they see different things (TRA-1085, 2026-09-07):
#
#   1. `gh search code` — the modern backend. Exact on a hyphenated token, but
#      it returns nothing at all for a multi-term query like `trace-mcp serena`,
#      and it capped at 27 repos where the REST index had far more.
#   2. `gh api search/code` — the legacy indexer. It DOES answer multi-term
#      queries, which is the only way to find the files that name us next to a
#      competitor: somebody's evaluation, catalogue or comparison table. It also
#      splits on the hyphen, so `dynatrace-mcp` matches `trace-mcp`; pass 2
#      therefore keeps a repo only when a returned text fragment contains the
#      literal token. Without that filter half the results are Dynatrace.
#
# Pass 2 found `drguptavivek/fundus_img_xtract` (a user who mandates trace-mcp
# in their agent handoff) and `jgravelle/jcodemunch-mcp` (a rival's landscape
# table listing us at "16 languages"). Pass 1 had returned neither, ever.

set -euo pipefail

cd "$(dirname "$0")/.."
SEEN="ops/mentions-seen.txt"
record=false
[[ "${1:-}" == "--record" ]] && record=true

# The bare `trace-mcp` query is mostly name collisions; the qualified path and
# the domain are the two that only match us. All four stay because collisions
# are cheap once they are in the seen list, and a new one is worth knowing.
queries=(
  'trace-mcp'
  'nikolai-vysotskyi/trace-mcp'
  'trace-mcp.com'
  '"npx -y trace-mcp"'
)

hits=$(mktemp)
trap 'rm -f "$hits"' EXIT

# Pass 2's terms. Each pairs us with a name that only appears in a document
# ABOUT the category — an evaluation, a catalogue, an agent config. Add a rival
# here when `docs/_data/competitors.yml` grows one.
paired=(
  '"trace-mcp" serena'
  '"trace-mcp" repomix'
  '"trace-mcp" codebase-memory-mcp'
  '"trace-mcp" AGENTS.md'
  '"trace-mcp" CLAUDE.md'
)

for q in "${queries[@]}"; do
  echo "  pass 1: $q" >&2
  gh search code "$q" --limit 100 --json repository \
    --jq '.[].repository.nameWithOwner' >> "$hits" || echo "  (query failed: $q)" >&2
  sleep 7
done

# ponytail: one page per query. The tail past 100 results is dominated by the
# Dynatrace collision; page 2 if a query ever comes back full of real hits.
for q in "${paired[@]}"; do
  echo "  pass 2: $q" >&2
  gh api -X GET search/code -f "q=$q" -f per_page=100 \
    -H 'Accept: application/vnd.github.text-match+json' \
    --jq '.items[]
          | select([.text_matches[]?.fragment] | join(" ")
                   | test("(^|[^A-Za-z0-9_])trace-mcp"; "i"))
          | .repository.full_name' >> "$hits" 2>/dev/null \
    || echo "  (query failed: $q)" >&2
  sleep 7
done

# ponytail: plain grep -F -x against a flat list. Swap for a keyed file if the
# seen list ever needs per-repo notes — today the notes live in the ledger.
# Strip trailing `# note` comments as well as whole-line ones: the seen list
# carries a one-line reason next to most collisions and those must not become
# part of the repo name being matched.
seen=$(sed 's/#.*//; s/[[:space:]]*$//' "$SEEN" | grep -v '^$')

new=$(sort -u "$hits" \
  | grep -v '^nikolai-vysotskyi/trace-mcp$' \
  | grep -vxFf <(echo "$seen") || true)

if [[ -z "$new" ]]; then
  echo "No repos outside the seen list. Nothing to read." >&2
  exit 0
fi

echo
echo "New repos mentioning trace-mcp ($(echo "$new" | wc -l | tr -d ' ')):"
echo "$new" | sed 's/^/  /'
echo
echo "Read the matched file before recording anything — most bare-name hits are"
echo "collisions. Genuine surfaces get a row in ops/distribution.md; everything"
echo "else gets a line in $SEEN so the next sweep stays quiet."

if $record; then
  { echo; echo "# swept $(date -u +%Y-%m-%d)"; echo "$new"; } >> "$SEEN"
  echo
  echo "Recorded in $SEEN. Classify them there before committing."
fi
