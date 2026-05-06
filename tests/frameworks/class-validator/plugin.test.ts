import { beforeEach, describe, expect, it } from 'vitest';
import { KNOWN_PACKAGES } from '../../../src/analytics/known-packages.js';
import {
  ClassValidatorPlugin,
  extractValidatedClasses,
} from '../../../src/indexer/plugins/integration/validation/class-validator/index.js';
import type { ProjectContext, ResolveContext } from '../../../src/plugin-api/types.js';

describe('ClassValidatorPlugin', () => {
  let plugin: ClassValidatorPlugin;

  beforeEach(() => {
    plugin = new ClassValidatorPlugin();
  });

  describe('detect()', () => {
    it('returns true when class-validator is in dependencies', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nonexistent',
        packageJson: { dependencies: { 'class-validator': '^0.14.0' } },
        configFiles: [],
        detectedVersions: [],
        allDependencies: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns true when class-validator is in devDependencies', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nonexistent',
        packageJson: { devDependencies: { 'class-validator': '^0.14.0' } },
        configFiles: [],
        detectedVersions: [],
        allDependencies: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns false for unrelated project', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nonexistent-zzz',
        packageJson: { dependencies: { yup: '^1.0.0' } },
        configFiles: [],
        detectedVersions: [],
        allDependencies: [],
      };
      expect(plugin.detect(ctx)).toBe(false);
    });
  });

  describe('registerSchema()', () => {
    it('exposes class_validator_field and class_validator_nested edges', () => {
      const schema = plugin.registerSchema();
      const names = schema.edgeTypes!.map((e) => e.name);
      expect(names).toContain('class_validator_field');
      expect(names).toContain('class_validator_nested');
    });

    it('all edges share class-validator category', () => {
      const schema = plugin.registerSchema();
      for (const e of schema.edgeTypes!) {
        expect(e.category).toBe('class-validator');
      }
    });
  });

  describe('extractValidatedClasses()', () => {
    it('extracts simple decorated DTO', () => {
      const source = `
        import { IsString, IsEmail } from 'class-validator';
        export class CreateUserDto {
          @IsString()
          name: string;

          @IsEmail()
          email: string;
        }
      `;
      const classes = extractValidatedClasses(source);
      expect(classes).toHaveLength(1);
      expect(classes[0].name).toBe('CreateUserDto');
      expect(classes[0].fields.map((f) => f.name)).toEqual(['name', 'email']);
      expect(classes[0].fields[0].decorators[0].name).toBe('IsString');
      expect(classes[0].fields[1].decorators[0].name).toBe('IsEmail');
    });

    it('captures decorator args', () => {
      const source = `
        export class FilterDto {
          @Length(2, 50)
          search: string;

          @Min(1)
          @Max(100)
          page: number;
        }
      `;
      const classes = extractValidatedClasses(source);
      const search = classes[0].fields.find((f) => f.name === 'search')!;
      expect(search.decorators[0]).toEqual({ name: 'Length', args: '2, 50' });
      const page = classes[0].fields.find((f) => f.name === 'page')!;
      expect(page.decorators.map((d) => d.name)).toEqual(['Min', 'Max']);
    });

    it('marks IsOptional and ?-typed fields as optional', () => {
      const source = `
        export class UpdateUserDto {
          @IsOptional()
          @IsString()
          name?: string;
        }
      `;
      const classes = extractValidatedClasses(source);
      expect(classes[0].fields[0].optional).toBe(true);
    });

    it('detects nested types via @Type(() => Foo)', () => {
      const source = `
        export class CreateOrderDto {
          @ValidateNested()
          @Type(() => AddressDto)
          shipping: AddressDto;
        }
      `;
      const classes = extractValidatedClasses(source);
      expect(classes[0].nestedTypes).toContain('AddressDto');
      expect(classes[0].fields[0].decorators.map((d) => d.name)).toContain('ValidateNested');
    });

    it('skips classes without any validator decorators', () => {
      const source = `
        export class PlainClass {
          name: string;
          age: number;
        }
      `;
      const classes = extractValidatedClasses(source);
      expect(classes).toHaveLength(0);
    });

    it('handles abstract classes', () => {
      const source = `
        export abstract class BaseDto {
          @IsString()
          id: string;
        }
      `;
      const classes = extractValidatedClasses(source);
      expect(classes).toHaveLength(1);
      expect(classes[0].name).toBe('BaseDto');
    });

    it('detects non-exported (internal) DTO classes', () => {
      const source = `
        class InternalDto {
          @IsString()
          name: string;
        }
      `;
      const classes = extractValidatedClasses(source);
      expect(classes).toHaveLength(1);
      expect(classes[0].name).toBe('InternalDto');
      expect(classes[0].fields[0].decorators[0].name).toBe('IsString');
    });

    it('parses single-line classes with multiple DTOs on one line', () => {
      const source = `export class A { @IsString() x: string; } export class B { @IsString() y: string; }`;
      const classes = extractValidatedClasses(source);
      expect(classes.map((c) => c.name)).toEqual(['A', 'B']);
      expect(classes[0].fields[0].name).toBe('x');
      expect(classes[1].fields[0].name).toBe('y');
    });

    it('handles export default class', () => {
      const source = `
        export default class ConfigDto {
          @IsString()
          host: string;
        }
      `;
      const classes = extractValidatedClasses(source);
      expect(classes).toHaveLength(1);
      expect(classes[0].name).toBe('ConfigDto');
    });

    it('preserves decorator args containing nested parens and braces', () => {
      const source = `
        export class A {
          @Matches(/^[a-z]+$/, { message: 'must be lowercase' })
          slug: string;
        }
      `;
      const classes = extractValidatedClasses(source);
      const matches = classes[0].fields[0].decorators.find((d) => d.name === 'Matches')!;
      expect(matches.args).toContain('/^[a-z]+$/');
      expect(matches.args).toContain("message: 'must be lowercase'");
    });

    it('does not pick up methods as validated fields', () => {
      const source = `
        export class A {
          @IsString()
          name: string;

          @SomeMethodDecorator()
          getName(): string { return this.name; }
        }
      `;
      const classes = extractValidatedClasses(source);
      expect(classes[0].fields).toHaveLength(1);
      expect(classes[0].fields[0].name).toBe('name');
    });

    it('handles classes with extends/implements clauses', () => {
      const source = `
        export class CreateUserDto extends BaseDto implements IFoo, IBar {
          @IsEmail()
          email: string;
        }
      `;
      const classes = extractValidatedClasses(source);
      expect(classes).toHaveLength(1);
      expect(classes[0].name).toBe('CreateUserDto');
      expect(classes[0].fields[0].decorators[0].name).toBe('IsEmail');
    });

    it('captures union and tuple types', () => {
      const source = `
        export class A {
          @IsString()
          status: 'active' | 'inactive' | null;

          @IsArray()
          point: [number, number];
        }
      `;
      const classes = extractValidatedClasses(source);
      const status = classes[0].fields.find((f) => f.name === 'status')!;
      expect(status.type).toBe("'active' | 'inactive' | null");
      const point = classes[0].fields.find((f) => f.name === 'point')!;
      expect(point.type).toBe('[number, number]');
    });

    it('handles property with initializer (no explicit type)', () => {
      const source = `
        export class A {
          @IsString()
          status = 'active';
        }
      `;
      const classes = extractValidatedClasses(source);
      expect(classes[0].fields[0].name).toBe('status');
      expect(classes[0].fields[0].type).toBeUndefined();
    });

    it('does not absorb decorators from a class declared inside a method body', () => {
      const source = `
        export class Outer {
          @IsString()
          name: string;

          bar() {
            class Inner { @IsEmail() email: string; }
            return Inner;
          }
        }
      `;
      const classes = extractValidatedClasses(source);
      const outer = classes.find((c) => c.name === 'Outer')!;
      // Outer must own only `name`. `email` belongs to Inner and must NOT
      // bleed up into Outer's field list.
      expect(outer.fields.map((f) => f.name)).toEqual(['name']);
      const inner = classes.find((c) => c.name === 'Inner');
      expect(inner?.fields.map((f) => f.name)).toEqual(['email']);
    });

    it('ignores @IsString() that appears inside a JSDoc comment', () => {
      const source = `
        /**
         * Use @IsString() to validate this field.
         * Or @IsEmail() if it is an email.
         */
        export class A {
          @IsEmail()
          email: string;
        }
      `;
      const classes = extractValidatedClasses(source);
      expect(classes).toHaveLength(1);
      expect(classes[0].fields).toHaveLength(1);
      expect(classes[0].fields[0].name).toBe('email');
      expect(classes[0].fields[0].decorators[0].name).toBe('IsEmail');
    });

    it('preserves generic type parameters in field type', () => {
      const source = `
        export class A {
          @IsArray()
          items: Array<ItemDto>;

          @IsObject()
          map: Map<string, string>;
        }
      `;
      const classes = extractValidatedClasses(source);
      const items = classes[0].fields.find((f) => f.name === 'items')!;
      expect(items.type).toBe('Array<ItemDto>');
      const mapField = classes[0].fields.find((f) => f.name === 'map')!;
      expect(mapField.type).toBe('Map<string, string>');
    });
  });

  describe('extractNodes()', () => {
    it('emits DTO route for each validated class', () => {
      const source = `
        import { IsString } from 'class-validator';
        export class CreateUserDto {
          @IsString()
          name: string;
        }
      `;
      const result = plugin.extractNodes('user.dto.ts', Buffer.from(source), 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('class_validator_dto');
      expect(parsed.routes).toHaveLength(1);
      expect(parsed.routes![0].method).toBe('DTO');
      expect(parsed.routes![0].uri).toBe('class-validator:CreateUserDto');
      const meta = parsed.routes![0].metadata as {
        fields: { name: string; validators: string[] }[];
      };
      expect(meta.fields[0].validators).toContain('IsString');
    });

    it('skips files without validator imports or decorators', () => {
      const result = plugin.extractNodes(
        'random.ts',
        Buffer.from('export class Plain { name: string; }'),
        'typescript',
      );
      expect(result._unsafeUnwrap().symbols).toHaveLength(0);
    });

    it('skips non-JS/TS files', () => {
      const result = plugin.extractNodes('a.go', Buffer.from(''), 'go');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().symbols).toHaveLength(0);
    });
  });

  describe('manifest', () => {
    it('has expected name and category', () => {
      expect(plugin.manifest.name).toBe('class-validator');
      expect(plugin.manifest.category).toBe('validation');
    });
  });

  describe('catalog wiring', () => {
    it('class-validator is mapped to the class-validator plugin', () => {
      expect(KNOWN_PACKAGES['class-validator']?.plugin).toBe('class-validator');
    });

    it('class-transformer is mapped to the class-validator plugin (sibling)', () => {
      expect(KNOWN_PACKAGES['class-transformer']?.plugin).toBe('class-validator');
    });

    it('class-validator-jsonschema is mapped to the class-validator plugin', () => {
      expect(KNOWN_PACKAGES['class-validator-jsonschema']?.plugin).toBe('class-validator');
    });
  });

  describe('resolveEdges()', () => {
    it('emits class_validator_nested edge between DTO and nested DTO class', () => {
      const orderSrc = `
        import { ValidateNested } from 'class-validator';
        export class CreateOrderDto {
          @ValidateNested()
          @Type(() => AddressDto)
          shipping: AddressDto;
        }
      `;
      const addressSrc = `
        import { IsString } from 'class-validator';
        export class AddressDto {
          @IsString()
          street: string;
        }
      `;
      const ctx: ResolveContext = {
        rootPath: '/x',
        getAllFiles: () => [
          { id: 1, path: 'order.dto.ts', language: 'typescript' },
          { id: 2, path: 'address.dto.ts', language: 'typescript' },
        ],
        getSymbolsByFile: (id: number) =>
          id === 1
            ? [{ id: 10, symbolId: 's1', name: 'CreateOrderDto', kind: 'class', fqn: null }]
            : [{ id: 20, symbolId: 's2', name: 'AddressDto', kind: 'class', fqn: null }],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 0,
        readFile: (p) =>
          p === 'order.dto.ts' ? orderSrc : p === 'address.dto.ts' ? addressSrc : undefined,
      } as unknown as ResolveContext;

      const edges = plugin.resolveEdges(ctx)._unsafeUnwrap();
      const nested = edges.filter((e) => e.edgeType === 'class_validator_nested');
      expect(nested).toHaveLength(1);
      expect(nested[0].sourceRefId).toBe(10);
      expect(nested[0].targetRefId).toBe(20);
    });

    it('emits ONE aggregated class_validator_field self-loop per class with all fields in metadata', () => {
      // Aggregation matters: edges has UNIQUE(src,tgt,type) so per-field
      // self-loops would collapse and silently lose every field except one.
      const src = `
        export class UserDto {
          @IsEmail()
          email: string;

          @IsString()
          @Length(2, 50)
          name: string;
        }
      `;
      const ctx: ResolveContext = {
        rootPath: '/x',
        getAllFiles: () => [{ id: 1, path: 'u.ts', language: 'typescript' }],
        getSymbolsByFile: () => [
          { id: 11, symbolId: 'u', name: 'UserDto', kind: 'class', fqn: null },
        ],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 0,
        readFile: () => src,
      } as unknown as ResolveContext;

      const edges = plugin.resolveEdges(ctx)._unsafeUnwrap();
      const fieldEdges = edges.filter((e) => e.edgeType === 'class_validator_field');
      expect(fieldEdges).toHaveLength(1);
      const meta = fieldEdges[0].metadata as {
        fields: { name: string; validators: string[] }[];
      };
      expect(meta.fields).toHaveLength(2);
      const byName = Object.fromEntries(meta.fields.map((f) => [f.name, f]));
      expect(byName.email.validators).toContain('IsEmail');
      expect(byName.name.validators).toEqual(['IsString', 'Length']);
    });

    it('resolves owner file-locally when DTO name is duplicated across files', () => {
      // Two files each declare a UserDto. Validator decorators in file 1 must
      // attach to file 1's symbol id, not get hijacked by file 2's symbol.
      const src1 = `
        export class UserDto {
          @IsString()
          name: string;

          @ValidateNested()
          @Type(() => AddressDto)
          addr: AddressDto;
        }
      `;
      const src2 = `
        export class UserDto {
          @IsString()
          x: string;
        }
      `;
      const addrSrc = `
        export class AddressDto {
          @IsString()
          street: string;
        }
      `;
      const ctx: ResolveContext = {
        rootPath: '/x',
        getAllFiles: () => [
          { id: 1, path: 'a.ts', language: 'typescript' },
          { id: 2, path: 'b.ts', language: 'typescript' },
          { id: 3, path: 'addr.ts', language: 'typescript' },
        ],
        getSymbolsByFile: (id: number) =>
          id === 1
            ? [{ id: 10, symbolId: '1', name: 'UserDto', kind: 'class', fqn: null }]
            : id === 2
              ? [{ id: 20, symbolId: '2', name: 'UserDto', kind: 'class', fqn: null }]
              : [{ id: 30, symbolId: '3', name: 'AddressDto', kind: 'class', fqn: null }],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 0,
        readFile: (p: string) => (p === 'a.ts' ? src1 : p === 'b.ts' ? src2 : addrSrc),
      } as unknown as ResolveContext;

      const edges = plugin.resolveEdges(ctx)._unsafeUnwrap();
      // One aggregated field-edge per class: a.ts UserDto (id 10),
      // b.ts UserDto (id 20), addr.ts AddressDto (id 30).
      const fieldEdges = edges.filter((e) => e.edgeType === 'class_validator_field');
      const sources = fieldEdges.map((e) => e.sourceRefId).sort((a, b) => a - b);
      expect(sources).toEqual([10, 20, 30]);
      // Each class's edge contains the right number of fields.
      const byOwner = Object.fromEntries(
        fieldEdges.map((e) => [
          e.sourceRefId,
          (e.metadata as { fields: { name: string }[] }).fields.length,
        ]),
      );
      expect(byOwner[10]).toBe(2); // a.ts UserDto: name + addr
      expect(byOwner[20]).toBe(1); // b.ts UserDto: x
      expect(byOwner[30]).toBe(1); // addr.ts AddressDto: street
      // Nested edge from a.ts UserDto (id 10) → AddressDto (file 3, id 30).
      const nested = edges.filter((e) => e.edgeType === 'class_validator_nested');
      expect(nested).toHaveLength(1);
      expect(nested[0].sourceRefId).toBe(10);
      expect(nested[0].targetRefId).toBe(30);
    });

    it('emits one edge per match when nested DTO name is ambiguous', () => {
      // Two AddressDto classes exist. The single ValidateNested reference must
      // emit one edge per candidate, marked `ambiguous`.
      const src = `
        export class OrderDto {
          @ValidateNested()
          @Type(() => AddressDto)
          addr: AddressDto;
        }
      `;
      const ctx: ResolveContext = {
        rootPath: '/x',
        getAllFiles: () => [
          { id: 1, path: 'order.ts', language: 'typescript' },
          { id: 2, path: 'addr1.ts', language: 'typescript' },
          { id: 3, path: 'addr2.ts', language: 'typescript' },
        ],
        getSymbolsByFile: (id: number) =>
          id === 1
            ? [{ id: 10, symbolId: '1', name: 'OrderDto', kind: 'class', fqn: null }]
            : id === 2
              ? [{ id: 20, symbolId: '2', name: 'AddressDto', kind: 'class', fqn: null }]
              : [{ id: 30, symbolId: '3', name: 'AddressDto', kind: 'class', fqn: null }],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 0,
        readFile: (p: string) =>
          p === 'order.ts' ? src : 'export class AddressDto { @IsString() s: string; }',
      } as unknown as ResolveContext;

      const edges = plugin.resolveEdges(ctx)._unsafeUnwrap();
      const nested = edges.filter((e) => e.edgeType === 'class_validator_nested');
      expect(nested).toHaveLength(2);
      const targetIds = nested.map((e) => e.targetRefId).sort();
      expect(targetIds).toEqual([20, 30]);
      expect((nested[0].metadata as { ambiguous: number }).ambiguous).toBe(2);
    });

    it('does not emit edges when nested DTO is not in the project graph', () => {
      const src = `
        export class CreateOrderDto {
          @ValidateNested()
          @Type(() => MissingDto)
          shipping: MissingDto;
        }
      `;
      const ctx: ResolveContext = {
        rootPath: '/x',
        getAllFiles: () => [{ id: 1, path: 'o.ts', language: 'typescript' }],
        getSymbolsByFile: () => [
          { id: 10, symbolId: 'o', name: 'CreateOrderDto', kind: 'class', fqn: null },
        ],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 0,
        readFile: () => src,
      } as unknown as ResolveContext;

      const edges = plugin.resolveEdges(ctx)._unsafeUnwrap();
      const nested = edges.filter((e) => e.edgeType === 'class_validator_nested');
      expect(nested).toHaveLength(0);
    });
  });
});
