/**
 * AntDesignPlugin — Detects Ant Design (antd) usage and extracts:
 * - ConfigProvider theme configuration
 * - Form definitions (Form.useForm, Form.Item fields)
 * - Table column definitions
 * - Ant Design component imports for dependency tracking
 *
 * Supports antd v5+ and @ant-design/pro-components.
 */
import { ok } from 'neverthrow';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  RawRoute,
  ResolveContext,
} from '../../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../../errors.js';

// ── Theme / ConfigProvider extraction ─────────────────────────────────────

/**
 * Match ConfigProvider theme prop: <ConfigProvider theme={{ token: { ... }, components: { ... } }}>
 * Simplified: look for theme={{ token or theme={{ components
 */
const CONFIG_PROVIDER_THEME_RE =
  /ConfigProvider[\s\S]*?theme\s*=\s*\{\s*\{([^]*?)\}\s*\}/g;

/**
 * Match: const theme = { token: { ... }, components: { ... } }
 * Used when theme object is passed by reference.
 */
const THEME_CONFIG_RE =
  /(?:export\s+)?(?:const|let)\s+(\w+)\s*(?::\s*ThemeConfig\s*)?=\s*\{/g;

interface AntdThemeConfig {
  name: string;
  hasToken: boolean;
  hasComponents: boolean;
  hasAlgorithm: boolean;
}

interface AntdFormDef {
  name: string;
  fields: string[];
}

interface AntdTableDef {
  name: string;
  columns: string[];
}

/** Extract theme configuration objects that match Ant Design ThemeConfig shape. */
function extractAntdThemes(source: string): AntdThemeConfig[] {
  const themes: AntdThemeConfig[] = [];
  const re = new RegExp(THEME_CONFIG_RE.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = re.exec(source)) !== null) {
    const name = match[1];
    const startPos = source.indexOf('{', match.index + match[0].length - 1);
    const body = extractBraceBody(source, startPos);

    const hasToken = /\btoken\s*:/.test(body);
    const hasComponents = /\bcomponents\s*:/.test(body);
    const hasAlgorithm = /\balgorithm\s*:/.test(body);

    // Only include if it looks like a theme config
    if (hasToken || hasComponents || hasAlgorithm) {
      themes.push({ name, hasToken, hasComponents, hasAlgorithm });
    }
  }

  return themes;
}

