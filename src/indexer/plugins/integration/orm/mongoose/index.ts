/**
 * MongoosePlugin — Framework plugin for Mongoose ODM.
 *
 * Extracts:
 * - Schema definitions (fields, types, options)
 * - Model registrations (mongoose.model)
 * - ObjectId refs → cross-model edges
 * - Virtuals (getter/populate)
 * - Middleware (pre/post hooks)
 * - Methods, statics, query helpers
 * - Plugins, indexes, discriminators
 * - @nestjs/mongoose and Typegoose decorators
 *
 * Supports Mongoose 5.x–8.x.
 */
import fs from 'node:fs';
import path from 'node:path';
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
import { escapeRegExp } from '../../../../../utils/security.js';

export class MongoosePlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'mongoose',
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
    if ('mongoose' in deps) return true;

    // Fallback: read package.json from disk
    try {
      const pkgPath = path.join(ctx.rootPath, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const json = JSON.parse(content);
      const allDeps = { ...json.dependencies, ...json.devDependencies };
      return 'mongoose' in allDeps;
    } catch {
      return false;
    }
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 'mongoose_references',
          category: 'mongoose',
          description: 'ObjectId ref to another model',
        },
        { name: 'mongoose_has_virtual', category: 'mongoose', description: 'Schema virtual field' },
        {
          name: 'mongoose_has_middleware',
          category: 'mongoose',
          description: 'Schema pre/post hook',
        },
        {
          name: 'mongoose_has_method',
          category: 'mongoose',
          description: 'Schema instance method',
        },
        { name: 'mongoose_has_static', category: 'mongoose', description: 'Schema static method' },
        {
          name: 'mongoose_discriminates',
          category: 'mongoose',
          description: 'Model discriminator',
        },
        { name: 'mongoose_has_index', category: 'mongoose', description: 'Schema index' },
        { name: 'mongoose_uses_plugin', category: 'mongoose', description: 'Schema plugin' },
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

    const extraction = extractMongooseSchema(source, filePath);
    if (extraction) {
      result.ormModels = [extraction.model];
      result.ormAssociations = extraction.associations;
      result.frameworkRole = 'mongoose_model';
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}

// ============================================================
// Schema extraction
// ============================================================

interface MongooseExtractionResult {
  model: RawOrmModel;
  associations: RawOrmAssociation[];
}

/**
 * Extract Mongoose schema definition from source file.
 * Detects: new Schema({...}), mongoose.model('Name', schema), @Schema(), @modelOptions()
 */
export function extractMongooseSchema(
  source: string,
  filePath: string,
): MongooseExtractionResult | null {
  // Try plain mongoose first, then decorators
  return (
    extractPlainMongooseSchema(source, filePath) ??
    extractNestMongooseSchema(source, filePath) ??
    extractTypegooseSchema(source, filePath)
  );
}

/**
 * Extract plain mongoose schema: new Schema({...}) + mongoose.model('Name', schema)
 */
