import type { LanguagePlugin } from '../../../plugin-api/types.js';
import { PhpLanguagePlugin } from './php/index.js';
import { TypeScriptLanguagePlugin } from './typescript/index.js';
import { VueLanguagePlugin } from './vue/index.js';
import { PythonLanguagePlugin } from './python/index.js';
import { JavaLanguagePlugin } from './java/index.js';
import { KotlinLanguagePlugin } from './kotlin/index.js';
import { RubyLanguagePlugin } from './ruby/index.js';
import { GoLanguagePlugin } from './go/index.js';
import { HtmlLanguagePlugin } from './html/index.js';
import { CssLanguagePlugin } from './css/index.js';
import { RustLanguagePlugin } from './rust/index.js';
import { CLanguagePlugin } from './c/index.js';
import { CppLanguagePlugin } from './cpp/index.js';
import { CSharpLanguagePlugin } from './csharp/index.js';
import { SwiftLanguagePlugin } from './swift/index.js';
import { ObjCLanguagePlugin } from './objc/index.js';
import { DartLanguagePlugin } from './dart/index.js';
import { ScalaLanguagePlugin } from './scala/index.js';
import { GroovyLanguagePlugin } from './groovy/index.js';
import { ElixirLanguagePlugin } from './elixir/index.js';
import { ErlangLanguagePlugin } from './erlang/index.js';
import { HaskellLanguagePlugin } from './haskell/index.js';
import { GleamLanguagePlugin } from './gleam/index.js';
import { AssemblyLanguagePlugin } from './assembly/index.js';
import { FortranLanguagePlugin } from './fortran/index.js';
import { AutoHotkeyLanguagePlugin } from './autohotkey/index.js';
import { VerseLanguagePlugin } from './verse/index.js';
import { AlLanguagePlugin } from './al/index.js';
import { BladeLanguagePlugin } from './blade/index.js';
import { EjsLanguagePlugin } from './ejs/index.js';
import { BashLanguagePlugin } from './bash/index.js';
import { LuaLanguagePlugin } from './lua/index.js';
import { PerlLanguagePlugin } from './perl/index.js';
import { GdscriptLanguagePlugin } from './gdscript/index.js';
import { RLanguagePlugin } from './r/index.js';
import { JuliaLanguagePlugin } from './julia/index.js';
import { NixLanguagePlugin } from './nix/index.js';
import { XmlLanguagePlugin } from './xml/index.js';
import { PrismaLanguagePlugin } from '../integration/orm/prisma/index.js';
import { GraphQLLanguagePlugin } from '../integration/api/graphql/index.js';
import { SqlLanguagePlugin } from './sql/index.js';
import { HclLanguagePlugin } from './hcl/index.js';
import { ProtobufLanguagePlugin } from './protobuf/index.js';
import { YamlLanguagePlugin } from './yaml-lang/index.js';
import { JsonLanguagePlugin } from './json-lang/index.js';
import { TomlLanguagePlugin } from './toml/index.js';

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
    new HtmlLanguagePlugin(),
    new CssLanguagePlugin(),
    new RustLanguagePlugin(),
    new CLanguagePlugin(),
    new CppLanguagePlugin(),
    new CSharpLanguagePlugin(),
    new SwiftLanguagePlugin(),
    new ObjCLanguagePlugin(),
    new DartLanguagePlugin(),
    new ScalaLanguagePlugin(),
    new GroovyLanguagePlugin(),
    new ElixirLanguagePlugin(),
    new ErlangLanguagePlugin(),
    new HaskellLanguagePlugin(),
    new GleamLanguagePlugin(),
    new AssemblyLanguagePlugin(),
    new FortranLanguagePlugin(),
    new AutoHotkeyLanguagePlugin(),
    new VerseLanguagePlugin(),
    new AlLanguagePlugin(),
    new BladeLanguagePlugin(),
    new EjsLanguagePlugin(),
    new BashLanguagePlugin(),
    new LuaLanguagePlugin(),
    new PerlLanguagePlugin(),
    new GdscriptLanguagePlugin(),
    new RLanguagePlugin(),
    new JuliaLanguagePlugin(),
    new NixLanguagePlugin(),
    new XmlLanguagePlugin(),
    new PrismaLanguagePlugin(),
    new GraphQLLanguagePlugin(),
    new SqlLanguagePlugin(),
    new HclLanguagePlugin(),
    new ProtobufLanguagePlugin(),
    new YamlLanguagePlugin(),
    new JsonLanguagePlugin(),
    new TomlLanguagePlugin(),
  ];
}
