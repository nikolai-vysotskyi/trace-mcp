/**
 * SequelizePlugin — Framework plugin for Sequelize ORM.
 *
 * Extracts:
 * - Model definitions (Model.init, sequelize.define, decorators)
 * - Associations (hasMany, belongsTo, belongsToMany, hasOne)
 * - Migrations (queryInterface.createTable/addColumn/etc.)
 * - Hooks (beforeCreate, afterUpdate, etc.)
 * - Scopes
 *
 * Supports Sequelize 4.x–7.x and sequelize-typescript.
 */
import fs from 'node:fs';
import path from 'node:path';
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

export class SequelizePlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'sequelize',
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
    if ('sequelize' in deps || 'sequelize-typescript' in deps) return true;

    try {
      const pkgPath = path.join(ctx.rootPath, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const json = JSON.parse(content);
      const allDeps = { ...json.dependencies, ...json.devDependencies };
      return 'sequelize' in allDeps || 'sequelize-typescript' in allDeps;
    } catch {
      return false;
    }
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 'sequelize_has_many',
          category: 'sequelize',
          description: 'Sequelize hasMany association',
        },
        {
          name: 'sequelize_belongs_to',
          category: 'sequelize',
          description: 'Sequelize belongsTo association',
        },
        {
          name: 'sequelize_belongs_to_many',
          category: 'sequelize',
          description: 'Sequelize belongsToMany association',
        },
        {
          name: 'sequelize_has_one',
          category: 'sequelize',
          description: 'Sequelize hasOne association',
        },
        {
          name: 'sequelize_has_hook',
          category: 'sequelize',
          description: 'Sequelize lifecycle hook',
        },
        {
          name: 'sequelize_has_scope',
          category: 'sequelize',
          description: 'Sequelize named scope',
        },
        {
          name: 'sequelize_migrates',
          category: 'sequelize',
          description: 'Migration changes table schema',
        },
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
    const result: FileParseResult = {
      status: 'ok',
      symbols: [],
      ormModels: [],
      ormAssociations: [],
      warnings: [],
    };

    // Model extraction
    const modelExtraction = extractSequelizeModel(source, filePath);
    if (modelExtraction) {
      result.ormModels = [modelExtraction.model];
      result.ormAssociations = modelExtraction.associations;
      result.frameworkRole = 'sequelize_model';
    }

    // Migration extraction
    if (this.isMigrationFile(filePath)) {
      const migExtraction = extractSequelizeMigration(source, filePath);
      if (migExtraction) {
        result.ormModels = migExtraction.models;
        result.frameworkRole = 'sequelize_migration';
      }
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }

  private isMigrationFile(filePath: string): boolean {
    return /migrations?\//.test(filePath) && /\d/.test(path.basename(filePath));
  }
}

// ============================================================
// Model extraction
// ============================================================

interface SequelizeModelResult {
  model: RawOrmModel;
  associations: RawOrmAssociation[];
}

/**
 * Extract Sequelize model from source.
 * Handles: class-based (v6+), define() (v4-5), sequelize-typescript decorators.
 */
export function extractSequelizeModel(
  source: string,
  filePath: string,
): SequelizeModelResult | null {
  return (
    extractClassModel(source, filePath) ??
    extractDefineModel(source, filePath) ??
    extractDecoratorModel(source, filePath)
  );
}

/**
 * v6+ class-based: class User extends Model { } User.init({...}, {...})
 */