function extractPlainMongooseSchema(
  source: string,
  filePath: string,
): MongooseExtractionResult | null {
  // Match: new mongoose.Schema({...}) or new Schema({...})
  const schemaRegex =
    /(?:const|let|var)\s+(\w+)\s*=\s*new\s+(?:mongoose\.)?Schema\s*\(\s*\{([\s\S]*?)\}\s*(?:,\s*\{([\s\S]*?)\})?\s*\)/;
  const schemaMatch = source.match(schemaRegex);
  if (!schemaMatch) return null;

  const schemaVarName = schemaMatch[1];
  const fieldsBody = schemaMatch[2];
  const optionsBody = schemaMatch[3];

  // Find model name: mongoose.model('Name', schema) or model('Name', schema)
  const modelRegex = new RegExp(
    `(?:mongoose\\.)?model\\s*\\(\\s*['"]([^'"]+)['"]\\s*,\\s*${escapeRegExp(schemaVarName)}\\s*\\)`,
  );
  const modelMatch = source.match(modelRegex);
  const modelName = modelMatch?.[1] ?? schemaVarName.replace(/Schema$/, '');

  // Parse fields
  const fields = parseSchemaFields(fieldsBody);

  // Parse options
  const options = optionsBody ? parseSchemaOptions(optionsBody) : undefined;

  // Extract collection name
  const collectionMatch = optionsBody?.match(/collection\s*:\s*['"]([^'"]+)['"]/);
  const collectionName = collectionMatch?.[1];

  // Build model
  const model: RawOrmModel = {
    name: modelName,
    orm: 'mongoose',
    collectionOrTable: collectionName,
    fields,
    options,
    metadata: {
      schemaVar: schemaVarName,
      virtuals: extractVirtuals(source, schemaVarName),
      middleware: extractMiddleware(source, schemaVarName),
      methods: extractMethods(source, schemaVarName),
      statics: extractStatics(source, schemaVarName),
      plugins: extractPlugins(source, schemaVarName),
      indexes: extractIndexes(source, schemaVarName),
      discriminators: extractDiscriminators(source, modelName),
    },
  };

  // Extract refs as associations
  const associations = extractRefs(fields, modelName);

  return { model, associations };
}

/**
 * Extract @nestjs/mongoose decorated schema.
 * @Schema() class User { @Prop({...}) name: string; }
 */
function extractNestMongooseSchema(
  source: string,
  filePath: string,
): MongooseExtractionResult | null {
  const classRegex = /@Schema\s*\(([^)]*)\)\s*export\s+class\s+(\w+)/;
  const classMatch = source.match(classRegex);
  if (!classMatch) return null;

  const optionsStr = classMatch[1];
  const className = classMatch[2];

  // Extract @Prop() fields
  const fields: Record<string, unknown>[] = [];
  const propRegex = /@Prop\s*\(\s*(?:\{([\s\S]*?)\})?\s*\)\s*(\w+)\s*[?!]?\s*:\s*([^;]+)/g;
  let propMatch: RegExpExecArray | null;
  while ((propMatch = propRegex.exec(source)) !== null) {
    const propOptions = propMatch[1] || '';
    const fieldName = propMatch[2];
    const fieldType = propMatch[3].trim();
    fields.push({
      name: fieldName,
      type: fieldType,
      ...parsePropOptions(propOptions),
    });
  }

  const collectionMatch = optionsStr?.match(/collection\s*:\s*['"]([^'"]+)['"]/);

  const model: RawOrmModel = {
    name: className,
    orm: 'mongoose',
    collectionOrTable: collectionMatch?.[1],
    fields,
    metadata: { style: 'nestjs-mongoose' },
  };

  const associations = extractRefs(fields, className);
  return { model, associations };
}

/**
 * Extract Typegoose decorated schema.
 * @modelOptions({...}) class User { @prop({...}) public name!: string; }
 */
function extractTypegooseSchema(source: string, filePath: string): MongooseExtractionResult | null {
  const classRegex = /@modelOptions\s*\(\s*\{([\s\S]*?)\}\s*\)\s*export\s+class\s+(\w+)/;
  const classMatch = source.match(classRegex);
  if (!classMatch) return null;

  const optionsStr = classMatch[1];
  const className = classMatch[2];

  // Extract @prop() fields
  const fields: Record<string, unknown>[] = [];
  const propRegex = /@prop\s*\(\s*(?:\{([\s\S]*?)\})?\s*\)\s*public\s+(\w+)\s*[?!]?\s*:\s*([^;]+)/g;
  let propMatch: RegExpExecArray | null;
  while ((propMatch = propRegex.exec(source)) !== null) {
    const propOptions = propMatch[1] || '';
    const fieldName = propMatch[2];
    const fieldType = propMatch[3].trim();
    fields.push({
      name: fieldName,
      type: fieldType,
      ...parsePropOptions(propOptions),
    });
  }

  const collectionMatch = optionsStr?.match(/collection\s*:\s*['"]([^'"]+)['"]/);

  const model: RawOrmModel = {
    name: className,
    orm: 'mongoose',
    collectionOrTable: collectionMatch?.[1],
    fields,
    metadata: { style: 'typegoose' },
  };

  const associations = extractRefs(fields, className);
  return { model, associations };
}

