/**
 * ClassValidatorPlugin — detects class-validator usage and extracts validated DTO
 * classes with their per-property constraint decorators (e.g. @IsString,
 * @IsEmail, @Length, @IsOptional, @ValidateNested).
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok, type TraceMcpResult } from '../../../../../errors.js';
import type {
  FileParseResult,
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';
import { stripJsComments } from '../../_shared/strip-comments.js';

/** Built-in class-validator decorators we want to surface. */
const VALIDATOR_DECORATORS = new Set([
  // Common
  'IsDefined',
  'IsOptional',
  'Equals',
  'NotEquals',
  'IsEmpty',
  'IsNotEmpty',
  'IsIn',
  'IsNotIn',
  // Type checkers
  'IsBoolean',
  'IsDate',
  'IsString',
  'IsNumber',
  'IsInt',
  'IsArray',
  'IsEnum',
  'IsObject',
  // Number
  'Min',
  'Max',
  'IsPositive',
  'IsNegative',
  // String
  'Contains',
  'NotContains',
  'IsAlpha',
  'IsAlphanumeric',
  'IsAscii',
  'IsBase64',
  'IsByteLength',
  'IsCreditCard',
  'IsCurrency',
  'IsEmail',
  'IsFQDN',
  'IsHexColor',
  'IsHexadecimal',
  'IsIP',
  'IsISBN',
  'IsISO8601',
  'IsJSON',
  'IsLowercase',
  'IsMobilePhone',
  'IsMongoId',
  'IsMultibyte',
  'IsNumberString',
  'IsPhoneNumber',
  'IsPostalCode',
  'IsSurrogatePair',
  'IsUrl',
  'IsUUID',
  'IsUppercase',
  'Length',
  'MinLength',
  'MaxLength',
  'Matches',
  // Array
  'ArrayContains',
  'ArrayNotContains',
  'ArrayNotEmpty',
  'ArrayMinSize',
  'ArrayMaxSize',
  'ArrayUnique',
  // Object / nested
  'ValidateNested',
  'ValidateIf',
  'Allow',
  // Custom
  'Validate',
]);

/** A single property of a DTO class with its validation decorators. */
export interface ValidatedField {
  name: string;
  decorators: { name: string; args?: string }[];
  type?: string;
  optional: boolean;
}

/** A DTO class detected to use class-validator decorators. */
export interface ValidatedClass {
  name: string;
  fields: ValidatedField[];
  /** Nested class names referenced via @ValidateNested + Type(() => Foo). */
  nestedTypes: string[];
}

/**
 * Match `class Foo`, with optional `export` and `abstract` modifiers, in any
 * order. Catches: `export class`, `export abstract class`, `abstract class`,
 * `export default class`, and bare `class`.
 */
const CLASS_RE = /(?:^|[^.\w])(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+(\w+)/g;

/**
 * Slice the body of a class declaration starting at position `start` (the
 * index of the `class` keyword). Returns the substring between the matching
 * curly braces, or null if not found.
 */
function extractClassBody(source: string, classStart: number): string | null {
  const open = source.indexOf('{', classStart);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * Walk decorators starting at `start`. Returns list of `@Name(args)` tokens
 * with brace/paren balancing (so `@Matches(/^a$/, { x: 1 })` is captured fully)
 * and the position just after the last decorator + whitespace.
 */
function readDecoratorRun(
  body: string,
  start: number,
): { decorators: { name: string; args?: string }[]; end: number } {
  const decorators: { name: string; args?: string }[] = [];
  let i = start;

  while (i < body.length) {
    // skip whitespace
    while (i < body.length && /\s/.test(body[i])) i++;
    if (body[i] !== '@') break;
    const nameStart = i + 1;
    let j = nameStart;
    while (j < body.length && /[\w$]/.test(body[j])) j++;
    const name = body.slice(nameStart, j);
    if (!name) break;

    // optional args in balanced parens
    let args: string | undefined;
    let k = j;
    while (k < body.length && /\s/.test(body[k])) k++;
    if (body[k] === '(') {
      let depth = 0;
      const argStart = k + 1;
      for (; k < body.length; k++) {
        const ch = body[k];
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) {
            args = body.slice(argStart, k).trim() || undefined;
            k++;
            break;
          }
        } else if (ch === '"' || ch === "'" || ch === '`') {
          // skip string literal
          const quote = ch;
          k++;
          while (k < body.length && body[k] !== quote) {
            if (body[k] === '\\') k++;
            k++;
          }
        }
      }
    }
    decorators.push({ name, args });
    i = k;
  }

  return { decorators, end: i };
}

