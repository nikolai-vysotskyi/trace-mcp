/**
 * PrismaPlugin — parses Prisma schema files (schema.prisma / *.prisma).
 *
 * Implements BOTH LanguagePlugin (so .prisma files are not skipped by the pipeline)
 * and FrameworkPlugin (for richer ORM model/association extraction).
 *
 * Extracts:
 * - model blocks → RawOrmModel with fields, relations, @@map table names
 * - enum blocks → stored as ORM model with orm='prisma_enum'
 * - @relation fields → RawOrmAssociation
 * - @@index / @@unique → stored in model metadata
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok } from 'neverthrow';
import type {
  FrameworkPlugin,
  LanguagePlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  RawOrmModel,
  RawOrmAssociation,
  ResolveContext,
} from '../../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../../errors.js';

// ── LanguagePlugin half ────────────────────────────────────────────────────

export class PrismaLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'prisma-language',
    version: '1.0.0',
    priority: 5,
    dependencies: [],
  };

  supportedExtensions = ['.prisma'];

  extractSymbols(filePath: string, content: Buffer): TraceMcpResult<FileParseResult> {
    // Let the framework plugin do the heavy work; here we just mark the file
    // as language='prisma' with no symbols so the pipeline doesn't skip it.
    return ok({
      status: 'ok',
      symbols: [],
      language: 'prisma',
    });
  }
}

// ── FrameworkPlugin half ───────────────────────────────────────────────────

export class PrismaPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'prisma',
    version: '1.0.0',
    priority: 30,
    category: 'orm',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    // Check package.json for @prisma/client
    const deps = {
      ...(ctx.packageJson?.dependencies as Record<string, string> | undefined),
      ...(ctx.packageJson?.devDependencies as Record<string, string> | undefined),
    };
    if ('@prisma/client' in deps || 'prisma' in deps) return true;

    // Also detect if any schema.prisma exists under the project root
    try {
      const candidates = [
        path.join(ctx.rootPath, 'prisma', 'schema.prisma'),
        path.join(ctx.rootPath, 'schema.prisma'),
      ];
      return candidates.some((p) => fs.existsSync(p));
    } catch {
      return false;
    }
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'prisma_relation', category: 'prisma', description: 'Prisma model relation' },
        {
          name: 'prisma_implicit_m2m',
          category: 'prisma',
          description: 'Prisma implicit many-to-many',
        },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (language !== 'prisma') {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const { models, associations } = parsePrismaSchema(source);

    return ok({
      status: 'ok',
      symbols: [],
      ormModels: models,
      ormAssociations: associations,
      frameworkRole: 'prisma_schema',
    });
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}

// ── Parser ─────────────────────────────────────────────────────────────────

interface ParseResult {
  models: RawOrmModel[];
  associations: RawOrmAssociation[];
}

export function parsePrismaSchema(source: string): ParseResult {
  const models: RawOrmModel[] = [];
  const associations: RawOrmAssociation[] = [];

  // Strip line comments
  const stripped = source.replace(/\/\/[^\n]*/g, '');

  // Extract all top-level blocks: model, enum, type
  const blockRegex = /\b(model|enum|type)\s+(\w+)\s*\{([^}]*)\}/g;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = blockRegex.exec(stripped)) !== null) {
    const blockKind = blockMatch[1];
    const blockName = blockMatch[2];
    const blockBody = blockMatch[3];

    if (blockKind === 'enum') {
      // Store enum as a special ORM model
      const values = blockBody
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('@@'));
      models.push({
        name: blockName,
        orm: 'prisma',
        metadata: { kind: 'enum', values },
      });
      continue;
    }

    // model or type block
    const fields: Record<string, unknown>[] = [];
    const indices: string[] = [];
    let tableName: string | undefined;

    for (const rawLine of blockBody.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;

      // Block-level attributes
      if (line.startsWith('@@map(')) {
        const m = line.match(/@@map\s*\(\s*["']([^"']+)["']\s*\)/);
        if (m) tableName = m[1];
        continue;
      }
      if (line.startsWith('@@index') || line.startsWith('@@unique') || line.startsWith('@@id')) {
        indices.push(line);
        continue;
      }
      if (line.startsWith('@@')) continue;

      // Field line: fieldName  FieldType  @attr @attr2
      const fieldMatch = line.match(/^(\w+)\s+([\w?[\]]+)(.*)?$/);
      if (!fieldMatch) continue;

      const fieldName = fieldMatch[1];
      const fieldType = fieldMatch[2];
      const attrs = fieldMatch[3] ?? '';

      // Skip native-type fields that are just Prisma internals
      if (['@@', '//'].some((p) => fieldName.startsWith(p))) continue;

      const field: Record<string, unknown> = {
        name: fieldName,
        type: fieldType.replace('?', '').replace('[]', ''),
        optional: fieldType.includes('?'),
        list: fieldType.includes('[]'),
      };

      if (/@id\b/.test(attrs)) field.id = true;
      if (/@unique\b/.test(attrs)) field.unique = true;
      if (/@default/.test(attrs)) {
        const dm = attrs.match(/@default\(([^)]+)\)/);
        if (dm) field.default = dm[1];
      }
      if (/@updatedAt\b/.test(attrs)) field.updatedAt = true;

      // @map("column_name")
      const mapMatch = attrs.match(/@map\s*\(\s*["']([^"']+)["']\s*\)/);
      if (mapMatch) field.columnName = mapMatch[1];

      // @relation — collect for associations
      if (/@relation\b/.test(attrs)) {
        const relNameMatch = attrs.match(/@relation\s*\(\s*(?:name\s*:\s*)?["']([^"']+)["']/);
        const fieldsMatch = attrs.match(/fields\s*:\s*\[([^\]]+)\]/);
        const referencesMatch = attrs.match(/references\s*:\s*\[([^\]]+)\]/);

        // Target type (strip ? and [])
        const targetType = fieldType.replace('?', '').replace('[]', '');

        // Only add one direction of the relation (the side that has `fields:`)
        if (fieldsMatch) {
          associations.push({
            sourceModelName: blockName,
            targetModelName: targetType,
            kind: fieldType.includes('[]') ? 'hasMany' : 'belongsTo',
            options: {
              ...(relNameMatch ? { name: relNameMatch[1] } : {}),
              fields: fieldsMatch[1].split(',').map((s) => s.trim()),
              references: referencesMatch ? referencesMatch[1].split(',').map((s) => s.trim()) : [],
            },
          });
        }

        field.relation = true;
        field.relationType = fieldType.includes('[]') ? 'hasMany' : 'belongsTo';
        field.relationTarget = targetType;
      }

      fields.push(field);
    }

    models.push({
      name: blockName,
      orm: 'prisma',
      collectionOrTable: tableName,
      fields,
      metadata: {
        kind: blockKind,
        indices: indices.length > 0 ? indices : undefined,
      },
    });
  }

  return { models, associations };
}
