import type { LanguagePlugin } from '../../../plugin-api/types.js';
import { GraphQLLanguagePlugin } from '../integration/api/graphql/index.js';
import { PrismaLanguagePlugin } from '../integration/orm/prisma/index.js';
import { AdaLanguagePlugin } from './ada/index.js';
import { AlLanguagePlugin } from './al/index.js';
import { ApexLanguagePlugin } from './apex/index.js';
import { AssemblyLanguagePlugin } from './assembly/index.js';
import { AutoHotkeyLanguagePlugin } from './autohotkey/index.js';
import { BashLanguagePlugin } from './bash/index.js';
import { BladeLanguagePlugin } from './blade/index.js';
import { CLanguagePlugin } from './c/index.js';
import { ClojureLanguagePlugin } from './clojure/index.js';
import { CMakeLanguagePlugin } from './cmake/index.js';
import { CobolLanguagePlugin } from './cobol/index.js';
import { CommonLispLanguagePlugin } from './common-lisp/index.js';
import { CppLanguagePlugin } from './cpp/index.js';
import { CSharpLanguagePlugin } from './csharp/index.js';
import { CssLanguagePlugin } from './css/index.js';
import { CudaLanguagePlugin } from './cuda/index.js';
import { DartLanguagePlugin } from './dart/index.js';
import { DLanguagePlugin } from './dlang/index.js';
import { DockerfileLanguagePlugin } from './dockerfile/index.js';
import { EjsLanguagePlugin } from './ejs/index.js';
import { ElispLanguagePlugin } from './elisp/index.js';
import { ElixirLanguagePlugin } from './elixir/index.js';
import { ElmLanguagePlugin } from './elm/index.js';
import { ErlangLanguagePlugin } from './erlang/index.js';
import { FormLanguagePlugin } from './form/index.js';
import { FortranLanguagePlugin } from './fortran/index.js';
import { FSharpLanguagePlugin } from './fsharp/index.js';
import { GdscriptLanguagePlugin } from './gdscript/index.js';
import { GleamLanguagePlugin } from './gleam/index.js';
import { GlslLanguagePlugin } from './glsl/index.js';
import { GoLanguagePlugin } from './go/index.js';
import { GroovyLanguagePlugin } from './groovy/index.js';
import { HaskellLanguagePlugin } from './haskell/index.js';
import { HclLanguagePlugin } from './hcl/index.js';
import { HtmlLanguagePlugin } from './html/index.js';
import { IniLanguagePlugin } from './ini/index.js';
import { JavaLanguagePlugin } from './java/index.js';
import { JsonLanguagePlugin } from './json-lang/index.js';
import { JuliaLanguagePlugin } from './julia/index.js';
import { KotlinLanguagePlugin } from './kotlin/index.js';
import { LeanLanguagePlugin } from './lean/index.js';
import { LuaLanguagePlugin } from './lua/index.js';
import { MagmaLanguagePlugin } from './magma/index.js';
import { MakefileLanguagePlugin } from './makefile/index.js';
import { MarkdownLanguagePlugin } from './markdown/index.js';
import { MatlabLanguagePlugin } from './matlab/index.js';
import { MesonLanguagePlugin } from './meson/index.js';
import { NimLanguagePlugin } from './nim/index.js';
import { NixLanguagePlugin } from './nix/index.js';
import { ObjCLanguagePlugin } from './objc/index.js';
import { OcamlLanguagePlugin } from './ocaml/index.js';
import { PascalLanguagePlugin } from './pascal/index.js';
import { PerlLanguagePlugin } from './perl/index.js';
import { PhpLanguagePlugin } from './php/index.js';
import { PlsqlLanguagePlugin } from './plsql/index.js';
import { PowerShellLanguagePlugin } from './powershell/index.js';
import { ProtobufLanguagePlugin } from './protobuf/index.js';
import { PythonLanguagePlugin } from './python/index.js';
import { RLanguagePlugin } from './r/index.js';
import { RubyLanguagePlugin } from './ruby/index.js';
import { RustLanguagePlugin } from './rust/index.js';
import { ScalaLanguagePlugin } from './scala/index.js';
import { SolidityLanguagePlugin } from './solidity/index.js';
import { SqlLanguagePlugin } from './sql/index.js';
import { SvelteLanguagePlugin } from './svelte/index.js';
import { SwiftLanguagePlugin } from './swift/index.js';
import { TclLanguagePlugin } from './tcl/index.js';
import { TomlLanguagePlugin } from './toml/index.js';
import { TypeScriptLanguagePlugin } from './typescript/index.js';
import { VerilogLanguagePlugin } from './verilog/index.js';
import { VerseLanguagePlugin } from './verse/index.js';
import { VimScriptLanguagePlugin } from './vimscript/index.js';
import { VueLanguagePlugin } from './vue/index.js';
import { WolframLanguagePlugin } from './wolfram/index.js';
import { XmlLanguagePlugin } from './xml/index.js';
import { YamlLanguagePlugin } from './yaml-lang/index.js';
import { ZigLanguagePlugin } from './zig/index.js';

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
    new ZigLanguagePlugin(),
    new OcamlLanguagePlugin(),
    new ClojureLanguagePlugin(),
    new FSharpLanguagePlugin(),
    new ElmLanguagePlugin(),
    new CudaLanguagePlugin(),
    new CobolLanguagePlugin(),
    new VerilogLanguagePlugin(),
    new GlslLanguagePlugin(),
    new MesonLanguagePlugin(),
    new VimScriptLanguagePlugin(),
    new CommonLispLanguagePlugin(),
    new ElispLanguagePlugin(),
    new DockerfileLanguagePlugin(),
    new MakefileLanguagePlugin(),
    new CMakeLanguagePlugin(),
    new IniLanguagePlugin(),
    new SvelteLanguagePlugin(),
    new MarkdownLanguagePlugin(),
    new MatlabLanguagePlugin(),
    new LeanLanguagePlugin(),
    new FormLanguagePlugin(),
    new MagmaLanguagePlugin(),
    new WolframLanguagePlugin(),
    new PascalLanguagePlugin(),
    new AdaLanguagePlugin(),
    new SolidityLanguagePlugin(),
    new PowerShellLanguagePlugin(),
    new ApexLanguagePlugin(),
    new PlsqlLanguagePlugin(),
    new NimLanguagePlugin(),
    new TclLanguagePlugin(),
    new DLanguagePlugin(),
  ];
}
