/**
 * Spring Boot Framework Plugin — extracts routes, DI, JPA entities.
 */
import { ok } from 'neverthrow';
import type { TraceMcpResult } from '../../../../../errors.js';
import type {
  FileParseResult,
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
} from '../../../../../plugin-api/types.js';

export class SpringPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'spring',
    version: '1.0.0',
    priority: 50,
    category: 'framework',
  };

  detect(ctx: ProjectContext): boolean {
    const hasSpringFiles = ctx.configFiles.some((f) =>
      /pom\.xml|build\.gradle(\.kts)?|application\.(properties|ya?ml)/.test(f),
    );
    return hasSpringFiles;
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'spring_route', category: 'http', description: 'Spring MVC/REST route mapping' },
        { name: 'spring_injects', category: 'di', description: 'Spring dependency injection' },
        { name: 'spring_entity_relation', category: 'orm', description: 'JPA entity relationship' },
        {
          name: 'spring_component_scan',
          category: 'framework',
          description: 'Component scan scope',
        },
        { name: 'spring_config_value', category: 'config', description: '@Value injection' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (language !== 'java' && language !== 'kotlin') return ok({ status: 'ok', symbols: [] });

    const source = content.toString('utf-8');
    const result: FileParseResult = { status: 'ok', symbols: [], edges: [], routes: [] };

    if (/@(?:RestController|Controller)\b/.test(source)) {
      result.frameworkRole = 'controller';
      this.extractRoutes(source, filePath, result);
      this.extractInjections(source, filePath, result);
    } else if (/@Entity\b/.test(source)) {
      result.frameworkRole = 'entity';
      this.extractEntityRelations(source, filePath, result);
    } else if (/@Service\b/.test(source)) {
      result.frameworkRole = 'service';
      this.extractInjections(source, filePath, result);
    } else if (/@Repository\b/.test(source)) {
      result.frameworkRole = 'repository';
      this.extractInjections(source, filePath, result);
    } else if (/@Component\b/.test(source)) {
      result.frameworkRole = 'component';
      this.extractInjections(source, filePath, result);
    } else if (/@Configuration\b/.test(source)) {
      result.frameworkRole = 'configuration';
      this.extractInjections(source, filePath, result);
    } else {
      return ok({ status: 'ok', symbols: [] });
    }

    return ok(result);
  }

  private extractRoutes(source: string, filePath: string, result: FileParseResult): void {
    // Class-level @RequestMapping prefix
    const classMappingMatch = source.match(
      /@RequestMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/,
    );
    const classPrefix = classMappingMatch?.[1] ?? '';

    const mappings: { annotation: string; method: string }[] = [
      { annotation: 'GetMapping', method: 'GET' },
      { annotation: 'PostMapping', method: 'POST' },
      { annotation: 'PutMapping', method: 'PUT' },
      { annotation: 'DeleteMapping', method: 'DELETE' },
      { annotation: 'PatchMapping', method: 'PATCH' },
    ];

    for (const { annotation, method } of mappings) {
      const re = new RegExp(
        `@${annotation}\\s*(?:\\(\\s*(?:value\\s*=\\s*)?["']([^"']*)["']\\s*\\))?`,
        'g',
      );
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) !== null) {
        const path = m[1] ?? '';
        const uri = normalizePath(`${classPrefix}/${path}`);
        result.routes!.push({ method, uri, line: source.substring(0, m.index).split('\n').length });
      }
    }

    // @RequestMapping with method parameter
    const rmRe =
      /@RequestMapping\s*\([^)]*(?:value\s*=\s*)?["']([^"']+)["'][^)]*method\s*=\s*RequestMethod\.(\w+)/g;
    let rm: RegExpExecArray | null;
    while ((rm = rmRe.exec(source)) !== null) {
      const uri = normalizePath(`${classPrefix}/${rm[1]}`);
      result.routes!.push({
        method: rm[2],
        uri,
        line: source.substring(0, rm.index).split('\n').length,
      });
    }
  }

  private extractInjections(source: string, filePath: string, result: FileParseResult): void {
    // Track owning class so the metadata can carry the source side. Without
    // this, a downstream resolver has no anchor for `this.fieldName.X()` —
    // CRG v2.3.3 Spring DI work depends on this same fact.
    const ownerClass = extractOwningClass(source);

    // ── @Autowired fields ──
    // Build a fieldName → targetType map so we can scan call sites later.
    const fieldTypes = new Map<string, string>();
    const autowiredRe = /@Autowired\s+(?:private\s+|protected\s+|public\s+)?(\w+)\s+(\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = autowiredRe.exec(source)) !== null) {
      const targetType = m[1];
      const fieldName = m[2];
      fieldTypes.set(fieldName, targetType);
      result.edges!.push({
        edgeType: 'spring_injects',
        metadata: {
          targetType,
          fieldName,
          style: 'field',
          ownerClass,
          // Method-level hints — downstream resolver can resolve
          // `this.<fieldName>.<methodHint>` to <targetType>.<methodHint>.
          methodHints: collectInvokedMembers(source, fieldName),
        },
      });
    }

    // ── Constructor injection (Kotlin/Java record style) ──
    const constructorRe = /(?:constructor|public\s+\w+)\s*\(([^)]+)\)/g;
    let cm: RegExpExecArray | null;
    while ((cm = constructorRe.exec(source)) !== null) {
      const params = cm[1].split(',');
      for (const param of params) {
        const parts = param.trim().split(/\s+/);
        if (parts.length >= 2) {
          const typeName = parts[parts.length - 2];
          // Last token is the parameter name — used for `this.<name>.X()` lookup.
          const paramName = parts[parts.length - 1].replace(/[):,]/g, '');
          if (
            typeName[0] === typeName[0].toUpperCase() &&
            typeName !== 'String' &&
            typeName !== 'Integer'
          ) {
            fieldTypes.set(paramName, typeName);
            result.edges!.push({
              edgeType: 'spring_injects',
              metadata: {
                targetType: typeName,
                fieldName: paramName,
                style: 'constructor',
                ownerClass,
                methodHints: collectInvokedMembers(source, paramName),
              },
            });
          }
        }
      }
    }

    // ── @Value ──
    const valueRe = /@Value\s*\(\s*["']([^"']+)["']\s*\)/g;
    let vm: RegExpExecArray | null;
    while ((vm = valueRe.exec(source)) !== null) {
      result.edges!.push({
        edgeType: 'spring_config_value',
        metadata: { expression: vm[1], ownerClass },
      });
    }
  }

  private extractEntityRelations(source: string, filePath: string, result: FileParseResult): void {
    const relations = ['OneToMany', 'ManyToOne', 'OneToOne', 'ManyToMany'];
    for (const rel of relations) {
      const re = new RegExp(
        `@${rel}[^)]*(?:targetEntity\\s*=\\s*(\\w+))?[^)]*\\)\\s*(?:private\\s+|protected\\s+)?(?:[\\w<>]+\\s+)?(\\w+)`,
        'g',
      );
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) !== null) {
        result.edges!.push({
          edgeType: 'spring_entity_relation',
          metadata: { kind: rel, targetEntity: m[1] ?? null, fieldName: m[2] },
        });
      }
    }
  }
}

