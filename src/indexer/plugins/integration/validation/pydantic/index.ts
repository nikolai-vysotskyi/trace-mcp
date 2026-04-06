/**
 * PydanticPlugin — Pydantic model plugin.
 *
 * Detects 'pydantic' in Python dependencies and extracts:
 * - BaseModel field → referenced type edges (pydantic_field_type)
 * - Model with from_attributes/orm_mode → ORM model hint (pydantic_from_orm)
 *
 * Supports Pydantic v1 (Config class with orm_mode) and v2 (model_config with
 * from_attributes).
 *
 * Uses tree-sitter-python for AST-based extraction.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok, err } from 'neverthrow';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  RawRoute,
  ResolveContext,
  EdgeTypeDeclaration,
} from '../../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../../errors.js';
import { parseError } from '../../../../../errors.js';
import { escapeRegExp } from '../../../../../utils/security.js';
import { getParser, type TSNode } from '../../../../../parser/tree-sitter.js';

// ============================================================
// Python dependency detection
// ============================================================

function hasPythonDep(rootPath: string, depName: string): boolean {
  for (const reqFile of ['requirements.txt', 'requirements/base.txt', 'requirements/prod.txt']) {
    try {
      const content = fs.readFileSync(path.join(rootPath, reqFile), 'utf-8');
      if (new RegExp(`^${escapeRegExp(depName)}\\b`, 'm').test(content)) return true;
    } catch { /* not found */ }
  }

  try {
    const content = fs.readFileSync(path.join(rootPath, 'pyproject.toml'), 'utf-8');
    if (content.includes(depName)) return true;
  } catch { /* not found */ }

  for (const f of ['setup.py', 'setup.cfg']) {
    try {
      const content = fs.readFileSync(path.join(rootPath, f), 'utf-8');
      if (content.includes(depName)) return true;
    } catch { /* not found */ }
  }

  try {
    const content = fs.readFileSync(path.join(rootPath, 'Pipfile'), 'utf-8');
    if (content.includes(depName)) return true;
  } catch { /* not found */ }

  return false;
}

// ============================================================
// AST helpers
// ============================================================

/** Find all top-level class definitions (including decorated ones). */
function findClassDefinitions(root: TSNode): TSNode[] {
  const classes: TSNode[] = [];
  for (const child of root.namedChildren) {
    if (child.type === 'class_definition') {
      classes.push(child);
    } else if (child.type === 'decorated_definition') {
      const inner = child.namedChildren.find(c => c.type === 'class_definition');
      if (inner) classes.push(inner);
    }
  }
  return classes;
}

/** Get superclass names from a class_definition node. */
function getSuperclasses(classDef: TSNode): string[] {
  const argList = classDef.childForFieldName('superclasses');
  if (!argList) return [];
  const names: string[] = [];
  for (const child of argList.namedChildren) {
    if (child.type === 'identifier') {
      names.push(child.text);
    } else if (child.type === 'attribute') {
      names.push(child.text);
    }
  }
  return names;
}

function getClassName(classDef: TSNode): string {
  return classDef.childForFieldName('name')?.text ?? '';
}

function getClassBody(classDef: TSNode): TSNode | null {
  return classDef.childForFieldName('body');
}

/** Find an assignment in a block by target name. Returns the RHS node. */
function findAssignment(body: TSNode, targetName: string): TSNode | null {
  for (const child of body.namedChildren) {
    if (child.type === 'expression_statement') {
      const expr = child.namedChildren[0];
      if (expr?.type === 'assignment') {
        const left = expr.childForFieldName('left');
        if (left?.type === 'identifier' && left.text === targetName) {
          return expr.childForFieldName('right');
        }
      }
    }
  }
  return null;
}

/** Find a nested class (like Config) inside a class body. */
function findNestedClass(body: TSNode, name: string): TSNode | null {
  for (const child of body.namedChildren) {
    if (child.type === 'class_definition') {
      const n = child.childForFieldName('name');
      if (n?.text === name) return child;
    }
  }
  return null;
}

function shortName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1) : name;
}

// ============================================================
// Builtin type set (skip these for field_type edges)
// ============================================================

const PYTHON_BUILTINS = new Set([
  'str', 'int', 'float', 'bool', 'bytes', 'None', 'NoneType',
  'dict', 'list', 'tuple', 'set', 'frozenset',
  'Any', 'Optional', 'Union', 'Literal', 'ClassVar',
  'List', 'Dict', 'Set', 'Tuple', 'FrozenSet', 'Sequence',
  'Mapping', 'Iterable', 'Iterator', 'Callable', 'Type',
  'Annotated', 'Final',
  'datetime', 'date', 'time', 'timedelta', 'Decimal', 'UUID',
  'EmailStr', 'HttpUrl', 'AnyUrl', 'AnyHttpUrl',
  'constr', 'conint', 'confloat', 'conbytes', 'condecimal',
  'PositiveInt', 'NegativeInt', 'PositiveFloat', 'NegativeFloat',
  'StrictStr', 'StrictInt', 'StrictFloat', 'StrictBool',
  'SecretStr', 'SecretBytes', 'FilePath', 'DirectoryPath',
  'Json', 'PaymentCardNumber', 'IPvAnyAddress',
]);

