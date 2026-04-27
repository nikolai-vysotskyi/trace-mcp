
import { ok } from 'neverthrow';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  RawOrmModel,
  RawOrmAssociation,
  ResolveContext,
} from '../../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../../errors.js';

export class TypeORMPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'typeorm',
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
    return 'typeorm' in deps;
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'typeorm_one_to_many', category: 'typeorm', description: 'TypeORM OneToMany' },
        { name: 'typeorm_many_to_one', category: 'typeorm', description: 'TypeORM ManyToOne' },
        { name: 'typeorm_one_to_one', category: 'typeorm', description: 'TypeORM OneToOne' },
        { name: 'typeorm_many_to_many', category: 'typeorm', description: 'TypeORM ManyToMany' },
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

    // Only process files that have @Entity decorator
    if (!/@Entity\s*\(/.test(source)) {
      return ok({ status: 'ok', symbols: [] });
    }

    const result = extractTypeORMEntity(source, filePath);
    if (!result) return ok({ status: 'ok', symbols: [] });

    return ok({
      status: 'ok',
      symbols: [],
      ormModels: [result.model],
      ormAssociations: result.associations,
      frameworkRole: 'typeorm_entity',
    });
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}

// ── Extraction ─────────────────────────────────────────────────────────────

interface TypeORMEntityResult {
  model: RawOrmModel;
  associations: RawOrmAssociation[];
}

export function extractTypeORMEntity(source: string, filePath: string): TypeORMEntityResult | null {
  // Match @Entity() ... class ClassName
  const entityRegex =
    /@Entity\s*\(\s*(?:['"]([^'"]+)['"]|\{[^}]*tableName\s*:\s*['"]([^'"]+)['"][^}]*\})?\s*\)[\s\S]*?class\s+(\w+)/;
  const entityMatch = source.match(entityRegex);
  if (!entityMatch) return null;

  const tableName = entityMatch[1] || entityMatch[2];
  const className = entityMatch[3];

  const fields: Record<string, unknown>[] = [];
  const associations: RawOrmAssociation[] = [];
  const indices: string[] = [];

  // Extract @Column, @PrimaryGeneratedColumn, @PrimaryColumn fields
  const columnRegex =
    /@(PrimaryGeneratedColumn|PrimaryColumn|Column|CreateDateColumn|UpdateDateColumn|DeleteDateColumn)\s*(?:\([^)]*\))?\s*(?:\w+\s*[?!]?\s*:\s*[\w|]+\s*)*\s*(\w+)\s*[?!]?\s*:\s*([\w|[\]<>]+)/g;
  let colMatch: RegExpExecArray | null;
  while ((colMatch = columnRegex.exec(source)) !== null) {
    const decorator = colMatch[1];
    const fieldName = colMatch[2];
    const fieldType = colMatch[3];

    const field: Record<string, unknown> = { name: fieldName, type: fieldType };
    if (decorator.startsWith('Primary')) field.primaryKey = true;
    if (decorator === 'PrimaryGeneratedColumn') field.autoIncrement = true;
    if (decorator === 'CreateDateColumn') field.createdAt = true;
    if (decorator === 'UpdateDateColumn') field.updatedAt = true;
    if (decorator === 'DeleteDateColumn') field.deletedAt = true;
    fields.push(field);
  }

  // Extract relation decorators
  const _RELATION_MAP: Record<string, string> = {
    OneToMany: 'typeorm_one_to_many',
    ManyToOne: 'typeorm_many_to_one',
    OneToOne: 'typeorm_one_to_one',
    ManyToMany: 'typeorm_many_to_many',
  };

  const relationRegex = /@(OneToMany|ManyToOne|OneToOne|ManyToMany)\s*\(\s*\(\)\s*=>\s*(\w+)/g;
  let relMatch: RegExpExecArray | null;
  while ((relMatch = relationRegex.exec(source)) !== null) {
    const relKind = relMatch[1];
    const targetType = relMatch[2];
    associations.push({
      sourceModelName: className,
      targetModelName: targetType,
      kind: relKind,
    });
  }

  // Extract @Index block decorators
  const indexRegex = /@Index\s*\(\s*\[([^\]]+)\]/g;
  let idxMatch: RegExpExecArray | null;
  while ((idxMatch = indexRegex.exec(source)) !== null) {
    indices.push(idxMatch[1]);
  }

  const model: RawOrmModel = {
    name: className,
    orm: 'typeorm',
    collectionOrTable: tableName,
    fields,
    metadata: {
      indices: indices.length > 0 ? indices : undefined,
    },
  };

  return { model, associations };
}