/**
 * Try to read a property declaration starting at `pos`. Returns name, optional
 * marker, type (if any), and the position past the terminator (`;`, `=`, or
 * end-of-line / brace).
 */
function readPropertyDecl(
  body: string,
  pos: number,
): { name: string; optional: boolean; type?: string; end: number } | null {
  // Skip access modifiers
  let i = pos;
  const modifiers = ['public', 'private', 'protected', 'readonly', 'declare', 'static'];
  // Eat any sequence of modifiers separated by whitespace
  // (e.g. `public readonly`)
  // Use a small loop to be robust to ordering.
  // Stop when we hit an identifier start that isn't a modifier.
  while (true) {
    const rest = body.slice(i);
    let consumed = false;
    for (const mod of modifiers) {
      const re = new RegExp(`^${mod}\\s+`);
      const m = rest.match(re);
      if (m) {
        i += m[0].length;
        consumed = true;
        break;
      }
    }
    if (!consumed) break;
  }

  const idMatch = /^([A-Za-z_$][\w$]*)\s*(\??)/.exec(body.slice(i));
  if (!idMatch) return null;
  const name = idMatch[1];
  const optional = idMatch[2] === '?';
  i += idMatch[0].length;

  let type: string | undefined;
  if (body[i] === ':') {
    // Read the type up to `;`, `=`, or `}`, balancing nested <...> and (...)
    i++;
    while (i < body.length && /\s/.test(body[i])) i++;
    let depthAngle = 0;
    let depthParen = 0;
    let typeStart = i;
    for (; i < body.length; i++) {
      const ch = body[i];
      if (ch === '<') depthAngle++;
      else if (ch === '>' && depthAngle > 0) depthAngle--;
      else if (ch === '(') depthParen++;
      else if (ch === ')' && depthParen > 0) depthParen--;
      else if (
        depthAngle === 0 &&
        depthParen === 0 &&
        (ch === ';' || ch === '=' || ch === '\n' || ch === '}')
      ) {
        break;
      }
    }
    type = body.slice(typeStart, i).trim() || undefined;
  }

  // Reject method declarations: identifier followed by `(` is a method, not a property
  // (the regex above leaves us pointing at `(` if so).
  // Note: arrow methods like `foo = (x) => …` are still valid properties — those
  // hit `=` first and are kept.
  if (
    body[i] === '(' ||
    (type === undefined &&
      body[i] !== ';' &&
      body[i] !== '=' &&
      body[i] !== '\n' &&
      body[i] !== '}')
  ) {
    // Couldn't terminate cleanly — likely a method.
    return null;
  }

  // Advance past terminator
  if (body[i] === ';' || body[i] === '=' || body[i] === '\n') i++;

  return { name, optional, type, end: i };
}

/**
 * Replace every top-level brace-balanced `{...}` block within `body` with an
 * empty string. Used to hide method bodies and nested class declarations so a
 * decorator inside e.g. `bar() { class Inner { @IsEmail() email; } }` does
 * not get attributed to the outer class.
 *
 * Crucially, `{...}` blocks that sit inside a `(...)` arg list are NOT
 * stripped — those are object literals passed to a decorator (e.g.
 * `@Matches(/.../, { message: '...' })`) and we need their surrounding args
 * to remain intact for downstream parsing.
 *
 * String literals are preserved verbatim.
 */