// ============================================================
// Pydantic model extraction
// ============================================================

const PYDANTIC_BASES = new Set([
  'BaseModel', 'pydantic.BaseModel',
  'BaseSettings', 'pydantic.BaseSettings',
  'GenericModel', 'pydantic.generics.GenericModel',
]);

interface PydanticFieldRef {
  fieldName: string;
  typeName: string;
  line: number;
}

interface PydanticModelInfo {
  className: string;
  fields: PydanticFieldRef[];
  hasFromAttributes: boolean;
  line: number;
}

/**
 * Extract type references from a type annotation node.
 * Handles: bare identifiers, subscripts like list[Item], Optional[Item], Union[A, B].
 */
function extractTypeRefs(typeNode: TSNode): string[] {
  const refs: string[] = [];

  if (typeNode.type === 'identifier') {
    const name = typeNode.text;
    if (!PYTHON_BUILTINS.has(name)) {
      refs.push(name);
    }
    return refs;
  }

  if (typeNode.type === 'attribute') {
    const name = shortName(typeNode.text);
    if (!PYTHON_BUILTINS.has(name)) {
      refs.push(name);
    }
    return refs;
  }

  // list[Item], Optional[Item], dict[str, Item], etc.
  if (typeNode.type === 'subscript') {
    const base = typeNode.childForFieldName('value');
    const subscriptSlices = typeNode.namedChildren.filter(c => c !== base);

    // For wrapper types (Optional, List, etc.), recurse into subscript args
    const baseName = base?.text ?? '';
    if (PYTHON_BUILTINS.has(baseName) || PYTHON_BUILTINS.has(shortName(baseName))) {
      for (const slice of subscriptSlices) {
        refs.push(...extractTypeRefs(slice));
      }
    } else {
      // Custom generic like MyType[X] — the base itself is a type ref
      if (!PYTHON_BUILTINS.has(shortName(baseName))) {
        refs.push(shortName(baseName));
      }
      for (const slice of subscriptSlices) {
        refs.push(...extractTypeRefs(slice));
      }
    }
    return refs;
  }

  // Union via X | Y (binary_operator with |)
  if (typeNode.type === 'binary_operator') {
    const left = typeNode.childForFieldName('left');
    const right = typeNode.childForFieldName('right');
    if (left) refs.push(...extractTypeRefs(left));
    if (right) refs.push(...extractTypeRefs(right));
    return refs;
  }

  // Tuple of types in subscript args
  if (typeNode.type === 'tuple' || typeNode.type === 'expression_list') {
    for (const child of typeNode.namedChildren) {
      refs.push(...extractTypeRefs(child));
    }
    return refs;
  }

  return refs;
}

/**
 * Extract typed fields from a Pydantic BaseModel class body.
 * Looks for: `field_name: SomeType` or `field_name: SomeType = default`
 */
function extractFieldAnnotations(body: TSNode): PydanticFieldRef[] {
  const fields: PydanticFieldRef[] = [];

  for (const child of body.namedChildren) {
    // type annotation: `name: Type`
    if (child.type === 'expression_statement') {
      const inner = child.namedChildren[0];
      if (!inner) continue;

      // `name: Type` (bare annotation)
      if (inner.type === 'type') {
        // tree-sitter-python wraps annotations in 'type' node
        // Actually this appears as expression_statement > type > ...
        // Let's handle the children
        continue;
      }

      // `name: Type = value` (assignment with type annotation)
      if (inner.type === 'assignment') {
        const left = inner.childForFieldName('left');
        const typeNode = inner.childForFieldName('type');
        if (left?.type === 'identifier' && typeNode) {
          const refs = extractTypeRefs(typeNode);
          for (const ref of refs) {
            fields.push({
              fieldName: left.text,
              typeName: ref,
              line: child.startPosition.row + 1,
            });
          }
        }
      }
    }

    // Annotated assignment without default: `name: Type`
    // tree-sitter-python represents this as `type` node inside `expression_statement`
    // Actually, Python `name: str` is parsed as:
    //   expression_statement > type > identifier (the annotation)
    // But with value: `name: str = "foo"` is:
    //   expression_statement > assignment (left=name, type=str, right="foo")
    //
    // For bare annotation `name: Type`, tree-sitter uses 'type' node:
    if (child.type === 'type') {
      // The 'type' node in tree-sitter-python stores the annotation
      // Its children: identifier (name) and the type annotation
      // Actually tree-sitter-python has 'expression_statement' > 'type' where
      // the 'type' node contains the var name and annotation.
      // Let's handle it more carefully.
      continue;
    }
  }

  // Second pass: handle bare annotations via typed assignments
  // tree-sitter-python 0.25 parses `name: Type` as expression_statement with
  // a single child of type 'type' whose text is `name: Type`.
  // We need to use a different approach for these.
  for (const child of body.namedChildren) {
    if (child.type !== 'expression_statement') continue;
    const inner = child.namedChildren[0];
    if (!inner) continue;

    // tree-sitter-python: bare annotation `name: str` is parsed as
    // expression_statement > type (text = "name: str")
    //   where type has child identifier = "name" and the annotation type child
    if (inner.type === 'type') {
      // The 'type' node has two children: the variable name and the type annotation
      // But actually in tree-sitter-python, `x: int` is parsed as:
      //   expression_statement
      //     type: (type
      //       (identifier) ; the type annotation
      //     )
      // And the variable name is stored elsewhere.
      // Let's use text parsing as a fallback for bare annotations.
      const text = child.text.trim();
      const match = text.match(/^(\w+)\s*:\s*(.+)$/s);
      if (match) {
        const fieldName = match[1];
        const typeStr = match[2].trim();
        // Quick parse: extract non-builtin type names
        const typeNames = typeStr.match(/\b[A-Z]\w+/g) ?? [];
        for (const tn of typeNames) {
          if (!PYTHON_BUILTINS.has(tn)) {
            fields.push({
              fieldName,
              typeName: tn,
              line: child.startPosition.row + 1,
            });
          }
        }
      }
    }
  }

  return fields;
}

