/**
 * Hermes Agent guard hook installer.
 *
 * Hermes supports "shell hooks" declared in `~/.hermes/config.yaml` under the
 * `hooks:` block (see Hermes docs → user-guide → features → Event Hooks). On
 * every tool call Hermes spawns the hook script with a JSON payload on stdin
 * and reads JSON from stdout — `{"decision":"block","reason":"..."}` vetoes
 * the call, anything else lets it through.
 *
 * We register a single `pre_tool_call` hook with matcher="terminal" that
 * vetoes obvious "grep/find over source code" invocations and nudges the
 * agent toward the equivalent trace-mcp tools. We deliberately keep the
 * veto list narrow — false positives here are worse than missing a bad
 * pattern, because the agent becomes un-usable if ordinary shell commands
 * get rejected.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import type { InitStepResult } from './types.js';

const HERMES_GUARD_VERSION = '0.1.1';

function hermesHome(): string {
  return process.env.HERMES_HOME ?? path.join(os.homedir(), '.hermes');
}

function guardScriptPath(): string {
  return path.join(hermesHome(), 'agent-hooks', 'trace-mcp-guard.sh');
}

function configYamlPath(): string {
  return path.join(hermesHome(), 'config.yaml');
}

const GUARD_SCRIPT = `#!/usr/bin/env bash
# trace-mcp-hermes-guard v${HERMES_GUARD_VERSION}
# Managed by trace-mcp — re-run \`trace-mcp init --mcp-client hermes\` to refresh.
#
# Hermes shell hook for pre_tool_call. Receives JSON on stdin, prints JSON on
# stdout. Blocks obvious "grep/find/rg/ag over source code" terminal commands
# and suggests the trace-mcp equivalent. Everything else passes through.
set -u

payload="$(cat -)"

# Extract fields without requiring jq: payload keys we need have simple shapes.
# Fall back to empty string if the field is missing.
tool_name=$(printf '%s' "$payload" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("tool_name") or "")' 2>/dev/null || true)

pass() { printf '{}\\n'; exit 0; }
block() { printf '{"decision":"block","reason":%s}\\n' "$(printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"; exit 0; }

# Only intercept the terminal tool — every other tool passes through.
if [ "$tool_name" != "terminal" ]; then
  pass
fi

cmd=$(printf '%s' "$payload" | python3 -c 'import json,sys; d=json.load(sys.stdin); ti=d.get("tool_input") or {}; print(ti.get("command") or "")' 2>/dev/null || true)

# Strip leading whitespace, grab the first "word" (the binary name).
first=$(printf '%s' "$cmd" | sed -E 's/^[[:space:]]+//' | awk '{print $1}')

case "$first" in
  grep|rg|ack|ag)
    # Allow greps that scope themselves with --include= or explicit file args.
    # We only block the unconstrained "find me this string anywhere" shape.
    if printf '%s' "$cmd" | grep -qE '(-r|--recursive|\\s-R\\b)'; then
      block "Use trace-mcp instead: 'search' (for symbols) or 'search_text' (for raw text). These are faster, ranked, and understand the dependency graph. If you truly need a recursive grep, narrow the scope with --include or a specific subdirectory."
    fi
    ;;
  find)
    # Block find walks that look for source files by extension (the classic
    # "discover the codebase" antipattern). Passing through find calls with
    # explicit paths or non-code extensions.
    if printf '%s' "$cmd" | grep -qE -- "-name[[:space:]]+[\\"']?\\*\\.(ts|tsx|js|jsx|py|go|rs|java|kt|rb|php|vue|svelte|c|cpp|h|hpp|cs|scala|swift)"; then
      block "Use trace-mcp 'search' or 'get_project_map' instead of 'find -name \\"*.<lang>\\"'. trace-mcp already knows every indexed file and can filter by language and symbol kind."
    fi
    ;;
esac

pass
`;

export interface HermesHooksOptions {
  dryRun?: boolean;
  /** Pre-approve our hook in `~/.hermes/shell-hooks-allowlist.json` so it
   *  actually fires at runtime without requiring the user to run
   *  `hermes --accept-hooks` once. Matches Hermes's per-(event, command)
   *  consent model — we only allowlist our own entry, not the global
   *  `hooks_auto_accept: true` flag which would catch all hooks including
   *  future third-party ones. Off by default; switched on by the init flow
   *  for standard/max installs. */
  autoAllowlist?: boolean;
}

