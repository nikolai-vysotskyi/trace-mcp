import { describe, it, expect } from 'vitest';
import {
  GraphQLPlugin,
  GraphQLLanguagePlugin,
} from '../../../src/indexer/plugins/integration/api/graphql/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

describe('GraphQLLanguagePlugin', () => {
  const langPlugin = new GraphQLLanguagePlugin();

  describe('supportedExtensions', () => {
    it('includes .graphql', () => {
      expect(langPlugin.supportedExtensions).toContain('.graphql');
    });

    it('includes .gql', () => {
      expect(langPlugin.supportedExtensions).toContain('.gql');
    });
  });

  describe('extractSymbols', () => {
    it('extracts type symbols from SDL', () => {
      const source = `
type User {
  id: ID!
  name: String
  email: String!
}
`;
      const result = langPlugin.extractSymbols('schema.graphql', Buffer.from(source));
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.language).toBe('graphql');

      const userType = data.symbols.find((s) => s.name === 'User' && s.kind === 'type');
      expect(userType).toBeDefined();
      expect(userType!.signature).toBe('type User');

      // Field symbols
      const idField = data.symbols.find((s) => s.name === 'id' && s.kind === 'method');
      expect(idField).toBeDefined();
      expect(idField!.fqn).toBe('User.id');

      const nameField = data.symbols.find((s) => s.name === 'name' && s.kind === 'method');
      expect(nameField).toBeDefined();

      const emailField = data.symbols.find((s) => s.name === 'email' && s.kind === 'method');
      expect(emailField).toBeDefined();
    });

    it('extracts input type', () => {
      const source = `
input CreateUserInput {
  name: String!
  email: String!
}
`;
      const result = langPlugin.extractSymbols('schema.graphql', Buffer.from(source));
      const data = result._unsafeUnwrap();
      const inputType = data.symbols.find((s) => s.name === 'CreateUserInput' && s.kind === 'type');
      expect(inputType).toBeDefined();
      expect(inputType!.signature).toBe('input CreateUserInput');
    });

    it('extracts enum type', () => {
      const source = `
enum Role {
  ADMIN
  USER
}
`;
      const result = langPlugin.extractSymbols('schema.graphql', Buffer.from(source));
      const data = result._unsafeUnwrap();
      const enumType = data.symbols.find((s) => s.name === 'Role' && s.kind === 'type');
      expect(enumType).toBeDefined();
      expect(enumType!.signature).toBe('enum Role');
    });

    it('extracts interface type', () => {
      const source = `
interface Node {
  id: ID!
}
`;
      const result = langPlugin.extractSymbols('schema.graphql', Buffer.from(source));
      const data = result._unsafeUnwrap();
      const ifaceType = data.symbols.find((s) => s.name === 'Node' && s.kind === 'type');
      expect(ifaceType).toBeDefined();
      expect(ifaceType!.signature).toBe('interface Node');
    });
  });
});