// ============================================================
// Field parsing
// ============================================================

function parseSchemaFields(body: string): Record<string, unknown>[] {
  const fields: Record<string, unknown>[] = [];

  // Match top-level field definitions:
  // name: { type: String, ... }
  // name: String
  // name: [{ type: ObjectId, ref: 'Post' }]  (array)
  const fieldRegex =
    /(\w+)\s*:\s*(?:\[\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}\s*\]|\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}|(\w[\w.]*(?:\.\w+)*)(?:\s*,)?)/g;
  let match: RegExpExecArray | null;
  while ((match = fieldRegex.exec(body)) !== null) {
    const fieldName = match[1];
    // Skip common non-field names
    if (
      [
        'type',
        'ref',
        'required',
        'default',
        'enum',
        'unique',
        'index',
        'select',
        'validate',
      ].includes(fieldName)
    )
      continue;

    if (match[2]) {
      // Array of objects form: [{ type: ObjectId, ref: 'Post' }]
      const fieldBody = match[2];
      const field: Record<string, unknown> = { name: fieldName, isArray: true };

      const typeMatch = fieldBody.match(/type\s*:\s*([\w.]+(?:\.\w+)*)/);
      if (typeMatch) field.type = typeMatch[1];

      const refMatch = fieldBody.match(/ref\s*:\s*['"]([^'"]+)['"]/);
      if (refMatch) field.ref = refMatch[1];

      if (/required\s*:\s*true/.test(fieldBody)) field.required = true;

      fields.push(field);
    } else if (match[3]) {
      // Object form: { type: String, required: true, ... }
      const fieldBody = match[3];
      const field: Record<string, unknown> = { name: fieldName };

      const typeMatch = fieldBody.match(/type\s*:\s*([\w.]+(?:\.\w+)*)/);
      if (typeMatch) field.type = typeMatch[1];

      const refMatch = fieldBody.match(/ref\s*:\s*['"]([^'"]+)['"]/);
      if (refMatch) field.ref = refMatch[1];

      if (/required\s*:\s*true/.test(fieldBody)) field.required = true;
      if (/unique\s*:\s*true/.test(fieldBody)) field.unique = true;
      if (/index\s*:\s*true/.test(fieldBody)) field.index = true;

      const enumMatch = fieldBody.match(/enum\s*:\s*\[([^\]]+)\]/);
      if (enumMatch) {
        const enumValues: string[] = [];
        const valRegex = /['"]([^'"]+)['"]/g;
        let vm: RegExpExecArray | null;
        while ((vm = valRegex.exec(enumMatch[1])) !== null) {
          enumValues.push(vm[1]);
        }
        field.enum = enumValues;
      }

      const defaultMatch = fieldBody.match(/default\s*:\s*['"]?([^'",}\s]+)['"]?/);
      if (defaultMatch) field.default = defaultMatch[1];

      fields.push(field);
    } else if (match[4]) {
      // Shorthand form: name: String
      fields.push({ name: fieldName, type: match[4] });
    }
  }

  return fields;
}

function parseSchemaOptions(body: string): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if (/timestamps\s*:\s*true/.test(body)) options.timestamps = true;
  if (/collection\s*:\s*['"]([^'"]+)['"]/.test(body)) {
    options.collection = body.match(/collection\s*:\s*['"]([^'"]+)['"]/)?.[1];
  }
  if (/versionKey\s*:\s*false/.test(body)) options.versionKey = false;
  if (/strict\s*:\s*false/.test(body)) options.strict = false;
  return options;
}