function normalizePath(path: string): string {
  return `/${path.replace(/\/+/g, '/').replace(/^\/|\/$/g, '')}`;
}

/**
 * Best-effort extraction of the first Spring stereotype class declared in a
 * source file. Java/Kotlin convention is one class per file for stereotypes —
 * if the file declares more than one, the first wins. Returns null if no
 * class line is found (defensive — the regex isn't a parser).
 */
function extractOwningClass(source: string): string | null {
  const m = source.match(
    /(?:^|\n)\s*(?:public\s+|abstract\s+|final\s+|sealed\s+|open\s+)*class\s+(\w+)/,
  );
  return m ? m[1] : null;
}

/**
 * Scan the source for `this.<fieldName>.<member>(...)` and bare
 * `<fieldName>.<member>(...)` invocations and collect the unique member
 * names. Downstream call resolution can use these as candidates to look up
 * on the injected target type. Conservative — caps at 50 hints per field
 * to avoid runaway metadata on generated code.
 */
function collectInvokedMembers(source: string, fieldName: string): string[] {
  const re = new RegExp(`(?:this\\.)?\\b${escapeRegex(fieldName)}\\s*\\.\\s*(\\w+)\\s*\\(`, 'g');
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    seen.add(m[1]);
    if (seen.size >= 50) break;
  }
  return [...seen];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