export function installHermesHooks(opts: HermesHooksOptions = {}): InitStepResult[] {
  const results: InitStepResult[] = [];
  results.push(writeGuardScript(opts));
  results.push(wireIntoConfigYaml(opts));
  if (opts.autoAllowlist) {
    results.push(allowlistGuardCommand(opts));
  }
  return results;
}

// ── Guard script ────────────────────────────────────────────────────────

function writeGuardScript(opts: HermesHooksOptions): InitStepResult {
  const dest = guardScriptPath();
  const existing = safeRead(dest);
  const alreadyUpToDate = existing?.includes(`trace-mcp-hermes-guard v${HERMES_GUARD_VERSION}`);

  if (opts.dryRun) {
    if (!existing) return { target: dest, action: 'skipped', detail: 'Would install guard script' };
    if (alreadyUpToDate)
      return { target: dest, action: 'skipped', detail: 'Would keep existing guard script' };
    return {
      target: dest,
      action: 'skipped',
      detail: `Would upgrade guard script to v${HERMES_GUARD_VERSION}`,
    };
  }

  if (alreadyUpToDate) {
    ensureExecutable(dest);
    return { target: dest, action: 'already_configured' };
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, GUARD_SCRIPT, { mode: 0o755 });
  ensureExecutable(dest);
  return {
    target: dest,
    action: existing ? 'updated' : 'created',
    detail: existing
      ? `Upgraded to v${HERMES_GUARD_VERSION}`
      : `Installed v${HERMES_GUARD_VERSION}`,
  };
}

function ensureExecutable(file: string): void {
  try {
    fs.chmodSync(file, 0o755);
  } catch {
    // chmod failures are non-fatal — the file may already have the right mode
    // or we may be on a filesystem that ignores mode bits.
  }
}

function safeRead(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

// ── config.yaml wiring ──────────────────────────────────────────────────

interface HookEntry {
  matcher?: string;
  command: string;
  timeout?: number;
}

function wireIntoConfigYaml(opts: HermesHooksOptions): InitStepResult {
  const cfgPath = configYamlPath();
  const script = guardScriptPath();
  const desired: HookEntry = { matcher: 'terminal', command: script, timeout: 5 };

  if (!fs.existsSync(cfgPath)) {
    // Hermes hasn't run setup here — no config to edit. Initializing config.yaml
    // ourselves would conflict with Hermes's own setup wizard, so leave it.
    return {
      target: cfgPath,
      action: 'skipped',
      detail: 'Hermes config.yaml not found — run `hermes setup` first, then re-run trace-mcp init',
    };
  }

  const raw = fs.readFileSync(cfgPath, 'utf-8');
  const doc = YAML.parseDocument(raw);
  if (doc.errors.length > 0) {
    return {
      target: cfgPath,
      action: 'skipped',
      detail: `Hermes config.yaml has parse errors: ${doc.errors[0].message}`,
    };
  }

  const existingMatch = findExistingEntry(doc, desired);
  if (existingMatch === 'exact') {
    return { target: cfgPath, action: 'already_configured', detail: 'pre_tool_call hook' };
  }

  if (opts.dryRun) {
    return {
      target: cfgPath,
      action: 'skipped',
      detail:
        existingMatch === 'stale'
          ? 'Would refresh stale trace-mcp hook entry'
          : 'Would add pre_tool_call hook',
    };
  }

  upsertHookEntry(doc, desired);
  fs.writeFileSync(cfgPath, doc.toString({ lineWidth: 0 }));
  const base =
    existingMatch === 'stale'
      ? 'Refreshed trace-mcp pre_tool_call hook'
      : 'Added trace-mcp pre_tool_call hook';
  // Hermes requires per-(event, command) first-use consent. If the caller
  // didn't ask us to auto-allowlist, the hook is dormant until the user
  // approves at the TTY — say so explicitly to avoid silent surprises.
  const suffix = opts.autoAllowlist
    ? ''
    : ' — approve at next `hermes` launch (or use `hermes --accept-hooks` once) so it actually fires';
  return { target: cfgPath, action: 'updated', detail: base + suffix };
}

// ── Allowlist (per-(event, command) consent) ────────────────────────────

interface ApprovalEntry {
  event: string;
  command: string;
  approved_at?: string;
  script_mtime_at_approval?: string;
}

interface AllowlistFile {
  approvals: ApprovalEntry[];
  [key: string]: unknown;
}

function allowlistPath(): string {
  return path.join(hermesHome(), 'shell-hooks-allowlist.json');
}

function allowlistGuardCommand(opts: HermesHooksOptions): InitStepResult {
  const cmd = guardScriptPath();
  const event = 'pre_tool_call';
  const target = allowlistPath();

  const existing = readAllowlist(target);
  const already = existing.approvals.some((e) => e && e.event === event && e.command === cmd);

  if (already) {
    return { target, action: 'already_configured', detail: 'Hermes shell-hook allowlist' };
  }

  if (opts.dryRun) {
    return {
      target,
      action: 'skipped',
      detail: 'Would pre-approve trace-mcp hook in Hermes allowlist',
    };
  }

  // Match Hermes's _record_approval shape exactly, so `hermes hooks list`
  // renders our row the same way as user-approved entries (timestamps etc.).
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const scriptMtimeIso = safeMtimeIso(cmd);
  const entry = {
    event,
    command: cmd,
    approved_at: nowIso,
    ...(scriptMtimeIso ? { script_mtime_at_approval: scriptMtimeIso } : {}),
  };
  const next: AllowlistFile = { ...existing, approvals: [...existing.approvals, entry] };
  writeAllowlistAtomic(target, next);
  return {
    target,
    action: existing.approvals.length === 0 ? 'created' : 'updated',
    detail: 'Pre-approved trace-mcp hook (standard/max install)',
  };
}

function safeMtimeIso(p: string): string | null {
  try {
    return fs
      .statSync(p)
      .mtime.toISOString()
      .replace(/\.\d{3}Z$/, 'Z');
  } catch {
    return null;
  }
}

function readAllowlist(p: string): AllowlistFile {
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as AllowlistFile;
      if (!Array.isArray(obj.approvals)) obj.approvals = [];
      return obj;
    }
  } catch {
    // missing file / malformed JSON — fall through to empty skeleton
  }
  return { approvals: [] };
}

