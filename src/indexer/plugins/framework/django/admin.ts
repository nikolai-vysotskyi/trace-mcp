/**
 * Django admin extraction from Python source files.
 *
 * Detects:
 * - @admin.register(Model) decorator
 * - @admin.register(Model1, Model2) multi-model registration
 * - admin.site.register(Model, AdminClass)
 * - admin.site.register(Model)
 * - admin.site.register([Model1, Model2], AdminClass)
 *
 * Produces edges of type django_admin_registers.
 */
import type { RawEdge } from '../../../../plugin-api/types.js';

export interface AdminRegistration {
  modelName: string;
  adminClass?: string;
  line: number;
}

/**
 * Extract admin registrations from Django source code.
 * Returns edges of type django_admin_registers.
 */
export function extractAdminRegistrations(
  source: string,
  filePath: string,
): RawEdge[] {
  const edges: RawEdge[] = [];
  const registrations = [
    ...extractDecoratorRegistrations(source),
    ...extractSiteRegistrations(source),
  ];

  for (const reg of registrations) {
    edges.push({
      edgeType: 'django_admin_registers',
      metadata: {
        modelName: reg.modelName,
        adminClass: reg.adminClass,
        filePath,
        line: reg.line,
      },
    });
  }

  return edges;
}

/**
 * Extract @admin.register(Model) decorator patterns.
 *
 * Matches:
 * - @admin.register(User)
 * - @admin.register(User, Group)
 * - @admin.register(User, site=custom_site)
 */
function extractDecoratorRegistrations(source: string): AdminRegistration[] {
  const registrations: AdminRegistration[] = [];
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    const decoratorMatch = line.match(
      /^@admin\.register\s*\(\s*([^)]+)\s*\)/,
    );
    if (!decoratorMatch) continue;

    const argsStr = decoratorMatch[1];

    // Find the admin class on the next non-decorator, non-empty line
    let adminClass: string | undefined;
    for (let j = i + 1; j < lines.length && j < i + 5; j++) {
      const nextLine = lines[j].trim();
      if (!nextLine || nextLine.startsWith('@')) continue;
      const classMatch = nextLine.match(/^class\s+(\w+)/);
      if (classMatch) {
        adminClass = classMatch[1];
      }
      break;
    }

    // Parse model names (strip site=... keyword args)
    const models = argsStr
      .replace(/\bsite\s*=\s*\w+/, '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.includes('='));

    for (const modelName of models) {
      registrations.push({
        modelName,
        adminClass,
        line: i + 1,
      });
    }
  }

  return registrations;
}

/**
 * Extract admin.site.register(Model, AdminClass) patterns.
 *
 * Matches:
 * - admin.site.register(User, UserAdmin)
 * - admin.site.register(User)
 * - admin.site.register([User, Group], UserAdmin)
 */
function extractSiteRegistrations(source: string): AdminRegistration[] {
  const registrations: AdminRegistration[] = [];
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // admin.site.register(Model, AdminClass) or admin.site.register(Model)
    const singleMatch = line.match(
      /admin\.site\.register\s*\(\s*(\w+)(?:\s*,\s*(\w+))?\s*\)/,
    );
    if (singleMatch) {
      registrations.push({
        modelName: singleMatch[1],
        adminClass: singleMatch[2],
        line: i + 1,
      });
      continue;
    }

    // admin.site.register([Model1, Model2], AdminClass)
    const listMatch = line.match(
      /admin\.site\.register\s*\(\s*\[([^\]]+)\](?:\s*,\s*(\w+))?\s*\)/,
    );
    if (listMatch) {
      const models = listMatch[1]
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const adminClass = listMatch[2];

      for (const modelName of models) {
        registrations.push({
          modelName,
          adminClass,
          line: i + 1,
        });
      }
    }
  }

  return registrations;
}