function extractClassModel(source: string, filePath: string): SequelizeModelResult | null {
  const classRegex = /class\s+(\w+)\s+extends\s+Model\s*\{/;
  const classMatch = source.match(classRegex);
  if (!classMatch) return null;

  const className = classMatch[1];

  // Extract Model.init({fields}, {options}) — required for class-based Sequelize model
  const initRegex = new RegExp(
    `${className}\\.init\\s*\\(\\s*\\{([\\s\\S]*?)\\}\\s*,\\s*\\{([\\s\\S]*?)\\}\\s*\\)`,
  );
  const initMatch = source.match(initRegex);

  // Require Model.init() or DataTypes usage — distinguish from sequelize-typescript decorators
  if (!initMatch && !/\bDataTypes\b/.test(source)) return null;

  const fields = initMatch ? parseSequelizeFields(initMatch[1]) : [];
  const options = initMatch ? parseSequelizeOptions(initMatch[2]) : {};

  // Extract associations from static associate(models) method
  const associations = extractAssociations(source, className);

  // Extract hooks
  const hooks = extractHooks(source, className);

  // Extract scopes
  const scopes = extractScopes(source, className);

  const model: RawOrmModel = {
    name: className,
    orm: 'sequelize',
    collectionOrTable: (options as Record<string, unknown>).tableName as string | undefined,
    fields,
    options,
    metadata: {
      hooks,
      scopes,
      style: 'class-based',
    },
  };

  return { model, associations };
}

/**
 * v4-5 define: sequelize.define('User', {fields}, {options})
 */
function extractDefineModel(source: string, filePath: string): SequelizeModelResult | null {
  const defineRegex =
    /sequelize\.define\s*\(\s*['"](\w+)['"]\s*,\s*\{([\s\S]*?)\}\s*(?:,\s*\{([\s\S]*?)\})?\s*\)/;
  const match = source.match(defineRegex);
  if (!match) return null;

  const modelName = match[1];
  const fields = parseSequelizeFields(match[2]);
  const options = match[3] ? parseSequelizeOptions(match[3]) : {};

  // Try to extract associations from classMethods or separate associate calls
  const associations = extractAssociations(source, modelName);

  const model: RawOrmModel = {
    name: modelName,
    orm: 'sequelize',
    fields,
    options,
    metadata: { style: 'define' },
  };

  return { model, associations };
}

/**
 * sequelize-typescript decorators: @Table class User extends Model { @Column name: string; }
 */
function extractDecoratorModel(source: string, filePath: string): SequelizeModelResult | null {
  const classRegex =
    /@Table\s*(?:\(\s*\{([\s\S]*?)\}\s*\))?\s+export\s+class\s+(\w+)\s+extends\s+Model/;
  const classMatch = source.match(classRegex);
  if (!classMatch) return null;

  const optionsStr = classMatch[1] || '';
  const className = classMatch[2];

  // Extract @Column fields
  const fields: Record<string, unknown>[] = [];
  const colRegex = /@Column\s*(?:\(\s*\{([\s\S]*?)\}\s*\))?\s*(\w+)\s*[?!]?\s*:\s*(\w+)/g;
  let colMatch: RegExpExecArray | null;
  while ((colMatch = colRegex.exec(source)) !== null) {
    const colOptions = colMatch[1] || '';
    fields.push({
      name: colMatch[2],
      type: colMatch[3],
      ...parseColumnOptions(colOptions),
    });
  }

  // Extract decorator-based associations: @HasMany(() => Post), @BelongsTo(() => Role)
  const associations = extractDecoratorAssociations(source, className);

  const tableNameMatch = optionsStr.match(/tableName\s*:\s*['"]([^'"]+)['"]/);
  const paranoidMatch = /paranoid\s*:\s*true/.test(optionsStr);

  const model: RawOrmModel = {
    name: className,
    orm: 'sequelize',
    collectionOrTable: tableNameMatch?.[1],
    fields,
    options: { ...(paranoidMatch ? { paranoid: true } : {}) },
    metadata: { style: 'sequelize-typescript' },
  };

  return { model, associations };
}

// ============================================================
// Migration extraction
// ============================================================

interface MigrationResult {
  models: RawOrmModel[];
}

export function extractSequelizeMigration(
  source: string,
  filePath: string,
): MigrationResult | null {
  const models: RawOrmModel[] = [];

  // Match queryInterface.createTable('name', { ... })
  const createRegex = /queryInterface\.createTable\s*\(\s*['"](\w+)['"]\s*,\s*\{([\s\S]*?)\}\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = createRegex.exec(source)) !== null) {
    const tableName = match[1];
    const fields = parseMigrationFields(match[2]);
    models.push({
      name: tableName,
      orm: 'sequelize',
      collectionOrTable: tableName,
      fields,
      metadata: { source: 'migration', operation: 'createTable' },
    });
  }

  // Match queryInterface.addColumn('table', 'column', { ... })
  const addColRegex =
    /queryInterface\.addColumn\s*\(\s*['"](\w+)['"]\s*,\s*['"](\w+)['"]\s*,\s*\{([\s\S]*?)\}\s*\)/g;
  while ((match = addColRegex.exec(source)) !== null) {
    models.push({
      name: match[1],
      orm: 'sequelize',
      collectionOrTable: match[1],
      fields: [parseColumnDef(match[2], match[3])],
      metadata: { source: 'migration', operation: 'addColumn' },
    });
  }

  return models.length > 0 ? { models } : null;
}

// ============================================================
// Field parsing helpers
// ============================================================

function parseSequelizeFields(body: string): Record<string, unknown>[] {
  const fields: Record<string, unknown>[] = [];
  // Match: fieldName: { type: DataTypes.STRING, ... } or fieldName: DataTypes.STRING
  const fieldRegex =
    /(\w+)\s*:\s*(?:\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}|DataTypes\.(\w+)|(Sequelize\.(\w+)))/g;
  let match: RegExpExecArray | null;
  while ((match = fieldRegex.exec(body)) !== null) {
    const name = match[1];
    if (['type', 'references', 'key', 'model'].includes(name)) continue;

    if (match[2]) {
      // Object form
      const fieldBody = match[2];
      const field: Record<string, unknown> = { name };

      const typeMatch = fieldBody.match(/type\s*:\s*(?:DataTypes|Sequelize)\.(\w+)/);
      if (typeMatch) field.type = typeMatch[1];

      if (/allowNull\s*:\s*false/.test(fieldBody)) field.allowNull = false;
      if (/unique\s*:\s*true/.test(fieldBody)) field.unique = true;
      if (/primaryKey\s*:\s*true/.test(fieldBody)) field.primaryKey = true;
      if (/autoIncrement\s*:\s*true/.test(fieldBody)) field.autoIncrement = true;

      // Foreign key references
      const refMatch = fieldBody.match(/references\s*:\s*\{\s*model\s*:\s*['"](\w+)['"].*?\}/);
      if (refMatch) field.references = refMatch[1];

      // Validate
      const validateMatch = fieldBody.match(/validate\s*:\s*\{([^}]+)\}/);
      if (validateMatch) {
        const validators: string[] = [];
        const valRegex = /(\w+)\s*:/g;
        let vm: RegExpExecArray | null;
        while ((vm = valRegex.exec(validateMatch[1])) !== null) {
          validators.push(vm[1]);
        }
        field.validate = validators;
      }

      fields.push(field);
    } else {
      // Shorthand: DataTypes.STRING
      fields.push({ name, type: match[3] || match[5] });
    }
  }
  return fields;
}

function parseSequelizeOptions(body: string): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  const tableNameMatch = body.match(/tableName\s*:\s*['"]([^'"]+)['"]/);
  if (tableNameMatch) options.tableName = tableNameMatch[1];
  if (/paranoid\s*:\s*true/.test(body)) options.paranoid = true;
  if (/timestamps\s*:\s*true/.test(body)) options.timestamps = true;
  if (/timestamps\s*:\s*false/.test(body)) options.timestamps = false;
  return options;
}

function parseColumnOptions(body: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const typeMatch = body.match(/type\s*:\s*DataType\.(\w+)/);
  if (typeMatch) result.dataType = typeMatch[1];
  if (/allowNull\s*:\s*false/.test(body)) result.allowNull = false;
  return result;
}

function parseMigrationFields(body: string): Record<string, unknown>[] {
  const fields: Record<string, unknown>[] = [];
  const fieldRegex = /(\w+)\s*:\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = fieldRegex.exec(body)) !== null) {
    fields.push(parseColumnDef(match[1], match[2]));
  }
  return fields;
}

function parseColumnDef(name: string, body: string): Record<string, unknown> {
  const field: Record<string, unknown> = { name };
  const typeMatch = body.match(/type\s*:\s*(?:Sequelize|DataTypes)\.(\w+)/);
  if (typeMatch) field.type = typeMatch[1];
  if (/primaryKey\s*:\s*true/.test(body)) field.primaryKey = true;
  if (/autoIncrement\s*:\s*true/.test(body)) field.autoIncrement = true;
  if (/allowNull\s*:\s*false/.test(body)) field.allowNull = false;

  const refMatch = body.match(/references\s*:\s*\{\s*model\s*:\s*['"](\w+)['"]/);
  if (refMatch) field.references = refMatch[1];

  return field;
}

// ============================================================
// Association extraction
// ============================================================

const ASSOCIATION_MAP: Record<string, string> = {
  hasMany: 'sequelize_has_many',
  belongsTo: 'sequelize_belongs_to',
  belongsToMany: 'sequelize_belongs_to_many',
  hasOne: 'sequelize_has_one',
};

function extractAssociations(source: string, className: string): RawOrmAssociation[] {
  const associations: RawOrmAssociation[] = [];

  // Match: ClassName.hasMany(models.Post, { ... }) or this.hasMany(Post, { ... })
  const regex = new RegExp(
    `(?:${className}|this)\\.(hasMany|belongsTo|belongsToMany|hasOne)\\s*\\(\\s*(?:models\\.)?(\\w+)(?:\\.\\w+)?\\s*(?:,\\s*\\{([^}]*)\\})?`,
    'g',
  );

  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    const assocType = match[1];
    const targetModel = match[2];
    const optionsStr = match[3] || '';

    const options: Record<string, unknown> = {};
    const fkMatch = optionsStr.match(/foreignKey\s*:\s*['"](\w+)['"]/);
    if (fkMatch) options.foreignKey = fkMatch[1];
    const asMatch = optionsStr.match(/as\s*:\s*['"](\w+)['"]/);
    if (asMatch) options.as = asMatch[1];
    const throughMatch = optionsStr.match(/through\s*:\s*['"](\w+)['"]/);
    if (throughMatch) options.through = throughMatch[1];

    associations.push({
      sourceModelName: className,
      targetModelName: targetModel,
      kind: assocType,
      options: Object.keys(options).length > 0 ? options : undefined,
    });
  }

  return associations;
}

function extractDecoratorAssociations(source: string, className: string): RawOrmAssociation[] {
  const associations: RawOrmAssociation[] = [];

  // Match: @HasMany(() => Post), @BelongsTo(() => Role), etc.
  const regex = /@(HasMany|BelongsTo|BelongsToMany|HasOne)\s*\(\s*\(\)\s*=>\s*(\w+)\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    const decoratorMap: Record<string, string> = {
      HasMany: 'hasMany',
      BelongsTo: 'belongsTo',
      BelongsToMany: 'belongsToMany',
      HasOne: 'hasOne',
    };
    associations.push({
      sourceModelName: className,
      targetModelName: match[2],
      kind: decoratorMap[match[1]] ?? match[1],
    });
  }

  return associations;
}

// ============================================================
// Hooks and scopes
// ============================================================

function extractHooks(source: string, className: string): string[] {
  const hooks: string[] = [];
  const regex = new RegExp(
    `${className}\\.(before|after)(Create|Update|Destroy|Find|Validate|Save|Sync|BulkCreate|BulkUpdate|BulkDestroy)`,
    'g',
  );
  let m: RegExpExecArray | null;
  while ((m = regex.exec(source)) !== null) {
    hooks.push(`${m[1]}${m[2]}`);
  }

  // Also match addHook pattern
  const hookRegex = new RegExp(`${className}\\.addHook\\s*\\(\\s*['"]([^'"]+)['"]`, 'g');
  while ((m = hookRegex.exec(source)) !== null) {
    hooks.push(m[1]);
  }

  return hooks;
}

function extractScopes(source: string, className: string): string[] {
  const scopes: string[] = [];
  // Match scopes in options: scopes: { active: { ... }, ... }
  const scopeBlockRegex = /scopes\s*:\s*\{([\s\S]*?)\}/;
  const blockMatch = source.match(scopeBlockRegex);
  if (blockMatch) {
    const scopeRegex = /(\w+)\s*:\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = scopeRegex.exec(blockMatch[1])) !== null) {
      scopes.push(m[1]);
    }
  }

  // Also match addScope pattern
  const addScopeRegex = new RegExp(`${className}\\.addScope\\s*\\(\\s*['"]([^'"]+)['"]`, 'g');
  let m: RegExpExecArray | null;
  while ((m = addScopeRegex.exec(source)) !== null) {
    scopes.push(m[1]);
  }

  return scopes;
}