function writeAllowlistAtomic(p: string, data: AllowlistFile): void {
  // Mirror Hermes's own mkstemp-then-rename pattern (agent/shell_hooks.py
  // `save_allowlist`) so a concurrent Hermes startup doesn't read a torn file.
  // We skip the flock Hermes uses cross-process — init is a one-shot write
  // and the blast radius of a rare race is "user re-runs init".
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, p);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
    throw e;
  }
}

type MatchKind = 'exact' | 'stale' | 'none';

function findExistingEntry(doc: YAML.Document, desired: HookEntry): MatchKind {
  const hooks = doc.getIn(['hooks', 'pre_tool_call']);
  if (!YAML.isSeq(hooks)) return 'none';
  let foundOurs: MatchKind = 'none';
  for (const item of hooks.items) {
    if (!YAML.isMap(item)) continue;
    const command = String(item.get('command') ?? '');
    if (command !== desired.command) continue;
    // One of ours. Is it byte-identical?
    const matcher = item.get('matcher');
    const timeout = item.get('timeout');
    if (matcher === desired.matcher && timeout === desired.timeout) {
      return 'exact';
    }
    foundOurs = 'stale';
  }
  return foundOurs;
}

function upsertHookEntry(doc: YAML.Document, desired: HookEntry): void {
  // Ensure `hooks:` is a block-style map (not the `{}` flow-style empty dict
  // Hermes's default config ships with). Using block style keeps the file
  // hand-editable and matches the shape shown in Hermes's own docs.
  const hooksNode = doc.get('hooks');
  if (!YAML.isMap(hooksNode)) {
    const fresh = doc.createNode({}) as YAML.YAMLMap;
    fresh.flow = false;
    doc.set('hooks', fresh);
  } else {
    hooksNode.flow = false;
  }

  const preList = doc.getIn(['hooks', 'pre_tool_call']);
  if (!YAML.isSeq(preList)) {
    const fresh = doc.createNode([]) as YAML.YAMLSeq;
    fresh.flow = false;
    doc.setIn(['hooks', 'pre_tool_call'], fresh);
  } else {
    preList.flow = false;
  }
  const seq = doc.getIn(['hooks', 'pre_tool_call']) as YAML.YAMLSeq;

  // Drop any existing trace-mcp entry (identified by command path), then append.
  const keep = seq.items.filter((item) => {
    if (!YAML.isMap(item)) return true;
    return String(item.get('command') ?? '') !== desired.command;
  });
  seq.items = keep;
  const entry = doc.createNode(desired) as YAML.YAMLMap;
  entry.flow = false;
  seq.add(entry);
}
