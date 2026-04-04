import type { LanguagePlugin } from '../../../plugin-api/types.js';
import { PhpLanguagePlugin } from './php/index.js';
import { TypeScriptLanguagePlugin } from './typescript/index.js';
import { VueLanguagePlugin } from './vue/index.js';
import { PythonLanguagePlugin } from './python/index.js';
import { JavaLanguagePlugin } from './java/index.js';
import { KotlinLanguagePlugin } from './kotlin/index.js';
import { RubyLanguagePlugin } from './ruby/index.js';
import { GoLanguagePlugin } from './go/index.js';
import { PrismaLanguagePlugin } from '../integration/prisma/index.js';
import { GraphQLLanguagePlugin } from '../integration/graphql/index.js';

export function createAllLanguagePlugins(): LanguagePlugin[] {
  return [
    new PhpLanguagePlugin(),
    new TypeScriptLanguagePlugin(),
    new VueLanguagePlugin(),
    new PythonLanguagePlugin(),
    new JavaLanguagePlugin(),
    new KotlinLanguagePlugin(),
    new RubyLanguagePlugin(),
    new GoLanguagePlugin(),
    new PrismaLanguagePlugin(),
    new GraphQLLanguagePlugin(),
  ];
}