function stripNestedBlocks(body: string): string {
  let out = '';
  let i = 0;
  const n = body.length;
  let parenDepth = 0;
  while (i < n) {
    const ch = body[i];
    // Preserve string literals verbatim
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ch;
      i++;
      while (i < n) {
        const c = body[i];
        out += c;
        i++;
        if (c === '\\' && i < n) {
          out += body[i];
          i++;
          continue;
        }
        if (c === quote) break;
      }
      continue;
    }
    if (ch === '(') {
      parenDepth++;
      out += ch;
      i++;
      continue;
    }
    if (ch === ')') {
      if (parenDepth > 0) parenDepth--;
      out += ch;
      i++;
      continue;
    }
    if (ch === '{' && parenDepth === 0) {
      // Top-level block — skip its entire balanced body so any decorators
      // / property declarations nested inside (method bodies, inner class
      // bodies) are invisible to the outer scan.
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        const c = body[i];
        if (c === '"' || c === "'" || c === '`') {
          const q = c;
          i++;
          while (i < n) {
            const cc = body[i];
            i++;
            if (cc === '\\' && i < n) {
              i++;
              continue;
            }
            if (cc === q) break;
          }
          continue;
        }
        if (c === '{') depth++;
        else if (c === '}') depth--;
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Walk a class body and pair each decorator run with the property declaration
 * that follows it. Works on both multi-line and single-line code.
 */
function extractFieldsFromBody(body: string): ValidatedField[] {
  // Hide method bodies and nested class bodies so their decorators don't get
  // scooped up by the outer scan. Top-level decorators + property declarations
  // never sit inside `{}` so this is safe.
  body = stripNestedBlocks(body);

  const fields: ValidatedField[] = [];
  let i = 0;
  while (i < body.length) {
    // Skip whitespace
    while (i < body.length && /\s/.test(body[i])) i++;
    if (body[i] !== '@') {
      // No decorator here → skip one token / line and continue
      const next = body.indexOf('@', i);
      if (next === -1) break;
      i = next;
      continue;
    }
    const { decorators, end } = readDecoratorRun(body, i);
    i = end;
    while (i < body.length && /\s/.test(body[i])) i++;

    // Filter to known validator decorators
    const validators = decorators.filter((d) => VALIDATOR_DECORATORS.has(d.name));
    if (validators.length === 0) {
      // Non-validator decorator block (e.g. method decorator) — skip what follows
      // up to the next `@` or property terminator.
      continue;
    }

    const prop = readPropertyDecl(body, i);
    if (!prop) {
      // Decorators not followed by a property (e.g. method) — discard.
      continue;
    }
    fields.push({
      name: prop.name,
      optional: prop.optional || validators.some((d) => d.name === 'IsOptional'),
      type: prop.type,
      decorators: validators,
    });
    i = prop.end;
  }
  return fields;
}

/** Extract @Type(() => Foo) targets — used for ValidateNested plumbing. */
function extractNestedTypes(body: string): string[] {
  const re = /@Type\s*\(\s*\(\)\s*=>\s*(\w+)/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out.add(m[1]);
  }
  return [...out];
}

/** Extract validated DTO classes from a TS/JS source string. */
export function extractValidatedClasses(source: string): ValidatedClass[] {
  // Drop JS comments so JSDoc examples like `* @IsString() to validate` don't
  // pollute the decorator scan of a neighbouring class.
  source = stripJsComments(source);

  const result: ValidatedClass[] = [];
  CLASS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLASS_RE.exec(source)) !== null) {
    const className = m[1];
    const body = extractClassBody(source, m.index);
    if (!body) continue;

    const fields = extractFieldsFromBody(body);
    if (fields.length === 0) continue;

    result.push({
      name: className,
      fields,
      nestedTypes: extractNestedTypes(body),
    });
  }
  return result;
}

