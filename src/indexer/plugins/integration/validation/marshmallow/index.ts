/**
 * MarshmallowPlugin — detects marshmallow (4.x) and extracts schema structure:
 * field → field type, schema → nested schema, and hook method → its schema.
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

const PACKAGES = ['marshmallow'] as const;

const IMPORT_RE = /^\s*(?:from\s+marshmallow(?:\.\w+)*\s+import|import\s+marshmallow)\b/m;

/** `class UserSchema(Schema):` — any base whose name ends in `Schema`. */
const CLASS_RE = /^([ \t]*)class[ \t]+(\w+)[ \t]*\(([^)]*)\)[ \t]*:/gm;

/** `email = fields.Email(...)` / `email = Email(...)` after a from-import. */
const FIELD_RE = /^[ \t]+(\w+)[ \t]*=[ \t]*(?:fields[ \t]*\.[ \t]*)?([A-Z]\w*)[ \t]*\(/gm;

/** `Nested(Other)`, `Nested("Other")`, `Nested(lambda: Other(...))` */
const NESTED_RE = /\bNested\(\s*(?:lambda\s*:\s*)?["']?([A-Za-z_]\w*)["']?/g;

const HOOKS = [
  'validates',
  'validates_schema',
  'pre_load',
  'post_load',
  'pre_dump',
  'post_dump',
] as const;

/** A hook decorator block followed by `def name(`. */
const HOOK_RE = new RegExp(
  `^[ \\t]*@\\s*(?:\\w+\\s*\\.\\s*)?(${HOOKS.join('|')})\\b[^\\n]*\\n(?:[ \\t]*@[^\\n]*\\n)*[ \\t]*def[ \\t]+(\\w+)`,
  'gm',
);

interface SchemaClass {
  name: string;
  body: string;
  /** Offset of `body` within the source, for line numbers. */
  bodyOffset: number;
  line: number;
}

/**
 * Slice out each `class X(...Schema):` body by indentation — the body runs until
 * the next non-blank line indented no deeper than the class header.
 */
function findSchemaClasses(source: string): SchemaClass[] {
  const classes: SchemaClass[] = [];
  const lineOf = (idx: number) => source.slice(0, idx).split('\n').length;

  for (const m of source.matchAll(CLASS_RE)) {
    const bases = m[3];
    if (!/\bSchema\b|\w+Schema\b/.test(bases)) continue;

    const indent = m[1].length;
    const start = (m.index ?? 0) + m[0].length;
    const rest = source.slice(start);

    let end = rest.length;
    let cursor = 0;
    for (const line of rest.split('\n')) {
      if (line.trim() !== '') {
        const lineIndent = line.length - line.trimStart().length;
        if (lineIndent <= indent) {
          end = cursor;
          break;
        }
      }
      cursor += line.length + 1;
    }

    classes.push({
      name: m[2],
      body: rest.slice(0, end),
      bodyOffset: start,
      line: lineOf(m.index ?? 0),
    });
  }

  return classes;
}

export class MarshmallowPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'marshmallow',
    version: '1.0.0',
    priority: 30,
    category: 'validation',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    return hasAnyPythonDep(ctx, PACKAGES);
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 'marshmallow_field_type',
          category: 'marshmallow',
          description: 'Schema field → its marshmallow field type',
        },
        {
          name: 'marshmallow_nested',
          category: 'marshmallow',
          description: 'Schema → nested schema referenced via fields.Nested',
        },
        {
          name: 'marshmallow_hook',
          category: 'marshmallow',
          description: 'Validation/lifecycle hook method → its schema',
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
    if (!IMPORT_RE.test(source)) {
      return ok({ status: 'ok', symbols: [] });
    }

    const result: FileParseResult = { status: 'ok', symbols: [], edges: [] };
    const schemas = findSchemaClasses(source);

    for (const schema of schemas) {
      const lineOf = (idx: number) => source.slice(0, schema.bodyOffset + idx).split('\n').length;

      for (const f of schema.body.matchAll(new RegExp(FIELD_RE.source, 'gm'))) {
        const fieldName = f[1];
        const fieldType = f[2];
        const line = lineOf(f.index ?? 0);

        result.edges!.push({
          edgeType: 'marshmallow_field_type',
          metadata: { schema: schema.name, field: fieldName, fieldType, filePath, line },
        });

        // `Nested(Other)` may sit inside a wrapper such as `List(Nested(Other))`.
        const declaration = lineTail(schema.body, f.index ?? 0);
        for (const n of declaration.matchAll(new RegExp(NESTED_RE.source, 'g'))) {
          result.edges!.push({
            edgeType: 'marshmallow_nested',
            metadata: { schema: schema.name, field: fieldName, target: n[1], filePath, line },
          });
        }
      }

      for (const h of schema.body.matchAll(new RegExp(HOOK_RE.source, 'gm'))) {
        result.edges!.push({
          edgeType: 'marshmallow_hook',
          metadata: {
            schema: schema.name,
            hook: h[1],
            method: h[2],
            filePath,
            line: lineOf(h.index ?? 0),
          },
        });
      }

      result.frameworkRole = 'marshmallow_schema';
    }

    if (!result.frameworkRole) {
      result.frameworkRole = 'marshmallow_import';
    }

    return ok(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}

/** Remainder of the physical line starting at `idx`. */
function lineTail(text: string, idx: number): string {
  const end = text.indexOf('\n', idx);
  return text.slice(idx, end === -1 ? text.length : end);
}
