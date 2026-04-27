/**
 * ClackPlugin — detects interactive CLI prompt libraries (@clack/prompts,
 * inquirer, prompts, enquirer) and extracts prompt definitions and wizard flows.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok, type TraceMcpResult } from '../../../../../errors.js';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';

const PROMPT_PACKAGES = [
  '@clack/prompts',
  '@clack/core',
  'inquirer',
  '@inquirer/prompts',
  'prompts',
  'enquirer',
];

// clack.intro('...'), clack.outro('...')
const CLACK_FLOW_RE = /(?:intro|outro|spinner|log\.(?:info|warn|error|success|step))\s*\(/g;

// clack.text({...}), clack.select({...}), clack.confirm({...}), clack.multiselect({...})
const CLACK_PROMPT_RE =
  /(?:text|select|confirm|multiselect|selectKey|group|password|isCancel)\s*\(\s*\{/g;

// inquirer.prompt([...]), prompt({...})
const INQUIRER_PROMPT_RE = /(?:inquirer\.prompt|prompt)\s*\(\s*[[{]/g;

// Import detection
const PROMPT_IMPORT_RE =
  /(?:import|require)\s*(?:\(|{)?\s*.*(?:@clack\/prompts|inquirer|enquirer)\b/;

export class ClackPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'clack',
    version: '1.0.0',
    priority: 40,
    category: 'tooling',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      for (const pkg of PROMPT_PACKAGES) {
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
      for (const p of PROMPT_PACKAGES) {
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
        { name: 'prompt_flow', category: 'cli', description: 'Interactive prompt flow step' },
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
    const result: FileParseResult = { status: 'ok', symbols: [], edges: [] };

    const hasImport = PROMPT_IMPORT_RE.test(source);
    const hasClackFlow = CLACK_FLOW_RE.test(source);
    const hasClackPrompt = CLACK_PROMPT_RE.test(source);
    const hasInquirerPrompt = INQUIRER_PROMPT_RE.test(source);

    if (hasClackFlow && hasClackPrompt) {
      result.frameworkRole = 'cli_wizard';
    } else if (hasClackPrompt || hasInquirerPrompt) {
      result.frameworkRole = 'cli_prompts';
    } else if (hasImport) {
      result.frameworkRole = 'cli_interactive';
    }

    return ok(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}
