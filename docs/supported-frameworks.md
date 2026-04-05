# Supported frameworks & languages

## Languages (68)

### Tree-sitter (full AST parsing)

| Language | What's extracted |
|---|---|
| **PHP** | Classes, interfaces, traits, enums, functions, methods, properties, constants, namespaces |
| **TypeScript / JavaScript** | Functions, classes, variables, types, interfaces, enums, exports, JSX/TSX |
| **Python** | Functions, classes, decorators, attributes, module variables |
| **Go** | Functions, methods, types (structs, interfaces), constants, variables, packages |
| **Java** | Classes, interfaces, enums, annotation types, methods, fields |
| **Kotlin** | Classes, functions, properties |
| **Ruby** | Classes, modules, methods, constants |
| **Rust** | Functions, structs, enums, traits, impl blocks, macros, constants, modules |
| **C** | Functions, structs, enums, unions, typedefs, macros, global variables |
| **C++** | Classes, structs, namespaces, enums, functions, methods, templates, type aliases |
| **C#** | Namespaces, classes, interfaces, structs, enums, records, delegates, methods, properties |
| **Scala** | Classes, objects, traits, enums, case classes, methods, vals, type aliases, given instances |
| **Vue SFC** | Components, script setup symbols, template analysis |
| **HTML** | Script/link references, meta tags, form elements, custom elements |

### Regex-based (symbol extraction)

| Language | What's extracted |
|---|---|
| **CSS / SCSS / SASS / LESS** | Custom properties, classes, IDs, mixins, keyframes, font-face |
| **Swift** | Classes, structs, enums, protocols, functions, properties, typealiases |
| **Dart** | Classes, mixins, enums, functions, getters/setters, factory constructors |
| **Objective-C** | Classes, protocols, methods (full selectors), properties, C functions |
| **Elixir** | Modules, functions, macros, guards, type specs, callbacks |
| **Erlang** | Modules, exported functions, records, macros, type specs |
| **Haskell** | Modules, data types, type classes, type signatures, instances |
| **Gleam** | Functions, types, constants |
| **Scala** | Packages, case classes, objects, traits, enums, defs, vals |
| **Groovy** | Classes, interfaces, enums, traits, methods |
| **Bash** | Functions, readonly/exported constants |
| **Lua** | Functions, module methods, local variables |
| **Perl** | Subroutines, packages |
| **GDScript** | Functions, classes, enums, signals, constants, variables |
| **R** | Functions, S4 classes/generics/methods |
| **Julia** | Functions, structs, modules, macros, constants |
| **Nix** | Attribute bindings, function definitions |
| **SQL** | Tables, views, functions, procedures, triggers, CTEs, schemas, types |
| **HCL / Terraform** | Resources, data sources, modules, variables, outputs, providers |
| **Protocol Buffers** | Messages, enums, services, RPCs |
| **XML / XUL / XSD** | Root element, id/name attributes, namespaces, XSD types, XSLT templates |
| **YAML** | Top-level keys |
| **JSON** | First-level keys |
| **TOML** | Tables, array-of-tables, key-value bindings |
| **Assembly** | Labels, procedures, macros, equates, sections, directives |
| **Fortran** | Subroutines, functions, modules, programs, types |
| **AutoHotkey** | Functions, classes, static methods |
| **Verse (UEFN)** | Classes, methods, properties, variables |
| **AL (Business Central)** | Tables, pages, codeunits, enums, procedures, triggers |
| **Blade (Laravel)** | Sections, components, slots, includes, extends |
| **EJS** | Functions, constants (from scriptlet blocks) |
| **Zig** | Functions, structs, enums, unions, constants, variables, test declarations |
| **OCaml** | Let/val bindings, type definitions, modules, classes, exceptions |
| **Clojure** | defn, def, defmacro, defprotocol, defrecord, deftype, ns declarations |
| **F#** | Let bindings, members, type definitions, modules, exceptions |
| **Elm** | Functions, type aliases, custom types, ports, modules |
| **CUDA** | Kernels (__global__), device/host functions, structs, __constant__/__shared__ vars |
| **COBOL** | PROGRAM-ID, divisions, sections, paragraphs, data items (01–77 levels), conditions (88) |
| **Verilog / SystemVerilog** | Modules, interfaces, packages, classes, functions, tasks, parameters |
| **GLSL** | Functions, structs, uniforms, varyings, layout qualifiers, constants |
| **Meson** | Projects, executables, libraries, dependencies, custom targets, subdirs |
| **Vim Script** | Functions, commands, variables (g:/s:/b:), augroups |
| **Common Lisp** | defun, defmacro, defclass, defstruct, defpackage, defvar, defconstant |
| **Emacs Lisp** | defun, defmacro, defvar, defcustom, defconst, define-*-mode, defgroup |
| **Dockerfile** | FROM stages, ARG/ENV declarations, EXPOSE ports, ENTRYPOINT/CMD |
| **Makefile** | Targets, variable definitions, define blocks, .PHONY |
| **CMake** | Functions, macros, projects, add_executable/add_library, options |
| **INI / Config** | Sections, key-value pairs (.ini, .cfg, .conf, .properties, .editorconfig) |
| **Svelte** | Props (export let / $props), reactive declarations, runes ($state/$derived), snippets |
| **Markdown** | Headings (h1–h4), link definitions, code block languages |
| **MATLAB / Octave** | Functions, classdef, properties blocks, global/persistent variables |
| **Lean 4** | def, theorem, lemma, structure, class, inductive, abbrev, namespace |
| **FORM** | Symbols, indices, vectors, functions, tables, procedures, modules |
| **Magma** | Functions, procedures, intrinsics, types, records |
| **Wolfram / Mathematica** | Function definitions (SetDelayed), packages, usage strings, options |