function parsePropOptions(body: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (/required\s*:\s*true/.test(body)) result.required = true;
  if (/unique\s*:\s*true/.test(body)) result.unique = true;

  const refMatch = body.match(/ref\s*:\s*(?:['"]([^'"]+)['"]|(?:\(\)\s*=>\s*)?(\w+))/);
  if (refMatch) result.ref = refMatch[1] ?? refMatch[2];

  const typeMatch = body.match(/type\s*:\s*([\w.]+)/);
  if (typeMatch) result.mongooseType = typeMatch[1];

  return result;
}

// ============================================================
// Metadata extraction (virtuals, middleware, methods, etc.)
// ============================================================

function extractVirtuals(source: string, schemaVar: string): string[] {
  const virtuals: string[] = [];
  const regex = new RegExp(`${escapeRegExp(schemaVar)}\\.virtual\\s*\\(\\s*['"]([^'"]+)['"]`, 'g');
  let m: RegExpExecArray | null;
  while ((m = regex.exec(source)) !== null) {
    virtuals.push(m[1]);
  }
  return virtuals;
}

function extractMiddleware(
  source: string,
  schemaVar: string,
): Array<{ hook: string; event: string }> {
  const middleware: Array<{ hook: string; event: string }> = [];
  const regex = new RegExp(
    `${escapeRegExp(schemaVar)}\\.(pre|post)\\s*\\(\\s*['"]([^'"]+)['"]`,
    'g',
  );
  let m: RegExpExecArray | null;
  while ((m = regex.exec(source)) !== null) {
    middleware.push({ hook: m[1], event: m[2] });
  }
  return middleware;
}

function extractMethods(source: string, schemaVar: string): string[] {
  const methods: string[] = [];
  const regex = new RegExp(`${escapeRegExp(schemaVar)}\\.methods\\.(\\w+)`, 'g');
  let m: RegExpExecArray | null;
  while ((m = regex.exec(source)) !== null) {
    methods.push(m[1]);
  }
  return methods;
}

function extractStatics(source: string, schemaVar: string): string[] {
  const statics: string[] = [];
  const regex = new RegExp(`${escapeRegExp(schemaVar)}\\.statics\\.(\\w+)`, 'g');
  let m: RegExpExecArray | null;
  while ((m = regex.exec(source)) !== null) {
    statics.push(m[1]);
  }
  return statics;
}

function extractPlugins(source: string, schemaVar: string): string[] {
  const plugins: string[] = [];
  const regex = new RegExp(`${escapeRegExp(schemaVar)}\\.plugin\\s*\\(\\s*(\\w+)`, 'g');
  let m: RegExpExecArray | null;
  while ((m = regex.exec(source)) !== null) {
    plugins.push(m[1]);
  }
  return plugins;
}

function extractIndexes(source: string, schemaVar: string): string[] {
  const indexes: string[] = [];
  const regex = new RegExp(`${escapeRegExp(schemaVar)}\\.index\\s*\\(\\s*\\{([^}]+)\\}`, 'g');
  let m: RegExpExecArray | null;
  while ((m = regex.exec(source)) !== null) {
    indexes.push(m[1].trim());
  }
  return indexes;
}

function extractDiscriminators(source: string, modelName: string): string[] {
  const discriminators: string[] = [];
  const regex = new RegExp(
    `${escapeRegExp(modelName)}\\.discriminator\\s*\\(\\s*['"]([^'"]+)['"]`,
    'g',
  );
  let m: RegExpExecArray | null;
  while ((m = regex.exec(source)) !== null) {
    discriminators.push(m[1]);
  }
  return discriminators;
}

/**
 * Extract ref associations from parsed fields.
 */
function extractRefs(
  fields: Record<string, unknown>[],
  sourceModelName: string,
): RawOrmAssociation[] {
  const associations: RawOrmAssociation[] = [];
  for (const field of fields) {
    if (field.ref && typeof field.ref === 'string') {
      associations.push({
        sourceModelName,
        targetModelName: field.ref as string,
        kind: 'ref',
        options: { field: field.name },
      });
    }
  }
  return associations;
}
