#!/usr/bin/env python3
"""Rebuild the TRA-758 offline gate dataset from real Claude Code transcripts.

TRA-758 measured a line-level selector against 497 real Read/Bash calls and
failed the recall gate. Its dataset was never committed (10.6 MB of private
source), so TRA-861 re-extracts it with the same documented methodology and
re-runs the same metric with one variable changed: the unit of selection.

Methodology (unchanged from TRA-758):
  * corpus      : every session transcript under ~/.claude/projects
  * working band: outputs of 2 000 .. 64 000 chars (below is not worth
                  compressing, above the host persists it upstream)
  * ground truth: a line counts as evidence when it reappears in the next 12
                  assistant turns -- quoted in text, carried into an Edit's
                  old_string, or transferred as a path/identifier into a
                  later tool call.  >= 10 significant chars, so boilerplate
                  ("}", "return") cannot be credited as evidence.

Only past-facing fields are stored as the query (the last user message plus
the assistant's own stated intent right before the call): a selector must not
be able to see the future the labels are built from.

Usage: python3 extract.py [--out dataset.json] [--limit N]
"""

import argparse
import glob
import json
import os
import random
import re
import sys

MIN_CHARS = 2_000
MAX_CHARS = 64_000
FUTURE_TURNS = 12
MIN_EVIDENCE_CHARS = 10
MIN_EVIDENCE_LINES = 2

BUCKETS = [(2_000, 4_000), (4_000, 8_000), (8_000, 16_000), (16_000, 32_000), (32_000, 64_000)]
# The strata TRA-758 sampled, so the two runs are comparable call for call.
BUCKET_QUOTA = {
    (2_000, 4_000): (65, 75),
    (4_000, 8_000): (65, 75),
    (8_000, 16_000): (60, 60),
    (16_000, 32_000): (40, 40),
    (32_000, 64_000): (17, 0),
}

READ_PREFIX = re.compile(r"^\s*\d+\t")
IDENT = re.compile(r"[A-Za-z0-9_./:\-]{6,}")


def norm(line: str) -> str:
    return " ".join(line.split())


def significant(line: str) -> bool:
    return len(re.sub(r"[^A-Za-z0-9_]", "", line)) >= MIN_EVIDENCE_CHARS


def strip_read_prefix(line: str) -> str:
    return READ_PREFIX.sub("", line, count=1) if READ_PREFIX.match(line) else line


def load_records(path):
    """Flatten a transcript into ordered records we can look forward from."""
    records = []
    try:
        raw = open(path, encoding="utf-8", errors="replace").read().splitlines()
    except OSError:
        return records
    for line in raw:
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        kind = entry.get("type")
        if kind not in ("assistant", "user"):
            continue
        content = (entry.get("message") or {}).get("content")
        rec = {"role": kind, "texts": [], "tool_uses": [], "tool_results": {}}
        if isinstance(content, str):
            rec["texts"].append(content)
        elif isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type")
                if btype == "text":
                    rec["texts"].append(block.get("text") or "")
                elif btype == "thinking":
                    rec["texts"].append(block.get("thinking") or "")
                elif btype == "tool_use":
                    rec["tool_uses"].append(
                        {"id": block.get("id"), "name": block.get("name"), "input": block.get("input") or {}}
                    )
                elif btype == "tool_result":
                    body = block.get("content")
                    if isinstance(body, str):
                        rec["tool_results"][block.get("tool_use_id")] = body
        records.append(rec)
    return records


def future_text(records, start, turns=FUTURE_TURNS):
    """Everything the session said and did in the next `turns` assistant turns."""
    chunks, seen = [], 0
    for rec in records[start + 1 :]:
        if rec["role"] == "assistant":
            seen += 1
            if seen > turns:
                break
        chunks.extend(rec["texts"])
        for use in rec["tool_uses"]:
            chunks.append(json.dumps(use["input"], ensure_ascii=False))
    return "\n".join(chunks)


