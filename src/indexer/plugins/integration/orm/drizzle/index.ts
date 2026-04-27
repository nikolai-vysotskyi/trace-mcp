import { ok } from 'neverthrow';
import type { TraceMcpResult } from '../../../../../errors.js';
import type {
  FileParseResult,
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  RawEdge,
  RawOrmAssociation,
  RawOrmModel,
  ResolveContext,
} from '../../../../../plugin-api/types.js';

export class DrizzlePlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'drizzle',
    version: '1.0.0',
    priority: 30,
    category: 'orm',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    const deps = {
      ...(ctx.packageJson?.dependencies as Record<string, string> | undefined),
      ...(ctx.packageJson?.devDependencies as Record<string, string> | undefined),
    };
    return 'drizzle-orm' in deps;
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'drizzle_relation', category: 'drizzle', description: 'Drizzle ORM relation' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (language !== 'typescript' && language !== 'javascript') {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');

    // Only process files that use drizzle table definitions
    if (!/(?:pgTable|mysqlTable|sqliteTable|mySqlTable)\s*\(/.test(source)) {
      return ok({ status: 'ok', symbols: [] });
    }

    const models: RawOrmModel[] = [];
    const associations: RawOrmAssociation[] = [];

    // Extract table definitions:
    // export const users = pgTable('users', { ... })
    // export const usersTable = pgTable('users', { ... }, (table) => ({ ... }))
    // Use two-step approach: regex to find the declaration header, then brace-matching for body
    const tableHeaderRegex =
      /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:pgTable|mysqlTable|mySqlTable|sqliteTable)\s*\(\s*['"]([^'"]+)['"]\s*,\s*/g;
    let tableMatch: RegExpExecArray | null;
    while ((tableMatch = tableHeaderRegex.exec(source)) !== null) {
      const varName = tableMatch[1];
      const tableName = tableMatch[2];
      const bodyStart = tableMatch.index + tableMatch[0].length;
      const columnsBody = extractBracedBody(source, bodyStart);

      const fields = parseDrizzleColumns(columnsBody);
      const modelName = toModelName(varName);

      models.push({
        name: modelName,
        orm: 'drizzle',
        collectionOrTable: tableName,
        fields,
        metadata: { varName },
      });
    }

    // Extract relations() calls:
    // export const usersRelations = relations(users, ({ one, many }) => ({ posts: many(posts) }))
    const relationsRegex =
      /(?:export\s+)?(?:const|let)\s+(\w+Relations)\s*=\s*relations\s*\(\s*(\w+)\s*,/g;
    let relMatch: RegExpExecArray | null;
    while ((relMatch = relationsRegex.exec(source)) !== null) {
      const sourceVar = relMatch[2];
      const sourceModel = toModelName(sourceVar);

      // Find the arrow function body: relations(table, (helpers) => ({ ... }))
      // Skip past '=>' to reach the return value object, not the argument list.
      const startPos = relMatch.index + relMatch[0].length;
      const arrowPos = source.indexOf('=>', startPos);
      if (arrowPos === -1) continue;
      const relBody = extractBracedBody(source, arrowPos + 2);

      // one(targetTable) or many(targetTable)
      const oneRegex = /\bone\s*\(\s*(\w+)/g;
      const manyRegex = /\bmany\s*\(\s*(\w+)/g;

      let oneMatch: RegExpExecArray | null;
      while ((oneMatch = oneRegex.exec(relBody)) !== null) {
        associations.push({
          sourceModelName: sourceModel,
          targetModelName: toModelName(oneMatch[1]),
          kind: 'belongsTo',
        });
      }

      let manyMatch: RegExpExecArray | null;
      while ((manyMatch = manyRegex.exec(relBody)) !== null) {
        associations.push({
          sourceModelName: sourceModel,
          targetModelName: toModelName(manyMatch[1]),
          kind: 'hasMany',
        });
      }
    }

    if (models.length === 0) return ok({ status: 'ok', symbols: [] });

    return ok({
      status: 'ok',
      symbols: [],
      ormModels: models,
      ormAssociations: associations,
      frameworkRole: 'drizzle_schema',
    });
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseDrizzleColumns(body: string): Record<string, unknown>[] {
  const fields: Record<string, unknown>[] = [];

  // fieldName: integer('col_name').primaryKey().notNull()
  // Also handles: varchar('col', { length: 255 }).unique()
  // Also handles: .references(() => users.id) with nested parens
  const fieldRegex = /(\w+)\s*:\s*(\w+)\s*\([^)]*\)([^\n,]*)/g;
  let match: RegExpExecArray | null;
  while ((match = fieldRegex.exec(body)) !== null) {
    const name = match[1];
    const colType = match[2];
    const chain = match[3] ?? '';

    if (['one', 'many', 'relations'].includes(name)) continue;

    const field: Record<string, unknown> = { name, type: colType };
    if (/\.primaryKey\(/.test(chain)) field.primaryKey = true;
    if (/\.notNull\(/.test(chain)) field.notNull = true;
    if (/\.unique\(/.test(chain)) field.unique = true;
    if (/\.default\(/.test(chain)) {
      const dm = chain.match(/\.default\(([^)]+)\)/);
      if (dm) field.default = dm[1];
    }
    if (/\.references\(/.test(chain)) {
      const rm = chain.match(/\.references\s*\(\s*\(\)\s*=>\s*(\w+)\s*\.\s*(\w+)/);
      if (rm) field.references = `${rm[1]}.${rm[2]}`;
    }
    fields.push(field);
  }

  return fields;
}

/** Find the content inside the next {...} or (...)  block after pos */
function extractBracedBody(source: string, pos: number): string {
  // Skip to opening brace/paren
  let start = pos;
  while (start < source.length && source[start] !== '{' && source[start] !== '(') start++;
  if (start >= source.length) return '';

  const open = source[start];
  const close = open === '{' ? '}' : ')';
  let depth = 1;
  let i = start + 1;
  while (i < source.length && depth > 0) {
    if (source[i] === open) depth++;
    else if (source[i] === close) depth--;
    i++;
  }
  return source.slice(start + 1, i - 1);
}

/** Convert varName like 'usersTable' or 'users' → 'User' / 'Users' */
function toModelName(varName: string): string {
  const stripped = varName.replace(/Table$/, '').replace(/s$/, '');
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}
