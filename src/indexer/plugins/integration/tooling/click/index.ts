/**
 * ClickPlugin — detects the click Python CLI framework and extracts the command
 * tree: commands/groups, their options/arguments, and subcommand → group linkage.
 */
import { ok, type TraceMcpResult } from '../../../../../errors.js';
import type {
  FileParseResult,
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';
import { hasAnyPythonDep } from '../../_shared/python-deps.js';

const PACKAGES = ['click'] as const;

const IMPORT_RE = /^\s*(?:from\s+click(?:\.\w+)*\s+import|import\s+click)\b/m;

/** A decorator block immediately followed by `def name(`. */
const DECORATED_FN_RE = /((?:^[ \t]*@[^\n]*\n)+)[ \t]*def[ \t]+(\w+)[ \t]*\(/gm;

/** `@click.command(...)`, `@cli.group(...)`, or bare `@command(...)` after a from-import. */
const COMMAND_DECORATOR_RE = /^[ \t]*@\s*(?:(\w+)\s*\.\s*)?(command|group)\s*(?:\(([^)]*)\))?/gm;

/** `@click.option('--x')` / `@argument('name')` */
const PARAM_DECORATOR_RE = /^[ \t]*@\s*(?:\w+\s*\.\s*)?(option|argument)\s*\(\s*['"]([^'"]+)['"]/gm;

/** `group.add_command(cmd)` / `cli.add_command(hello, name="hi")` */
const ADD_COMMAND_RE = /\b(\w+)\s*\.\s*add_command\(\s*(\w+)/g;

/** First positional string literal of a decorator call — the explicit command name. */
const EXPLICIT_NAME_RE = /^\s*(?:name\s*=\s*)?['"]([^'"]+)['"]/;

interface ClickCommand {
  /** CLI-visible name. */
  name: string;
  /** Python function implementing it. */
  function: string;
  kind: 'command' | 'group';
  /** Variable name of the parent group, when declared via `@parent.command()`. */
  parent?: string;
  params: { name: string; kind: 'option' | 'argument' }[];
  line: number;
}

/** click derives a command name from the function name, underscores becoming dashes. */
function defaultName(fnName: string): string {
  return fnName.replace(/_/g, '-').replace(/^-+|-+$/g, '') || fnName;
}

function extractCommands(source: string): ClickCommand[] {
  const commands: ClickCommand[] = [];
  const lineOf = (idx: number) => source.slice(0, idx).split('\n').length;

  for (const m of source.matchAll(DECORATED_FN_RE)) {
    const block = m[1];
    const fnName = m[2];

    const cmdRe = new RegExp(COMMAND_DECORATOR_RE.source, 'gm');
    const cmdMatch = cmdRe.exec(block);
    if (!cmdMatch) continue;

    const owner = cmdMatch[1];
    // `@click.command()` is the framework itself; `@cli.command()` names a parent group.
    const parent = owner && owner !== 'click' ? owner : undefined;
    const explicit = cmdMatch[3]?.match(EXPLICIT_NAME_RE)?.[1];

    const params: ClickCommand['params'] = [];
    for (const p of block.matchAll(new RegExp(PARAM_DECORATOR_RE.source, 'gm'))) {
      params.push({ name: p[2], kind: p[1] as 'option' | 'argument' });
    }

    commands.push({
      name: explicit ?? defaultName(fnName),
      function: fnName,
      kind: cmdMatch[2] as 'command' | 'group',
      parent,
      params,
      line: lineOf(m.index ?? 0),
    });
  }

  return commands;
}

export class ClickPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'click',
    version: '1.0.0',
    priority: 30,
    category: 'tooling',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    return hasAnyPythonDep(ctx, PACKAGES);
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 'click_command',
          category: 'cli',
          description: '@click.command / @click.group command entry point',
        },
        {
          name: 'click_param',
          category: 'cli',
          description: '@click.option / @click.argument → its command',
        },
        {
          name: 'click_subcommand',
          category: 'cli',
          description: 'Subcommand → parent click group',
        },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (language !== 'python') {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const hasImport = IMPORT_RE.test(source);
    if (!hasImport) {
      return ok({ status: 'ok', symbols: [] });
    }

    const result: FileParseResult = { status: 'ok', symbols: [], routes: [], edges: [] };
    const lineOf = (idx: number) => source.slice(0, idx).split('\n').length;
    const commands = extractCommands(source);

    for (const cmd of commands) {
      result.routes!.push({ method: 'CLI', uri: cmd.name });
      result.edges!.push({
        edgeType: 'click_command',
        metadata: {
          name: cmd.name,
          function: cmd.function,
          kind: cmd.kind,
          filePath,
          line: cmd.line,
        },
      });

      for (const p of cmd.params) {
        result.edges!.push({
          edgeType: 'click_param',
          metadata: {
            command: cmd.name,
            param: p.name,
            kind: p.kind,
            filePath,
            line: cmd.line,
          },
        });
      }

      // `@parent.command()` — the parent is a group variable, resolved by function name.
      if (cmd.parent) {
        result.edges!.push({
          edgeType: 'click_subcommand',
          metadata: {
            group: cmd.parent,
            command: cmd.name,
            function: cmd.function,
            filePath,
            line: cmd.line,
          },
        });
      }
    }

    // `group.add_command(fn)` — the second form of the same linkage.
    for (const m of source.matchAll(ADD_COMMAND_RE)) {
      const fn = m[2];
      const target = commands.find((c) => c.function === fn);
      result.edges!.push({
        edgeType: 'click_subcommand',
        metadata: {
          group: m[1],
          command: target?.name ?? defaultName(fn),
          function: fn,
          filePath,
          line: lineOf(m.index ?? 0),
        },
      });
    }

    if (commands.length > 0) {
      result.frameworkRole = 'click_cli';
    } else if (hasImport) {
      result.frameworkRole = 'click_import';
    }

    return ok(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}