---

## Backend frameworks

| Framework | What's extracted |
|---|---|
| **Laravel** | Routes, controllers, Eloquent relations, migrations, FormRequests, events/listeners, middleware, broadcasting |
| **Laravel Livewire** | Components, properties, actions, events, views, child components |
| **Laravel Nova** | Resources, fields, actions, filters, lenses, metrics |
| **Filament** | Resources, relation managers, panels, widgets |
| **Spatie Laravel Data** | Data objects, transformations |
| **Laravel Pennant** | Feature flag definitions |
| **Django** | Models, URL patterns, views (CBV + FBV), admin registrations, signals, forms |
| **Django REST Framework** | Serializers, ViewSets, API endpoints |
| **FastAPI** | Route definitions, path/query parameters, request models |
| **Flask** | Routes, blueprints, request handlers |
| **Express** | Routes, middleware, error handlers, param handlers |
| **NestJS** | Controllers, modules, services, decorators, DI tree |
| **Fastify** | Routes, hooks, plugins |
| **Hono** | Routes, middleware |
| **Next.js** | API routes, pages, `getServerSideProps`, `getStaticProps` |
| **Rails** | Routes, controllers, models, migrations, associations |
| **Spring** | Beans, controllers, services, JPA entities |
| **tRPC** | Routers, procedures, type definitions |

---

## Frontend frameworks

| Framework | What's extracted |
|---|---|
| **Vue** | Components (Options + Composition API), `defineProps`, `defineEmits`, composables, render trees |
| **Nuxt** | File-based routing, auto-imports, `useFetch` / `useAsyncData`, server API routes, layouts, middleware |
| **React** | Components (functional + class), hooks, props |
| **React Native** | Native components, navigation patterns, screens, deep links, platform variants |
| **Blade** | `@extends`, `@include`, `@component`, `<x-*>` directives, template inheritance |
| **Inertia.js** | `Inertia::render()` calls, controller ↔ Vue page mapping, prop extraction & validation |

---

## UI component libraries

| Library | What's extracted |
|---|---|
| **shadcn/ui** | Component registry, CVA/TV variant definitions, Radix primitive composition, sub-component exports |
| **Nuxt UI** | Theme overrides from `app.config.ts`, UForm schemas, Tailwind Variants (`tv()`) definitions, color mode |
| **Material-UI** | Component usage, theme customization |
| **Ant Design** | Component usage patterns |
| **Headless UI** | Unstyled component composition |

---

## Data & ORM

| Library | What's extracted |
|---|---|
| **Eloquent** (Laravel) | Models, relationships, scopes, casts, schema from migrations |
| **Prisma** | Data models from `schema.prisma`, relations |
| **TypeORM** | Entities, relations, repositories |
| **Drizzle** | Schema definitions, table relations |
| **Sequelize** | Models, associations, migrations |
| **Mongoose** | Schemas, models, middleware |
| **SQLAlchemy** | ORM models, relationships, columns, constraints |

---

## Validation & schema

| Library | What's extracted |
|---|---|
| **Zod** | Schema definitions, type inference |
| **Pydantic** | BaseModel subclasses, field types, ORM mode references |

---

## API & realtime

| Library | What's extracted |
|---|---|
| **GraphQL** | Schemas, resolvers, type definitions |
| **Socket.io** | Event handlers, namespaces, rooms |

---

## State management

| Library | What's extracted |
|---|---|
| **Zustand** | Store definitions, actions, selectors |

---

## Tooling & automation

| Plugin | What's extracted |
|---|---|
| **Celery** | Task definitions, routing, schedules |
| **n8n** | Workflow nodes, connections, parameters, credentials |
| **Data fetching** | React Query, SWR — query hooks, mutations, cache config |
| **Testing** | Playwright, Cypress, Jest, Vitest, Mocha — test suites, fixtures |
