/**
 * MuiPlugin — Detects Material UI (MUI) usage and extracts:
 * - Theme definitions (createTheme, ThemeProvider)
 * - styled() component wrappers
 * - sx prop usage patterns
 * - MUI component imports for dependency tracking
 *
 * Supports MUI v5+ (@mui/material) and legacy v4 (@material-ui/core).
 */
import { ok } from 'neverthrow';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  RawRoute,
  RawComponent,
  ResolveContext,
} from '../../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../../errors.js';

// ── Theme extraction ──────────────────────────────────────────────────────

/**
 * Match: createTheme({ palette: { ... }, typography: { ... } })
 * or: const theme = createTheme(...)
 */
const CREATE_THEME_RE =
  /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*createTheme\s*\(/g;

/**
 * Match: styled(Component)(...) or styled('div')(...)
 */
const STYLED_RE =
  /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*styled\s*\(\s*(?:['"](\w+)['"]|(\w+))\s*\)/g;

interface MuiTheme {
  name: string;
  sections: string[];    // e.g. ['palette', 'typography', 'spacing']
}

interface MuiStyledComponent {
  name: string;
  baseComponent: string; // 'div', 'Button', etc.
}

/** Extract createTheme() definitions and their top-level configuration keys. */
function extractMuiThemes(source: string): MuiTheme[] {
  const themes: MuiTheme[] = [];
  const re = new RegExp(CREATE_THEME_RE.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = re.exec(source)) !== null) {
    const name = match[1];
    const startPos = match.index + match[0].length;
    const body = extractParenBody(source, startPos);

    // Extract top-level keys: palette, typography, spacing, etc.
    const sections: string[] = [];
    const keyRe = /(\w+)\s*:\s*[{\['"]/g;
    let keyMatch: RegExpExecArray | null;
    while ((keyMatch = keyRe.exec(body)) !== null) {
      const key = keyMatch[1];
      if (!['mode', 'primary', 'secondary', 'error', 'warning', 'info', 'success'].includes(key)) {
        sections.push(key);
      }
    }

    themes.push({ name, sections: [...new Set(sections)] });
  }

  return themes;
}

/** Extract styled() component definitions. */
function extractStyledComponents(source: string): MuiStyledComponent[] {
  const components: MuiStyledComponent[] = [];
  const re = new RegExp(STYLED_RE.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = re.exec(source)) !== null) {
    components.push({
      name: match[1],
      baseComponent: match[2] || match[3],
    });
  }

  return components;
}

/** Count sx prop usages in JSX. */
function countSxUsage(source: string): number {
  const sxRe = /\bsx\s*=\s*\{/g;
  let count = 0;
  while (sxRe.exec(source) !== null) count++;
  return count;
}

/** Extract MUI component imports. */
function extractMuiImports(source: string): { name: string; package: string }[] {
  const imports: { name: string; package: string }[] = [];

  // Match: import { Button, TextField } from '@mui/material'
  // Or: import { DataGrid } from '@mui/x-data-grid'
  // Or: import Button from '@mui/material/Button'
  const namedRe =
    /import\s*\{([^}]+)\}\s*from\s*["'](@mui\/[^"']+|@material-ui\/[^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = namedRe.exec(source)) !== null) {
    const names = m[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    for (const name of names) {
      imports.push({ name, package: m[2] });
    }
  }

  // Default imports: import Button from '@mui/material/Button'
  const defaultRe =
    /import\s+(\w+)\s+from\s*["'](@mui\/[^"']+\/(\w+)|@material-ui\/[^"']+\/(\w+))["']/g;
  while ((m = defaultRe.exec(source)) !== null) {
    imports.push({ name: m[1], package: m[2] });
  }

  return imports;
}

// ── Plugin ────────────────────────────────────────────────────────────────

export class MuiPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'mui',
    version: '1.0.0',
    priority: 45,
    category: 'view',
    dependencies: [],
  };

  private isV5 = false;

  detect(ctx: ProjectContext): boolean {
    const deps = {
      ...(ctx.packageJson?.dependencies as Record<string, string> | undefined),
      ...(ctx.packageJson?.devDependencies as Record<string, string> | undefined),
    };

    this.isV5 = '@mui/material' in deps;
    const isV4 = '@material-ui/core' in deps;

    return this.isV5 || isV4;
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'mui_theme', category: 'ui-library', description: 'MUI createTheme() definition' },
        { name: 'mui_styled', category: 'ui-library', description: 'MUI styled() component wrapper' },
        { name: 'uses_mui_component', category: 'ui-library', description: 'Imports MUI component' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (!['typescript', 'javascript', 'typescriptreact', 'javascriptreact'].includes(language)) {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const result: FileParseResult = {
      status: 'ok',
      symbols: [],
      routes: [],
      edges: [],
      components: [],
    };

    // Theme definitions
    const themes = extractMuiThemes(source);
    for (const theme of themes) {
      result.routes!.push({
        method: 'THEME',
        uri: `mui:theme:${theme.name}`,
        handler: theme.name,
        metadata: { sections: theme.sections },
      });
      result.edges!.push({
        edgeType: 'mui_theme',
        metadata: { themeName: theme.name, sections: theme.sections },
      });
      result.frameworkRole = 'mui_theme';
    }

    // styled() components
    const styledComponents = extractStyledComponents(source);
    for (const sc of styledComponents) {
      result.components!.push({
        name: sc.name,
        kind: 'component',
        framework: 'mui',
        props: { baseComponent: sc.baseComponent },
      });
      result.edges!.push({
        edgeType: 'mui_styled',
        metadata: { componentName: sc.name, baseComponent: sc.baseComponent },
      });
    }

    // MUI component imports
    const muiImports = extractMuiImports(source);
    for (const imp of muiImports) {
      result.edges!.push({
        edgeType: 'uses_mui_component',
        metadata: { componentName: imp.name, package: imp.package },
      });
    }

    // sx prop count as metadata
    const sxCount = countSxUsage(source);
    if (sxCount > 0) {
      result.metadata = { ...result.metadata, muiSxUsageCount: sxCount };
    }

    if (styledComponents.length > 0) {
      result.frameworkRole = result.frameworkRole ?? 'mui_styled_component';
    }

    if (
      result.routes!.length === 0 &&
      result.edges!.length === 0 &&
      result.components!.length === 0 &&
      !result.metadata
    ) {
      return ok({ status: 'ok', symbols: [] });
    }

    return ok(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function extractParenBody(source: string, pos: number): string {
  let depth = 1;
  let i = pos;
  while (i < source.length && depth > 0) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') depth--;
    i++;
  }
  return source.slice(pos, i - 1);
}