describe('GraphQLPlugin', () => {
  const plugin = new GraphQLPlugin();

  describe('detect()', () => {
    it('returns true with graphql in dependencies', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/fake',
        packageJson: { dependencies: { graphql: '^16.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns true with @apollo/server in dependencies', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/fake',
        packageJson: { dependencies: { '@apollo/server': '^4.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns true with graphql-yoga in dependencies', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/fake',
        packageJson: { dependencies: { 'graphql-yoga': '^4.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns false when no graphql deps present', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/fake',
        packageJson: { dependencies: { express: '^4.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(false);
    });
  });

  describe('registerSchema()', () => {
    it('returns graphql_resolves edge type', () => {
      const schema = plugin.registerSchema();
      const edgeNames = schema.edgeTypes!.map((e) => e.name);
      expect(edgeNames).toContain('graphql_resolves');
    });

    it('returns graphql_references_type edge type', () => {
      const schema = plugin.registerSchema();
      const edgeNames = schema.edgeTypes!.map((e) => e.name);
      expect(edgeNames).toContain('graphql_references_type');
    });

    it('has graphql category', () => {
      const schema = plugin.registerSchema();
      for (const edge of schema.edgeTypes!) {
        expect(edge.category).toBe('graphql');
      }
    });
  });

  describe('manifest', () => {
    it('has correct name', () => {
      expect(plugin.manifest.name).toBe('graphql');
    });
  });
});

describe('GraphQL extractNodes', () => {
  const plugin = new GraphQLPlugin();

  describe('embedded gql template literals', () => {
    const source = `
import { gql } from 'graphql-tag';

const typeDefs = gql\`
  type User {
    id: ID!
    name: String
  }

  type Query {
    users: [User!]!
  }
\`;
`;

    it('extracts SDL symbols from embedded gql tag', () => {
      const result = plugin.extractNodes('typedefs.ts', Buffer.from(source), 'typescript');
      const data = result._unsafeUnwrap();

      const userType = data.symbols.find((s) => s.name === 'User' && s.kind === 'type');
      expect(userType).toBeDefined();

      const queryType = data.symbols.find((s) => s.name === 'Query' && s.kind === 'type');
      expect(queryType).toBeDefined();

      // Field symbols
      const idField = data.symbols.find((s) => s.name === 'id' && s.kind === 'method');
      expect(idField).toBeDefined();
    });

    it('sets frameworkRole', () => {
      const result = plugin.extractNodes('typedefs.ts', Buffer.from(source), 'typescript');
      const data = result._unsafeUnwrap();
      expect(data.frameworkRole).toBe('graphql_resolver');
    });
  });

  describe('resolver extraction', () => {
    const source = `
const resolvers = {
  Query: {
    users: async (parent, args, ctx) => {
      return ctx.db.users.findMany();
    },
    user: async (parent, args, ctx) => {
      return ctx.db.users.findById(args.id);
    },
  },
  Mutation: {
    createUser: async (parent, args, ctx) => {
      return ctx.db.users.create(args.input);
    },
  },
};
`;

    it('extracts resolver function symbols', () => {
      const result = plugin.extractNodes('resolvers.ts', Buffer.from(source), 'typescript');
      const data = result._unsafeUnwrap();

      const usersResolver = data.symbols.find(
        (s) => s.name === 'users' && s.kind === 'function',
      );
      expect(usersResolver).toBeDefined();
      expect(usersResolver!.fqn).toBe('Query.users');
    });

    it('has resolverType and resolverField in metadata', () => {
      const result = plugin.extractNodes('resolvers.ts', Buffer.from(source), 'typescript');
      const data = result._unsafeUnwrap();

      const usersResolver = data.symbols.find(
        (s) => s.name === 'users' && s.kind === 'function',
      );
      expect(usersResolver).toBeDefined();
      expect((usersResolver!.metadata as any).resolverType).toBe('Query');
      expect((usersResolver!.metadata as any).resolverField).toBe('users');
    });

    it('extracts mutation resolvers', () => {
      const result = plugin.extractNodes('resolvers.ts', Buffer.from(source), 'typescript');
      const data = result._unsafeUnwrap();

      const createResolver = data.symbols.find(
        (s) => s.name === 'createUser' && s.kind === 'function',
      );
      expect(createResolver).toBeDefined();
      expect((createResolver!.metadata as any).resolverType).toBe('Mutation');
    });

    it('produces graphql_resolves edges', () => {
      const result = plugin.extractNodes('resolvers.ts', Buffer.from(source), 'typescript');
      const data = result._unsafeUnwrap();
      expect(data.edges).toBeDefined();
      expect(data.edges!.length).toBeGreaterThan(0);
      expect(data.edges![0].edgeType).toBe('graphql_resolves');
    });
  });

  describe('non-GraphQL TypeScript file', () => {
    it('returns empty result', () => {
      const source = `export class Foo { bar() {} }`;
      const result = plugin.extractNodes('foo.ts', Buffer.from(source), 'typescript');
      const data = result._unsafeUnwrap();
      expect(data.symbols).toEqual([]);
      expect(data.frameworkRole).toBeUndefined();
    });
  });

  describe('non-typescript file', () => {
    it('returns empty result', () => {
      const source = `type User { id: ID! }`;
      const result = plugin.extractNodes('schema.py', Buffer.from(source), 'python');
      const data = result._unsafeUnwrap();
      expect(data.symbols).toEqual([]);
    });
  });
});
