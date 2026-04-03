/**
 * ES Module Resolver — uses oxc-resolver to resolve import specifiers
 * following Node.js / TypeScript resolution rules.
 */
import path from 'node:path';
import { ResolverFactory } from 'oxc-resolver';
import type { NapiResolveOptions, TsconfigOptions } from 'oxc-resolver';

export class EsModuleResolver {
  private resolver: ResolverFactory;

  constructor(rootPath: string, tsconfigPath?: string) {
    const options: NapiResolveOptions = {
      conditionNames: ['import', 'require', 'node', 'default'],
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'],
      mainFields: ['module', 'main'],
    };

    if (tsconfigPath) {
      const tsconfig: TsconfigOptions = { configFile: tsconfigPath };
      options.tsconfig = tsconfig;
    }

    this.resolver = new ResolverFactory(options);
  }

  /** Resolve a specifier from a given source file. Returns the absolute path or undefined. */
  resolve(specifier: string, fromFile: string): string | undefined {
    const result = this.resolver.sync(path.dirname(fromFile), specifier);
    return result.path ?? undefined;
  }
}
