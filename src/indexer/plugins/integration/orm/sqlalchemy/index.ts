/**
 * SQLAlchemyPlugin — Framework plugin for SQLAlchemy ORM (Python).
 *
 * Extracts:
 * - Declarative models: classes inheriting Base/DeclarativeBase with __tablename__
 * - ForeignKey constraints: mapped_column(ForeignKey('table.id')) and Column(ForeignKey(...))
 * - relationship() definitions → cross-model edges
 * - Alembic migrations: op.create_table, op.add_column, op.drop_table
 *
 * Uses tree-sitter-python for AST parsing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok, err } from 'neverthrow';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawOrmModel,
  EdgeTypeDeclaration,
  RawMigration,
} from '../../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../../errors.js';
import { parseError } from '../../../../../errors.js';
import { escapeRegExp } from '../../../../../utils/security.js';
import { getParser } from '../../../../../parser/tree-sitter.js';

/** Known base classes for SQLAlchemy declarative models. */
const MODEL_BASES = new Set([
  'Base',
  'DeclarativeBase',
  'DeclarativeBaseNoMeta',
  'MappedAsDataclass',
  'db.Model',
]);

/**
 * Check if a Python project has a given package in its dependencies.
 */
function hasPythonDep(ctx: ProjectContext, pkg: string): boolean {
  const lowerPkg = pkg.toLowerCase();

  if (ctx.pyprojectToml) {
    const deps = ctx.pyprojectToml._parsedDeps as string[] | undefined;
    if (deps?.includes(lowerPkg)) return true;
  }

  if (ctx.requirementsTxt?.includes(lowerPkg)) return true;

  try {
    const pyprojectPath = path.join(ctx.rootPath, 'pyproject.toml');
    const content = fs.readFileSync(pyprojectPath, 'utf-8');
    const re = new RegExp(`["']${escapeRegExp(pkg)}[>=<\\[!~\\s"']`, 'i');
    if (re.test(content)) return true;
  } catch {
    /* not found */
  }

  try {
    const reqPath = path.join(ctx.rootPath, 'requirements.txt');
    const content = fs.readFileSync(reqPath, 'utf-8');
    const re = new RegExp(`^${escapeRegExp(pkg)}\\b`, 'im');
    if (re.test(content)) return true;
  } catch {
    /* not found */
  }

  return false;
}

