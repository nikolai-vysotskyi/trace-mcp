/**
 * Django model extraction from Python source files.
 *
 * Detects:
 * - class X(models.Model): ... with field definitions
 * - ForeignKey, ManyToManyField, OneToOneField → associations
 * - Standard field types (CharField, IntegerField, etc.)
 * - Meta class options (db_table, ordering, etc.)
 */
import type { RawOrmAssociation, RawOrmModel } from '../../../../../plugin-api/types.js';

interface DjangoModelExtractionResult {
  model: RawOrmModel;
  associations: RawOrmAssociation[];
}

/** Relationship field types and their association kind. */
const RELATIONSHIP_FIELDS: Record<string, string> = {
  ForeignKey: 'foreign_key',
  ManyToManyField: 'many_to_many',
  OneToOneField: 'one_to_one',
  GenericForeignKey: 'generic_foreign_key',
};

/**
 * Extract Django model definitions from a Python source file.
 * Returns all models found in the file.
 */
export function extractDjangoModels(
  source: string,
  filePath: string,
): DjangoModelExtractionResult[] {
  const results: DjangoModelExtractionResult[] = [];

  // Match class X(models.Model): or class X(SomeModel): with indented body
  const classRegex = /^class\s+(\w+)\s*\(\s*([\w.,\s]+)\s*\)\s*:/gm;
  let classMatch: RegExpExecArray | null;

  while ((classMatch = classRegex.exec(source)) !== null) {
    const className = classMatch[1];
    const bases = classMatch[2];

    // Check if this extends models.Model (or a known Django base)
    if (!isDjangoModel(bases)) continue;

    const classBodyStart = classMatch.index + classMatch[0].length;
    const classBody = extractClassBody(source, classBodyStart);
    if (!classBody) continue;

    const fields = extractFields(classBody);
    const associations = extractAssociations(classBody, className);
    const meta = extractMeta(classBody);

    const model: RawOrmModel = {
      name: className,
      orm: 'django',
      collectionOrTable: meta.dbTable,
      fields,
      metadata: {
        framework: 'django',
        bases,
        abstract: meta.abstract,
        ordering: meta.ordering,
        filePath,
      },
    };

    results.push({ model, associations });
  }

  return results;
}

/** Check if base classes indicate a Django model. */
function isDjangoModel(bases: string): boolean {
  const baseList = bases.split(',').map((b) => b.trim());
  return baseList.some(
    (b) =>
      b === 'models.Model' ||
      b === 'Model' ||
      b.endsWith('Model') ||
      b.endsWith('Mixin') ||
      b === 'AbstractUser' ||
      b === 'AbstractBaseUser' ||
      b === 'PermissionsMixin' ||
      b.includes('models.') ||
      // Common DRF / third-party bases
      b === 'TimeStampedModel' ||
      b === 'SoftDeletableModel',
  );
}

/**
 * Extract the indented body of a class definition.
 * Looks for contiguous lines with greater indentation than the class keyword.
 */
function extractClassBody(source: string, startIndex: number): string | null {
  const lines = source.substring(startIndex).split('\n');
  const bodyLines: string[] = [];
  let baseIndent: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimEnd();

    // Skip empty lines
    if (!trimmed) {
      bodyLines.push('');
      continue;
    }

    const indent = line.length - line.trimStart().length;

    // First non-empty line sets the base indent
    if (baseIndent === null) {
      if (indent === 0 && i > 0) break; // Dedented immediately
      baseIndent = indent;
    }

    // If we've returned to the same or lesser indentation, body is done
    if (indent < baseIndent && trimmed.length > 0) break;

    bodyLines.push(trimmed);
  }

  const body = bodyLines.join('\n').trim();
  return body || null;
}

