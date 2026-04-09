# trace-mcp Agent Skills

Reusable [Agent Skills](https://skills.sh) that teach any MCP-compatible coding agent (Claude Code, Cursor, Windsurf, OpenCode, Codex, etc.) to use [trace-mcp](https://github.com/nikolai-vysotskyi/trace-mcp) effectively.

trace-mcp is a framework-aware code intelligence MCP server that exposes 120+ tools over a cross-language dependency graph. These skills encode the routing rules, workflows, and token-efficiency best practices so your agent uses trace-mcp instead of brute-reading files with `Read`/`Grep`/`Glob`.

## Install

```bash
# Install all trace-mcp skills
npx skills add nikolai-vysotskyi/trace-mcp

# Or install a specific skill
npx skills add nikolai-vysotskyi/trace-mcp --skill trace-mcp
```

Requires the [trace-mcp](https://github.com/nikolai-vysotskyi/trace-mcp) MCP server to be installed and indexed in your project:

```bash
npm install -g trace-mcp
trace-mcp init   # configures your MCP client
trace-mcp add    # indexes the current project
```

## Skills in this package

| Skill | Purpose |
|---|---|
| [`trace-mcp`](./trace-mcp/SKILL.md) | Core routing rules — when to use each trace-mcp tool instead of `Read`/`Grep`/`Glob`. The main entry point. |
| [`trace-mcp-refactoring`](./trace-mcp-refactoring/SKILL.md) | Safe refactoring workflow — risk assessment, renames across all files, extract function. |
| [`trace-mcp-codemod`](./trace-mcp-codemod/SKILL.md) | Bulk mechanical changes via `apply_codemod` instead of repeated `Edit` calls. |
| [`trace-mcp-pre-commit`](./trace-mcp-pre-commit/SKILL.md) | Security scan, quality gates, antipattern detection before commit/PR. |

## Why use these skills?

Agents without routing guidance will happily `Grep` a 5,000-file repo, `Read` 15 files to understand one feature, and miss cross-file references when renaming. These skills encode the rules that cut token usage by up to 99% on exploration tasks while improving accuracy.

See the [benchmark results in the main repo](https://github.com/nikolai-vysotskyi/trace-mcp#token-savings) for concrete numbers.

## License

Apache 2.0 — same as trace-mcp.