/**
 * Check if a Pydantic model has from_attributes=True (v2) or orm_mode=True (v1).
 */
function hasFromAttributes(body: TSNode): boolean {
  // v2: model_config = ConfigDict(from_attributes=True)
  const configAssign = findAssignment(body, 'model_config');
  if (configAssign) {
    // Look for from_attributes=True in the call
    if (/from_attributes\s*=\s*True/.test(configAssign.text)) {
      return true;
    }
  }

  // v1: class Config: orm_mode = True
  const configClass = findNestedClass(body, 'Config');
  if (configClass) {
    const configBody = getClassBody(configClass);
    if (configBody) {
      const ormModeRhs = findAssignment(configBody, 'orm_mode');
      if (ormModeRhs?.text === 'True') {
        return true;
      }
      // Also check from_attributes in v2-style Config class
      const fromAttrRhs = findAssignment(configBody, 'from_attributes');
      if (fromAttrRhs?.text === 'True') {
        return true;
      }
    }
  }

  return false;
}

function extractPydanticModels(root: TSNode): PydanticModelInfo[] {
  const result: PydanticModelInfo[] = [];

  for (const classDef of findClassDefinitions(root)) {
    const supers = getSuperclasses(classDef);
    // Direct Pydantic base check + allow subclassing other models
    const isPydantic = supers.some(s => PYDANTIC_BASES.has(s));
    if (!isPydantic) continue;

    const className = getClassName(classDef);
    const body = getClassBody(classDef);
    if (!body) continue;

    const fields = extractFieldAnnotations(body);
    const fromAttr = hasFromAttributes(body);

    result.push({
      className,
      fields,
      hasFromAttributes: fromAttr,
      line: classDef.startPosition.row + 1,
    });
  }

  return result;
}

// ============================================================
// Plugin class
// ============================================================

export class PydanticPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'pydantic',
    version: '1.0.0',
    priority: 30,
    category: 'validation',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    return hasPythonDep(ctx.rootPath, 'pydantic');
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'pydantic_field_type', category: 'pydantic', description: 'BaseModel field → referenced type' } as EdgeTypeDeclaration,
        { name: 'pydantic_from_orm', category: 'pydantic', description: 'Model with from_attributes → ORM model hint' } as EdgeTypeDeclaration,
      ],
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
      edges: [],
    };

    let tree: { rootNode: TSNode };
    try {
      const parser = await getParser('python');
      tree = parser.parse(source);
    } catch (e) {
      return err(parseError(filePath, `tree-sitter parse failed: ${e}`));
    }

    const root = tree.rootNode;
    const models = extractPydanticModels(root);

    for (const model of models) {
      // Field type references
      for (const field of model.fields) {
        result.edges!.push({
          edgeType: 'pydantic_field_type',
          sourceSymbolId: `${filePath}::${model.className}#class`,
          targetSymbolId: field.typeName, // resolved in pass 2
          metadata: {
            field: field.fieldName,
            line: field.line,
          },
        });
      }

      // ORM mode hint
      if (model.hasFromAttributes) {
        result.edges!.push({
          edgeType: 'pydantic_from_orm',
          sourceSymbolId: `${filePath}::${model.className}#class`,
          targetSymbolId: model.className, // placeholder — actual ORM model resolution in pass 2
          metadata: {
            hint: 'from_attributes',
            line: model.line,
          },
        });
      }

      result.frameworkRole = 'pydantic_model';
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}