export class ClassValidatorPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'class-validator',
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
      if ('class-validator' in deps) return true;
    }

    try {
      const pkgPath = path.join(ctx.rootPath, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      return 'class-validator' in deps;
    } catch {
      return false;
    }
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 'class_validator_field',
          category: 'class-validator',
          description:
            'DTO class with class-validator decorators on its fields. Self-loop; metadata.fields[] lists every guarded property and its validators.',
        },
        {
          name: 'class_validator_nested',
          category: 'class-validator',
          description: '@ValidateNested + @Type(() => Other) reference',
        },
      ],
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
    if (
      !/class-validator/.test(source) &&
      !/@(?:Is|Min|Max|Length|Matches|Validate)/.test(source)
    ) {
      return ok({ status: 'ok', symbols: [] });
    }

    const classes = extractValidatedClasses(source);
    if (classes.length === 0) return ok({ status: 'ok', symbols: [] });

    const result: FileParseResult = {
      status: 'ok',
      symbols: [],
      routes: [],
      frameworkRole: 'class_validator_dto',
      metadata: { dtos: classes },
    };

    for (const cls of classes) {
      result.routes!.push({
        method: 'DTO',
        uri: `class-validator:${cls.name}`,
        metadata: {
          fields: cls.fields.map((f) => ({
            name: f.name,
            type: f.type,
            optional: f.optional,
            validators: f.decorators.map((d) => d.name),
          })),
          nestedTypes: cls.nestedTypes,
        },
      });
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];
    const allFiles = ctx.getAllFiles();

    /**
     * Project-wide name → ALL matching class symbol ids. We keep every match so
     * cross-file `@ValidateNested + @Type(() => Foo)` resolves even when the
     * referenced DTO is duplicated. The owner of a parsed class, however, is
     * resolved file-locally so a same-named class in another file never claims
     * the wrong symbol.
     */
    const classesByName = new Map<string, { id: number }[]>();
    for (const file of allFiles) {
      if (file.language !== 'typescript' && file.language !== 'javascript') continue;
      for (const sym of ctx.getSymbolsByFile(file.id)) {
        if (sym.kind !== 'class') continue;
        const list = classesByName.get(sym.name);
        if (list) list.push({ id: sym.id });
        else classesByName.set(sym.name, [{ id: sym.id }]);
      }
    }

    for (const file of allFiles) {
      if (file.language !== 'typescript' && file.language !== 'javascript') continue;
      const source = ctx.readFile(file.path);
      if (!source) continue;
      if (!/class-validator/.test(source) && !/@(?:Is|Min|Max|Length|Validate)/.test(source)) {
        continue;
      }

      const classes = extractValidatedClasses(source);
      if (classes.length === 0) continue;

      // File-local class symbols — used to find the correct owner when classes
      // with the same name exist in multiple files.
      const fileSymbols = ctx.getSymbolsByFile(file.id);
      const ownerByName = new Map<string, { id: number }>();
      for (const sym of fileSymbols) {
        if (sym.kind === 'class') ownerByName.set(sym.name, { id: sym.id });
      }

      for (const cls of classes) {
        const owner = ownerByName.get(cls.name);
        if (!owner) continue;
        for (const nested of cls.nestedTypes) {
          const targets = classesByName.get(nested);
          if (!targets || targets.length === 0) continue;
          for (const target of targets) {
            edges.push({
              sourceNodeType: 'symbol',
              sourceRefId: owner.id,
              targetNodeType: 'symbol',
              targetRefId: target.id,
              edgeType: 'class_validator_nested',
              resolution: 'ast_inferred',
              metadata: {
                via: 'ValidateNested+Type',
                ambiguous: targets.length > 1 ? targets.length : undefined,
              },
            });
          }
        }
        // Aggregate ALL fields into ONE self-loop per class. The edges table
        // has UNIQUE(source_node_id, target_node_id, edge_type_id), so per-field
        // self-loops would all collapse into a single row and silently lose
        // most fields. Storing fields[] in metadata keeps everything visible.
        if (cls.fields.length > 0) {
          edges.push({
            sourceNodeType: 'symbol',
            sourceRefId: owner.id,
            targetNodeType: 'symbol',
            targetRefId: owner.id,
            edgeType: 'class_validator_field',
            resolution: 'ast_inferred',
            metadata: {
              fields: cls.fields.map((f) => ({
                name: f.name,
                optional: f.optional,
                type: f.type,
                validators: f.decorators.map((d) => d.name),
              })),
            },
          });
        }
      }
    }

    return ok(edges);
  }
}
