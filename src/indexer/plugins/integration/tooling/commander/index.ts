/**
 * CommanderPlugin — detects CLI apps built with commander.js / yargs / clipanion
 * and extracts command definitions, options, and arguments.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok, type TraceMcpResult } from '../../../../../errors.js';
import type {
  FileParseResult,
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';

// --- Detection -----------------------------------------------------------------

const CLI_PACKAGES = ['commander', 'yargs', '@oclif/core', 'clipanion', 'cac', 'citty'];

// --- Extraction patterns -------------------------------------------------------

// .command('name', 'description')  or  .command('name <arg>')
const COMMAND_RE = /\.command\(\s*['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]*)['"]\s*)?/g;

// .option('-f, --flag <value>', 'description')
const OPTION_RE = /\.option\(\s*['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]*)['"]\s*)?/g;

// .argument('<name>', 'description')
const _ARGUMENT_RE = /\.argument\(\s*['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]*)['"]\s*)?/g;

// .name('cli-name')
const _NAME_RE = /\.name\(\s*['"]([^'"]+)['"]/g;

// .description('text')
const _DESCRIPTION_RE = /\.description\(\s*['"]([^'"]+)['"]/g;

// new Command('name') or program = new Command()
const NEW_COMMAND_RE = /new\s+Command\(\s*(?:['"]([^'"]+)['"])?\s*\)/g;

// Commander/yargs import detection
const CLI_IMPORT_RE = /(?:import|require)\s*(?:\(|{)?\s*.*(?:commander|Command|yargs)\b/;

// --- Helpers -------------------------------------------------------------------

interface CliCommand {
  name: string;
  description?: string;
  options: string[];
  arguments: string[];
}

function extractCliCommands(source: string): CliCommand[] {
  const commands: CliCommand[] = [];

  const cmdRe = new RegExp(COMMAND_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = cmdRe.exec(source)) !== null) {
    // Extract command name (first word before any arguments)
    const fullCmd = m[1];
    const name = fullCmd.split(/\s/)[0];
    commands.push({
      name,
      description: m[2] || undefined,
      options: [],
      arguments: [],
    });
  }

  // Also detect `new Command('name')` patterns
  const newCmdRe = new RegExp(NEW_COMMAND_RE.source, 'g');
  while ((m = newCmdRe.exec(source)) !== null) {
    if (m[1] && !commands.some((c) => c.name === m![1])) {
      commands.push({ name: m[1], options: [], arguments: [] });
    }
  }

  return commands;
}

function extractCliOptions(source: string): string[] {
  const options: string[] = [];
  const re = new RegExp(OPTION_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    options.push(m[1]);
  }
  return options;
}

// --- Plugin --------------------------------------------------------------------

export class CommanderPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'commander',
    version: '1.0.0',
    priority: 30,
    category: 'tooling',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      for (const pkg of CLI_PACKAGES) {
        if (pkg in deps) return true;
      }
    }

    try {
      const pkgPath = path.join(ctx.rootPath, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      for (const p of CLI_PACKAGES) {
        if (p in deps) return true;
      }
    } catch {
      return false;
    }

    return false;
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'cli_command', category: 'cli', description: 'CLI command definition' },
        { name: 'cli_subcommand', category: 'cli', description: 'CLI subcommand relationship' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (!['typescript', 'javascript'].includes(language)) {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const result: FileParseResult = { status: 'ok', symbols: [], routes: [], edges: [] };

    const hasImport = CLI_IMPORT_RE.test(source);
    const commands = extractCliCommands(source);
    const options = extractCliOptions(source);

    if (commands.length > 0) {
      result.frameworkRole = 'cli_command';
      for (const cmd of commands) {
        result.routes!.push({
          method: 'CLI',
          uri: cmd.name,
        });
      }
    } else if (options.length > 0 && hasImport) {
      result.frameworkRole = 'cli_options';
    } else if (hasImport) {
      result.frameworkRole = 'cli_entry';
    }

    return ok(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];
    return ok(edges);
  }
}
