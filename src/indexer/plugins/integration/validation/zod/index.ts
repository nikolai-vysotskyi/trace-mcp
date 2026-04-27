/**
 * ZodPlugin — detects Zod schema library usage and extracts schema definitions
 * with field types.
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

/**
 * Match: const schemaName = z.object({ ... })
 * Also matches export const, export default, let, var
 */
const ZOD_OBJECT_RE =
  /(?:export\s+(?:default\s+)?)?(?:const|let|var)\s+(\w+)\s*=\s*z\.object\s*\(\s*\{([^]*?)\}\s*\)/g;

/**
 * Match individual fields inside z.object({ ... })
 * e.g., name: z.string(), age: z.number().optional()
 */
const ZOD_FIELD_RE = /(\w+)\s*:\s*z\.(\w+)\s*\(([^)]*)\)([.\w()]*)/g;

/**
 * Match type inference: type X = z.infer<typeof schemaName>
 */
const ZOD_INFER_RE = /type\s+(\w+)\s*=\s*z\.infer\s*<\s*typeof\s+(\w+)\s*>/g;

interface ZodField {
  name: string;
  type: string;
}

interface ZodSchema {
  name: string;
  fields: ZodField[];
}

interface ZodInference {
  typeName: string;
  schemaName: string;
}

/** Map a Zod method chain to a human-readable type string. */
function resolveFieldType(baseType: string, chain: string): string {
  let type = baseType;
  // Handle z.array(z.string()) etc.
  if (baseType === 'array') type = 'array';
  if (baseType === 'enum') type = 'enum';
  // Check modifiers
  if (chain.includes('.optional()')) type += '?';
  if (chain.includes('.nullable()')) type += ' | null';
  return type;
}

/** Extract field definitions from the inner body of a z.object({ ... }). */
function extractFieldsFromBody(body: string): ZodField[] {
  const fields: ZodField[] = [];
  const re = new RegExp(ZOD_FIELD_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const fieldName = match[1];
    const baseType = match[2];
    const chain = match[4] || '';
    fields.push({
      name: fieldName,
      type: resolveFieldType(baseType, chain),
    });
  }
  return fields;
}

/** Extract Zod schema definitions from source code. */
export function extractZodSchemas(source: string): ZodSchema[] {
  const schemas: ZodSchema[] = [];
  const re = new RegExp(ZOD_OBJECT_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const name = match[1];
    const body = match[2];
    const fields = extractFieldsFromBody(body);
    schemas.push({ name, fields });
  }
  return schemas;
}

/** Extract z.infer type relationships from source code. */
export function extractZodInferences(source: string): ZodInference[] {
  const inferences: ZodInference[] = [];
  const re = new RegExp(ZOD_INFER_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    inferences.push({
      typeName: match[1],
      schemaName: match[2],
    });
  }
  return inferences;
}

export class ZodPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'zod',
    version: '1.0.0',
    priority: 30,
    category: 'validation',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      if ('zod' in deps) return true;
    }

    try {
      const pkgPath = path.join(ctx.rootPath, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      return 'zod' in deps;
    } catch {
      return false;
    }
  }

  registerSchema() {
    return {
      edgeTypes: [{ name: 'zod_schema', category: 'zod', description: 'Zod schema definition' }],
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

    const schemas = extractZodSchemas(source);
    if (schemas.length > 0) {
      result.frameworkRole = 'zod_schema';
      for (const schema of schemas) {
        result.routes!.push({
          method: 'SCHEMA',
          uri: `zod:${schema.name}`,
          metadata: { fields: schema.fields },
        });
      }
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}
