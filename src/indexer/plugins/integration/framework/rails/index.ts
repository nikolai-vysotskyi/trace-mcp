/**
 * Rails Framework Plugin — routes, ActiveRecord models, controllers, migrations.
 */
import { ok } from 'neverthrow';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
} from '../../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../../errors.js';

export class RailsPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'rails',
    version: '1.0.0',
    priority: 50,
    category: 'framework',
  };

  detect(ctx: ProjectContext): boolean {
    return ctx.configFiles.some(
      (f) => f === 'Gemfile' || f === 'config/routes.rb' || f === 'config/application.rb',
    );
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'rails_route', category: 'http', description: 'Rails route mapping' },
        { name: 'rails_has_many', category: 'orm', description: 'ActiveRecord has_many' },
        { name: 'rails_belongs_to', category: 'orm', description: 'ActiveRecord belongs_to' },
        { name: 'rails_has_one', category: 'orm', description: 'ActiveRecord has_one' },
        {
          name: 'rails_habtm',
          category: 'orm',
          description: 'ActiveRecord has_and_belongs_to_many',
        },
        {
          name: 'rails_before_action',
          category: 'middleware',
          description: 'Controller before_action callback',
        },
        { name: 'rails_validates', category: 'validation', description: 'Model validation' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (language !== 'ruby') return ok({ status: 'ok', symbols: [] });

    const source = content.toString('utf-8');
    const result: FileParseResult = {
      status: 'ok',
      symbols: [],
      edges: [],
      routes: [],
      migrations: [],
    };

    if (filePath.match(/config\/routes/)) {
      this.extractRoutes(source, result);
    } else if (/< ApplicationRecord\b|< ActiveRecord::Base\b/.test(source)) {
      result.frameworkRole = 'model';
      this.extractModelAssociations(source, result);
      this.extractValidations(source, result);
    } else if (/< ApplicationController\b|< ActionController::Base\b/.test(source)) {
      result.frameworkRole = 'controller';
      this.extractCallbacks(source, result);
    } else if (/< ActiveRecord::Migration\b/.test(source)) {
      result.frameworkRole = 'migration';
      this.extractMigrations(source, filePath, result);
    } else {
      return ok({ status: 'ok', symbols: [] });
    }

    return ok(result);
  }

  private extractRoutes(source: string, result: FileParseResult): void {
    const prefixStack: string[] = [];

    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // namespace :api do
      const nsMatch = line.match(/namespace\s+:(\w+)/);
      if (nsMatch) {
        prefixStack.push(nsMatch[1]);
        continue;
      }

      // scope '/api' do
      const scopeMatch = line.match(/scope\s+['"]([^'"]+)['"]/);
      if (scopeMatch) {
        prefixStack.push(scopeMatch[1].replace(/^\//, ''));
        continue;
      }

      if (/^\s*end\s*$/.test(lines[i]) && prefixStack.length > 0) {
        prefixStack.pop();
        continue;
      }

      const prefix = prefixStack.length > 0 ? '/' + prefixStack.join('/') : '';

      // resources :users
      const resourcesMatch = line.match(/resources?\s+:(\w+)/);
      if (resourcesMatch) {
        const name = resourcesMatch[0].startsWith('resources')
          ? resourcesMatch[1]
          : resourcesMatch[1];
        const isPlural = resourcesMatch[0].startsWith('resources');
        const base = `${prefix}/${name}`;

        if (isPlural) {
          result.routes!.push(
            { method: 'GET', uri: base, line: i + 1 },
            { method: 'GET', uri: `${base}/:id`, line: i + 1 },
            { method: 'POST', uri: base, line: i + 1 },
            { method: 'PUT', uri: `${base}/:id`, line: i + 1 },
            { method: 'PATCH', uri: `${base}/:id`, line: i + 1 },
            { method: 'DELETE', uri: `${base}/:id`, line: i + 1 },
          );
        } else {
          result.routes!.push(
            { method: 'GET', uri: base, line: i + 1 },
            { method: 'POST', uri: base, line: i + 1 },
            { method: 'PUT', uri: base, line: i + 1 },
            { method: 'PATCH', uri: base, line: i + 1 },
            { method: 'DELETE', uri: base, line: i + 1 },
          );
        }
        continue;
      }

      // get '/about', to: 'pages#about'
      const verbMatch = line.match(/(?:get|post|put|patch|delete)\s+['"]([^'"]+)['"]/);
      if (verbMatch) {
        const method = line.match(/^(get|post|put|patch|delete)/i)?.[1]?.toUpperCase() ?? 'GET';
        const uri = prefix + verbMatch[1];
        const toMatch = line.match(/to:\s*['"](\w+)#(\w+)['"]/);
        result.routes!.push({
          method,
          uri,
          line: i + 1,
          ...(toMatch ? { name: `${toMatch[1]}#${toMatch[2]}` } : {}),
        });
        continue;
      }

      // root to: 'home#index'
      const rootMatch = line.match(/root\s+(?:to:\s*)?['"](\w+)#(\w+)['"]/);
      if (rootMatch) {
        result.routes!.push({
          method: 'GET',
          uri: '/',
          line: i + 1,
          name: `${rootMatch[1]}#${rootMatch[2]}`,
        });
      }
    }
  }

  private extractModelAssociations(source: string, result: FileParseResult): void {
    const assocTypes: { pattern: string; edgeType: string }[] = [
      { pattern: 'has_many', edgeType: 'rails_has_many' },
      { pattern: 'belongs_to', edgeType: 'rails_belongs_to' },
      { pattern: 'has_one', edgeType: 'rails_has_one' },
      { pattern: 'has_and_belongs_to_many', edgeType: 'rails_habtm' },
    ];

    for (const { pattern, edgeType } of assocTypes) {
      const re = new RegExp(`${pattern}\\s+:(\\w+)`, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) !== null) {
        result.edges!.push({
          edgeType,
          metadata: { target: m[1] },
        });
      }
    }
  }

  private extractValidations(source: string, result: FileParseResult): void {
    const re = /validates?\s+:(\w+)(?:\s*,\s*(.+?))?$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      result.edges!.push({
        edgeType: 'rails_validates',
        metadata: { field: m[1], rules: m[2]?.trim() },
      });
    }
  }

  private extractCallbacks(source: string, result: FileParseResult): void {
    const callbacks = ['before_action', 'after_action', 'around_action', 'skip_before_action'];
    for (const cb of callbacks) {
      const re = new RegExp(`${cb}\\s+:(\\w+)`, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) !== null) {
        result.edges!.push({
          edgeType: 'rails_before_action',
          metadata: { callback: cb, method: m[1] },
        });
      }
    }
  }

  private extractMigrations(source: string, filePath: string, result: FileParseResult): void {
    // Timestamp from filename: 20230101120000_create_users.rb
    const tsMatch = filePath.match(/(\d{14})_/);
    const timestamp = tsMatch?.[1];

    const createRe = /create_table\s+:(\w+)|create_table\s+['"](\w+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = createRe.exec(source)) !== null) {
      const tableName = m[1] ?? m[2];
      const columns: Record<string, unknown>[] = [];

      // Find column definitions after create_table up to next end
      const afterTable = source.substring(m.index);
      const colRe = /t\.(\w+)\s+:(\w+)/g;
      let cm: RegExpExecArray | null;
      while ((cm = colRe.exec(afterTable)) !== null) {
        if (cm[1] === 'end') break;
        columns.push({ name: cm[2], type: cm[1] });
      }

      result.migrations!.push({
        tableName,
        operation: 'create',
        columns,
        timestamp,
      });
    }

    const addColRe = /add_column\s+:(\w+)\s*,\s*:(\w+)\s*,\s*:(\w+)/g;
    while ((m = addColRe.exec(source)) !== null) {
      result.migrations!.push({
        tableName: m[1],
        operation: 'alter',
        columns: [{ name: m[2], type: m[3] }],
        timestamp,
      });
    }

    const dropRe = /drop_table\s+[:"'](\w+)/g;
    while ((m = dropRe.exec(source)) !== null) {
      result.migrations!.push({ tableName: m[1], operation: 'drop', timestamp });
    }
  }
}