export class SQLAlchemyPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'sqlalchemy',
    version: '1.0.0',
    priority: 10,
    category: 'orm',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    return hasPythonDep(ctx, 'sqlalchemy');
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 'sqla_relationship',
          category: 'sqlalchemy',
          description: 'SQLAlchemy relationship() between models',
        },
        {
          name: 'sqla_fk',
          category: 'sqlalchemy',
          description: 'SQLAlchemy ForeignKey constraint',
        },
        {
          name: 'sqla_migrates',
          category: 'sqlalchemy',
          description: 'Alembic migration operation on a table',
        },
      ] satisfies EdgeTypeDeclaration[],
    };
  }

  async extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): Promise<TraceMcpResult<FileParseResult>> {
    if (language !== 'python') {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');

    const result: FileParseResult = {
      status: 'ok',
      symbols: [],
      ormModels: [],
      ormAssociations: [],
      edges: [],
      migrations: [],
      warnings: [],
    };

    // Check if this is an Alembic migration file
    const isAlembicMigration =
      filePath.includes('alembic/versions/') || filePath.includes('migrations/versions/');

    if (isAlembicMigration) {
      // Quick check for migration operations
      if (
        source.includes('op.create_table') ||
        source.includes('op.add_column') ||
        source.includes('op.drop_table')
      ) {
        try {
          const parser = await getParser('python');
          const tree = parser.parse(source);
          this.extractAlembicMigrations(tree.rootNode, source, filePath, result);
        } catch (e: unknown) {
          return err(
            parseError(
              filePath,
              `SQLAlchemy migration parse error: ${e instanceof Error ? e.message : String(e)}`,
            ),
          );
        }
        result.frameworkRole = 'alembic_migration';
        return ok(result);
      }
      return ok(result);
    }

    // Quick check — skip files that don't look like SQLAlchemy models
    if (
      !source.includes('Column') &&
      !source.includes('mapped_column') &&
      !source.includes('relationship') &&
      !source.includes('ForeignKey') &&
      !source.includes('__tablename__') &&
      !source.includes('DeclarativeBase') &&
      !source.includes('declarative_base')
    ) {
      return ok({ status: 'ok', symbols: [] });
    }

    try {
      const parser = await getParser('python');
      const tree = parser.parse(source);
      const root = tree.rootNode;

      this.extractModels(root, source, filePath, result);
    } catch (e: unknown) {
      return err(
        parseError(
          filePath,
          `SQLAlchemy parse error: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }

    return ok(result);
  }

  /**
   * Extract SQLAlchemy model classes from the AST.
   *
   * Detects class definitions that:
   * 1. Inherit from Base, DeclarativeBase, db.Model, etc.
   * 2. Have a __tablename__ assignment in their body
   */
  private extractModels(
    root: any,
    source: string,
    filePath: string,
    result: FileParseResult,
  ): void {
    const classDefs = this.findAllTopLevelClasses(root);

    for (const classDef of classDefs) {
      const className = classDef.childForFieldName('name')?.text;
      if (!className) continue;

      // Check superclasses
      const superclasses = classDef.childForFieldName('superclasses');
      if (!superclasses) continue;

      const bases = this.extractSuperclassNames(superclasses);
      const isSQLAlchemyModel = bases.some((b) => MODEL_BASES.has(b));
      if (!isSQLAlchemyModel) continue;

      // Get class body
      const body = classDef.childForFieldName('body');
      if (!body) continue;

      // Look for __tablename__ assignment
      const tableName = this.extractTableName(body);
      if (!tableName) continue;

      // This is a SQLAlchemy model
      const fields = this.extractModelFields(body, source);
      const foreignKeys = this.extractForeignKeys(body, source, className, tableName);
      const relationships = this.extractRelationships(body, source, className);

      const model: RawOrmModel = {
        name: className,
        orm: 'sqlalchemy',
        collectionOrTable: tableName,
        fields,
        metadata: {
          filePath,
          bases: bases.join(', '),
          line: classDef.startPosition.row + 1,
        },
      };

      result.ormModels!.push(model);
      result.frameworkRole = 'sqlalchemy_model';

      // Add foreign key edges
      for (const fk of foreignKeys) {
        result.edges!.push({
          edgeType: 'sqla_fk',
          metadata: {
            sourceModel: className,
            sourceTable: tableName,
            targetTable: fk.targetTable,
            targetColumn: fk.targetColumn,
            columnName: fk.columnName,
            filePath,
          },
        });
      }

      // Add relationship edges and ORM associations
      for (const rel of relationships) {
        result.edges!.push({
          edgeType: 'sqla_relationship',
          metadata: {
            sourceModel: className,
            targetModel: rel.targetModel,
            attributeName: rel.attributeName,
            backPopulates: rel.backPopulates,
            backRef: rel.backRef,
            uselist: rel.uselist,
            filePath,
          },
        });

        result.ormAssociations!.push({
          sourceModelName: className,
          targetModelName: rel.targetModel,
          kind: rel.uselist === false ? 'one_to_one' : 'one_to_many',
          options: {
            backPopulates: rel.backPopulates,
            backRef: rel.backRef,
          },
          line: rel.line,
        });
      }
    }
  }

  /**
   * Extract Alembic migration operations from a migration file.
   *
   * Detects:
   * - op.create_table('name', ...)
   * - op.add_column('table', ...)
   * - op.drop_table('name')
   */
  private extractAlembicMigrations(
    root: any,
    source: string,
    filePath: string,
    result: FileParseResult,
  ): void {
    const calls = this.findAllByType(root, 'call');

    // Try to extract revision timestamp from the file name
    const fileBaseName = path.basename(filePath);
    const timestampMatch = fileBaseName.match(/^(\d+)_/);
    const timestamp = timestampMatch ? timestampMatch[1] : undefined;

    for (const call of calls) {
      const funcRef = call.childForFieldName('function');
      if (!funcRef || funcRef.type !== 'attribute') continue;

      const object = funcRef.childForFieldName('object')?.text;
      if (object !== 'op') continue;

      const method = funcRef.childForFieldName('attribute')?.text;
      if (!method) continue;

      const args = call.childForFieldName('arguments');
      if (!args) continue;

      let operation: 'create' | 'alter' | 'drop' | null = null;
      if (method === 'create_table') operation = 'create';
      else if (method === 'add_column' || method === 'alter_column' || method === 'drop_column')
        operation = 'alter';
      else if (method === 'drop_table') operation = 'drop';
      else continue;

      const tableName = this.extractFirstStringArg(args);
      if (!tableName) continue;

      const migration: RawMigration = {
        tableName,
        operation,
        timestamp,
      };

      result.migrations!.push(migration);

      result.edges!.push({
        edgeType: 'sqla_migrates',
        metadata: {
          operation,
          tableName,
          method,
          filePath,
          line: call.startPosition.row + 1,
        },
      });
    }
  }

  // ─── Model extraction helpers ──────────────────────────────────────

  /** Find all class_definition nodes (including inside decorated_definition). */
  private findAllTopLevelClasses(root: any): any[] {
    const classes: any[] = [];
    for (const child of root.children ?? []) {
      if (child.type === 'class_definition') {
        classes.push(child);
      } else if (child.type === 'decorated_definition') {
        const innerClass = child.children.find((c: any) => c.type === 'class_definition');
        if (innerClass) classes.push(innerClass);
      }
    }
    return classes;
  }

  /** Extract superclass names from an argument_list node. */
  private extractSuperclassNames(superclasses: any): string[] {
    const names: string[] = [];
    for (const child of superclasses.children ?? []) {
      if (child.type === 'identifier') {
        names.push(child.text);
      } else if (child.type === 'attribute') {
        names.push(child.text);
      }
    }
    return names;
  }

  /** Extract __tablename__ = 'table_name' from a class body. */
  private extractTableName(body: any): string | null {
    for (const stmt of body.children ?? []) {
      if (stmt.type !== 'expression_statement') continue;
      const assignment = stmt.children.find((c: any) => c.type === 'assignment');
      if (!assignment) continue;

      const left = assignment.childForFieldName('left');
      if (!left || left.text !== '__tablename__') continue;

      const right = assignment.childForFieldName('right');
      if (!right || right.type !== 'string') continue;

      return this.unquote(right.text);
    }
    return null;
  }

  /**
   * Extract model field definitions from the class body.
   *
   * Patterns:
   *   name: Mapped[str] = mapped_column(String(50))
   *   name = Column(String(50), nullable=False)
   */
  private extractModelFields(body: any, source: string): Record<string, unknown>[] {
    const fields: Record<string, unknown>[] = [];

    for (const stmt of body.children ?? []) {
      if (stmt.type !== 'expression_statement') continue;

      // Handle both assignment and type_alias_statement
      const assignment = stmt.children.find((c: any) => c.type === 'assignment');
      if (!assignment) continue;

      const left = assignment.childForFieldName('left');
      if (!left) continue;

      const fieldName = left.text;
      // Skip dunder and private attributes
      if (fieldName.startsWith('_')) continue;

      const right = assignment.childForFieldName('right');
      if (!right) continue;

      // Check if it's a Column() or mapped_column() call
      const callFunc = right.type === 'call' ? right.childForFieldName('function')?.text : null;

      if (callFunc === 'Column' || callFunc === 'mapped_column') {
        fields.push({
          name: fieldName,
          definition: right.text,
          line: stmt.startPosition.row + 1,
        });
      } else if (callFunc === 'relationship') {
      }
    }

    // Also handle annotated assignments: name: Mapped[str] = mapped_column(...)
    for (const stmt of body.children ?? []) {
      // Check for typed assignments that are a different node type
      if (stmt.type === 'type_alias_statement') continue;

      // Look for patterns like: name: Mapped[str] = mapped_column(...)
      // These may appear as expression_statement > assignment with type annotation
      // OR as standalone typed assignment nodes
      // tree-sitter-python may represent these differently
    }

    return fields;
  }

  /**
   * Extract ForeignKey references from Column/mapped_column calls.
   *
   * Patterns:
   *   user_id: Mapped[int] = mapped_column(ForeignKey('users.id'))
   *   user_id = Column(Integer, ForeignKey('users.id'))
   */
  private extractForeignKeys(
    body: any,
    source: string,
    modelName: string,
    tableName: string,
  ): Array<{ columnName: string; targetTable: string; targetColumn: string }> {
    const fks: Array<{ columnName: string; targetTable: string; targetColumn: string }> = [];

    // Find all ForeignKey() calls within the class body
    const fkCalls = this.findAllByType(body, 'call');

    for (const call of fkCalls) {
      const funcRef = call.childForFieldName('function');
      if (!funcRef) continue;

      const funcName = funcRef.text;
      if (funcName !== 'ForeignKey') continue;

      const args = call.childForFieldName('arguments');
      if (!args) continue;

      const fkTarget = this.extractFirstStringArg(args);
      if (!fkTarget) continue;

      // Parse 'table.column' format
      const parts = fkTarget.split('.');
      if (parts.length !== 2) continue;

      // Walk up to find the column name (the assignment target)
      const columnName = this.findParentColumnName(call, body);

      fks.push({
        columnName: columnName ?? 'unknown',
        targetTable: parts[0],
        targetColumn: parts[1],
      });
    }

    return fks;
  }

  /**
   * Extract relationship() calls from the class body.
   *
   * Patterns:
   *   items: Mapped[List["Item"]] = relationship(back_populates="order")
   *   items = relationship('Item', back_populates='order')
   *   items = relationship('Item', backref='order')
   */
  private extractRelationships(
    body: any,
    source: string,
    modelName: string,
  ): Array<{
    attributeName: string;
    targetModel: string;
    backPopulates: string | null;
    backRef: string | null;
    uselist: boolean | null;
    line: number;
  }> {
    const rels: Array<{
      attributeName: string;
      targetModel: string;
      backPopulates: string | null;
      backRef: string | null;
      uselist: boolean | null;
      line: number;
    }> = [];

    for (const stmt of body.children ?? []) {
      if (stmt.type !== 'expression_statement') continue;

      const assignment = stmt.children.find((c: any) => c.type === 'assignment');
      if (!assignment) continue;

      const left = assignment.childForFieldName('left');
      const right = assignment.childForFieldName('right');
      if (!left || !right || right.type !== 'call') continue;

      const funcRef = right.childForFieldName('function');
      if (!funcRef) continue;
      if (funcRef.text !== 'relationship') continue;

      const attrName = left.text;
      const args = right.childForFieldName('arguments');
      if (!args) continue;

      // First arg is the target model name (string)
      const targetModel =
        this.extractFirstStringArg(args) ?? this.getFirstArgText(args) ?? 'Unknown';

      const backPopulates = this.extractKeywordArg(args, 'back_populates');
      const backRef = this.extractKeywordArg(args, 'backref');
      const uselistStr = this.extractKeywordArg(args, 'uselist');
      const uselist = uselistStr === 'False' ? false : uselistStr === 'True' ? true : null;

      rels.push({
        attributeName: attrName,
        targetModel: targetModel.replace(/['"]/g, ''),
        backPopulates,
        backRef,
        uselist,
        line: stmt.startPosition.row + 1,
      });
    }

    return rels;
  }

  /**
   * Walk up from a ForeignKey() call to find the parent column assignment name.
   */
  private findParentColumnName(fkCall: any, body: any): string | null {
    // Search through body statements to find which assignment contains this FK call
    for (const stmt of body.children ?? []) {
      if (stmt.type !== 'expression_statement') continue;
      const assignment = stmt.children.find((c: any) => c.type === 'assignment');
      if (!assignment) continue;

      // Check if this assignment's right-hand side contains the FK call
      const right = assignment.childForFieldName('right');
      if (!right) continue;

      if (this.nodeContains(right, fkCall)) {
        const left = assignment.childForFieldName('left');
        return left?.text ?? null;
      }
    }
    return null;
  }

  /** Check if a node contains a specific descendant (by identity). */
  private nodeContains(parent: any, target: any): boolean {
    if (parent.id === target.id) return true;
    for (const child of parent.children ?? []) {
      if (this.nodeContains(child, target)) return true;
    }
    return false;
  }

  // ─── Tree-sitter helpers ───────────────────────────────────────────

  private findAllByType(node: any, type: string): any[] {
    const results: any[] = [];
    if (node.type === type) results.push(node);
    for (const child of node.children ?? []) {
      results.push(...this.findAllByType(child, type));
    }
    return results;
  }

  private extractFirstStringArg(args: any): string | null {
    for (const child of args.children ?? []) {
      if (child.type === 'string') {
        return this.unquote(child.text);
      }
      if (child.type === 'concatenated_string') {
        return this.unquote(child.children[0]?.text ?? '');
      }
    }
    return null;
  }

  private getFirstArgText(args: any): string | null {
    for (const child of args.children ?? []) {
      if (
        child.type === 'keyword_argument' ||
        child.type === '(' ||
        child.type === ')' ||
        child.type === ','
      )
        continue;
      return child.text;
    }
    return null;
  }

  private extractKeywordArg(args: any, name: string): string | null {
    for (const child of args.children ?? []) {
      if (child.type !== 'keyword_argument') continue;
      const key = child.childForFieldName('name')?.text;
      if (key !== name) continue;
      const value = child.childForFieldName('value');
      if (!value) continue;
      if (value.type === 'string') return this.unquote(value.text);
      return value.text;
    }
    return null;
  }

  private unquote(s: string): string {
    let text = s;
    text = text.replace(/^[fFbBrRuU]+/, '');
    if (text.startsWith('"""') || text.startsWith("'''")) {
      return text.slice(3, -3);
    }
    if (text.startsWith('"') || text.startsWith("'")) {
      return text.slice(1, -1);
    }
    return text;
  }
}