/** Extract field definitions from a class body. */
function extractFields(classBody: string): Record<string, unknown>[] {
  const fields: Record<string, unknown>[] = [];

  // Match: field_name = models.FieldType(...) or field_name = FieldType(...)
  const fieldRegex = /^(\w+)\s*=\s*(?:models\.)?(\w+Field)\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)/gm;
  let match: RegExpExecArray | null;

  while ((match = fieldRegex.exec(classBody)) !== null) {
    const fieldName = match[1];
    const fieldType = match[2];
    const args = match[3];

    const field: Record<string, unknown> = {
      name: fieldName,
      type: fieldType,
    };

    // Parse common field options
    if (/max_length\s*=\s*(\d+)/.test(args)) {
      field.maxLength = parseInt(args.match(/max_length\s*=\s*(\d+)/)![1], 10);
    }
    if (/null\s*=\s*True/.test(args)) field.nullable = true;
    if (/blank\s*=\s*True/.test(args)) field.blank = true;
    if (/unique\s*=\s*True/.test(args)) field.unique = true;
    if (/primary_key\s*=\s*True/.test(args)) field.primaryKey = true;
    if (/db_index\s*=\s*True/.test(args)) field.index = true;

    const defaultMatch = args.match(/default\s*=\s*([^,)]+)/);
    if (defaultMatch) field.default = defaultMatch[1].trim();

    // For relationship fields, extract the target model
    if (fieldType in RELATIONSHIP_FIELDS) {
      const target = extractRelationshipTarget(args);
      if (target) field.relatedModel = target;

      const relatedName = args.match(/related_name\s*=\s*['"]([^'"]+)['"]/);
      if (relatedName) field.relatedName = relatedName[1];

      const onDelete = args.match(/on_delete\s*=\s*(?:models\.)?(\w+)/);
      if (onDelete) field.onDelete = onDelete[1];
    }

    fields.push(field);
  }

  return fields;
}

/** Extract the target model name from a relationship field's arguments. */
function extractRelationshipTarget(args: string): string | null {
  // First positional argument: 'AppName.ModelName', 'ModelName', ModelName, 'self'
  const stringTarget = args.match(/^\s*['"]([^'"]+)['"]/);
  if (stringTarget) return stringTarget[1];

  // Direct reference: ForeignKey(User, ...) or ForeignKey(User)
  const directTarget = args.match(/^\s*(\w+)/);
  if (directTarget && directTarget[1] !== 'to' && directTarget[1] !== 'self') {
    return directTarget[1];
  }

  // to='ModelName' keyword
  const toKw = args.match(/to\s*=\s*['"]([^'"]+)['"]/);
  if (toKw) return toKw[1];

  // to=ModelName
  const toRef = args.match(/to\s*=\s*(\w+)/);
  if (toRef) return toRef[1];

  // 'self' reference
  if (/^\s*['"]self['"]/.test(args) || /^\s*self\b/.test(args)) return 'self';

  return null;
}

/** Extract associations (relationship fields) from a class body. */
function extractAssociations(classBody: string, sourceModelName: string): RawOrmAssociation[] {
  const associations: RawOrmAssociation[] = [];
  const lines = classBody.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    for (const [fieldType, kind] of Object.entries(RELATIONSHIP_FIELDS)) {
      // Match: name = models.ForeignKey(...) or name = ForeignKey(...)
      const regex = new RegExp(`^(\\w+)\\s*=\\s*(?:models\\.)?${fieldType}\\s*\\((.*)\\)`);
      const match = line.match(regex);
      if (!match) continue;

      const args = match[2];
      const target = extractRelationshipTarget(args);
      if (!target || target === 'self') continue;

      // Normalize 'app_label.ModelName' to just 'ModelName'
      const targetModel = target.includes('.') ? target.split('.').pop()! : target;

      associations.push({
        sourceModelName,
        targetModelName: targetModel,
        kind,
        options: { fieldName: match[1] },
        line: i + 1,
      });
    }
  }

  return associations;
}

/** Extract Meta class options. */
function extractMeta(classBody: string): {
  dbTable?: string;
  abstract?: boolean;
  ordering?: string[];
} {
  const meta: { dbTable?: string; abstract?: boolean; ordering?: string[] } = {};

  // Match class Meta: block
  const metaMatch = classBody.match(
    /class\s+Meta\s*:\s*\n([\s\S]*?)(?=\n\s*(?:class\s|def\s|\w+\s*=)|$)/,
  );
  if (!metaMatch) return meta;

  const metaBody = metaMatch[1];

  const dbTable = metaBody.match(/db_table\s*=\s*['"]([^'"]+)['"]/);
  if (dbTable) meta.dbTable = dbTable[1];

  if (/abstract\s*=\s*True/.test(metaBody)) meta.abstract = true;

  const ordering = metaBody.match(/ordering\s*=\s*\[([^\]]*)\]/);
  if (ordering) {
    const items: string[] = [];
    const regex = /['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(ordering[1])) !== null) {
      items.push(m[1]);
    }
    meta.ordering = items;
  }

  return meta;
}