def evidence_lines(lines, future, tool):
    """Indices of lines the session demonstrably used afterwards."""
    fut_norm = norm(future)
    fut_idents = set(IDENT.findall(future)) if tool == "Bash" else None
    hits = []
    for i, line in enumerate(lines):
        body = strip_read_prefix(line)
        if not significant(body):
            continue
        n = norm(body)
        if len(n) >= MIN_EVIDENCE_CHARS and n in fut_norm:
            hits.append(i)
            continue
        if fut_idents:
            # A shell result is used by lifting a path / test id / sha out of it.
            if any(tok in fut_idents for tok in IDENT.findall(body)):
                hits.append(i)
    return hits


def query_for(records, idx):
    """What the hook could actually know at call time: last user ask + stated intent."""
    intent = "\n".join(records[idx]["texts"])[-1_500:]
    ask = ""
    for rec in reversed(records[:idx]):
        if rec["role"] == "user" and rec["texts"]:
            joined = "\n".join(rec["texts"]).strip()
            if joined and not joined.startswith("<"):
                ask = joined[-2_000:]
                break
    return (ask + "\n" + intent).strip()


def bucket_of(n):
    for lo, hi in BUCKETS:
        if lo <= n < hi:
            return (lo, hi)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "dataset.json"))
    ap.add_argument("--projects", default=os.path.expanduser("~/.claude/projects"))
    ap.add_argument("--seed", type=int, default=861)
    args = ap.parse_args()

    pool = []
    transcripts = sorted(glob.glob(os.path.join(args.projects, "*", "*.jsonl")))
    if not transcripts:
        # A sandboxed $HOME points somewhere without transcripts, and an empty
        # dataset otherwise looks like a real (and very wrong) result.
        sys.exit(f"no transcripts under {args.projects} — pass --projects explicitly")
    for n, path in enumerate(transcripts):
        if n % 200 == 0:
            print(f"  {n}/{len(transcripts)} transcripts, {len(pool)} candidates", file=sys.stderr)
        records = load_records(path)
        pending = {}
        for idx, rec in enumerate(records):
            for use in rec["tool_uses"]:
                if use["name"] in ("Read", "Bash"):
                    pending[use["id"]] = (idx, use)
            for tid, body in rec["tool_results"].items():
                if tid not in pending:
                    continue
                call_idx, use = pending.pop(tid)
                if not (MIN_CHARS <= len(body) < MAX_CHARS):
                    continue
                if body.startswith("<persisted-output>"):
                    continue
                lines = body.split("\n")
                ev = evidence_lines(lines, future_text(records, idx), use["name"])
                if len(ev) < MIN_EVIDENCE_LINES:
                    continue
                pool.append(
                    {
                        "tool": use["name"],
                        "input": use["input"],
                        "chars": len(body),
                        "bucket": f"{bucket_of(len(body))[0]}-{bucket_of(len(body))[1]}",
                        "query": query_for(records, call_idx),
                        "output": body,
                        "evidence": ev,
                    }
                )

    rng = random.Random(args.seed)
    rng.shuffle(pool)
    picked, counts = [], {}
    for call in pool:
        lo, hi = (int(x) for x in call["bucket"].split("-"))
        quota = BUCKET_QUOTA[(lo, hi)][0 if call["tool"] == "Read" else 1]
        key = (call["bucket"], call["tool"])
        if counts.get(key, 0) >= quota:
            continue
        counts[key] = counts.get(key, 0) + 1
        picked.append(call)

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(picked, fh, ensure_ascii=False)
    reads = sum(1 for c in picked if c["tool"] == "Read")
    print(f"pool={len(pool)} picked={len(picked)} (Read {reads}, Bash {len(picked) - reads}) -> {args.out}")
    for key in sorted(counts):
        print(f"  {key[0]:>13} {key[1]:<5} {counts[key]}")


if __name__ == "__main__":
    main()