/** Extract Form field names from Form.Item name props. */
function extractAntdFormFields(source: string): AntdFormDef[] {
  const forms: AntdFormDef[] = [];

  // Detect Form.useForm() or Form.create()
  const formRe = /(?:const|let)\s+\[(\w+)\]\s*=\s*Form\.useForm\(\)/g;
  let m: RegExpExecArray | null;
  while ((m = formRe.exec(source)) !== null) {
    const formName = m[1];
    const fields: string[] = [];

    // Find Form.Item name="..." in the source
    const fieldRe = /Form\.Item[\s\S]*?name\s*=\s*["'](\w+)["']/g;
    let fm: RegExpExecArray | null;
    while ((fm = fieldRe.exec(source)) !== null) {
      fields.push(fm[1]);
    }

    forms.push({ name: formName, fields: [...new Set(fields)] });
  }

  // Fallback: if no useForm but Form.Item exists
  if (forms.length === 0) {
    const fields: string[] = [];
    const fieldRe = /Form\.Item[\s\S]*?name\s*=\s*["'](\w+)["']/g;
    let fm: RegExpExecArray | null;
    while ((fm = fieldRe.exec(source)) !== null) {
      fields.push(fm[1]);
    }
    if (fields.length > 0) {
      forms.push({ name: 'anonymous', fields: [...new Set(fields)] });
    }
  }

  return forms;
}

/** Extract Table column definitions. */
function extractAntdTableColumns(source: string): AntdTableDef[] {
  const tables: AntdTableDef[] = [];

  // Match: const columns = [...] or const columns: ColumnsType<T> = [...]
  const colRe = /(?:const|let)\s+(\w*[Cc]olumns?\w*)\s*(?::\s*[^=]+)?\s*=\s*\[/g;
  let m: RegExpExecArray | null;
  while ((m = colRe.exec(source)) !== null) {
    const name = m[1];
    const startPos = source.indexOf('[', m.index + m[0].length - 1);
    const body = extractBracketBody(source, startPos);

    // Extract dataIndex values
    const columns: string[] = [];
    const diRe = /dataIndex\s*:\s*["'](\w+)["']/g;
    let dm: RegExpExecArray | null;
    while ((dm = diRe.exec(body)) !== null) {
      columns.push(dm[1]);
    }

    if (columns.length > 0) {
      tables.push({ name, columns: [...new Set(columns)] });
    }
  }

  return tables;
}

/** Extract antd component imports. */
function extractAntdImports(source: string): { name: string; package: string }[] {
  const imports: { name: string; package: string }[] = [];

  const importRe =
    /import\s*\{([^}]+)\}\s*from\s*["'](antd|@ant-design\/[^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(source)) !== null) {
    const names = m[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    for (const name of names) {
      imports.push({ name, package: m[2] });
    }
  }

  return imports;
}

// ── Plugin ────────────────────────────────────────────────────────────────

export class AntDesignPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'antd',
    version: '1.0.0',
    priority: 45,
    category: 'view',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    const deps = {
      ...(ctx.packageJson?.dependencies as Record<string, string> | undefined),
      ...(ctx.packageJson?.devDependencies as Record<string, string> | undefined),
    };

    return (
      'antd' in deps ||
      '@ant-design/pro-components' in deps ||
      '@ant-design/pro-layout' in deps
    );
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'antd_theme', category: 'ui-library', description: 'Ant Design theme/ConfigProvider configuration' },
        { name: 'antd_form', category: 'ui-library', description: 'Ant Design Form definition with fields' },
        { name: 'antd_table', category: 'ui-library', description: 'Ant Design Table column definition' },
        { name: 'uses_antd_component', category: 'ui-library', description: 'Imports Ant Design component' },
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
    };

    // Theme configuration
    const themes = extractAntdThemes(source);
    for (const theme of themes) {
      result.routes!.push({
        method: 'THEME',
        uri: `antd:theme:${theme.name}`,
        handler: theme.name,
        metadata: {
          hasToken: theme.hasToken,
          hasComponents: theme.hasComponents,
          hasAlgorithm: theme.hasAlgorithm,
        },
      });
      result.edges!.push({
        edgeType: 'antd_theme',
        metadata: { themeName: theme.name },
      });
      result.frameworkRole = 'antd_theme';
    }

    // Form definitions
    const forms = extractAntdFormFields(source);
    for (const form of forms) {
      result.routes!.push({
        method: 'FORM',
        uri: `antd:form:${form.name}`,
        handler: form.name,
        metadata: { fields: form.fields },
      });
      result.edges!.push({
        edgeType: 'antd_form',
        metadata: { formName: form.name, fields: form.fields },
      });
    }

    // Table column definitions
    const tables = extractAntdTableColumns(source);
    for (const table of tables) {
      result.routes!.push({
        method: 'TABLE',
        uri: `antd:table:${table.name}`,
        handler: table.name,
        metadata: { columns: table.columns },
      });
      result.edges!.push({
        edgeType: 'antd_table',
        metadata: { tableName: table.name, columns: table.columns },
      });
    }

    // Antd component imports
    const antdImports = extractAntdImports(source);
    for (const imp of antdImports) {
      result.edges!.push({
        edgeType: 'uses_antd_component',
        metadata: { componentName: imp.name, package: imp.package },
      });
    }

    if (forms.length > 0 || tables.length > 0) {
      result.frameworkRole = result.frameworkRole ?? 'antd_form';
    }

    if (result.routes!.length === 0 && result.edges!.length === 0) {
      return ok({ status: 'ok', symbols: [] });
    }

    return ok(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function extractBraceBody(source: string, pos: number): string {
  let depth = 0;
  let start = pos;
  while (start < source.length && source[start] !== '{') start++;
  if (start >= source.length) return '';
  depth = 1;
  let i = start + 1;
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  }
  return source.slice(start + 1, i - 1);
}

function extractBracketBody(source: string, pos: number): string {
  let depth = 0;
  let start = pos;
  while (start < source.length && source[start] !== '[') start++;
  if (start >= source.length) return '';
  depth = 1;
  let i = start + 1;
  while (i < source.length && depth > 0) {
    if (source[i] === '[') depth++;
    else if (source[i] === ']') depth--;
    i++;
  }
  return source.slice(start + 1, i - 1);
}
