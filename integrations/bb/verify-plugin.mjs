import assert from 'node:assert/strict';
import plugin from './server.ts';

const tools = new Map();
const calls = [];
const bb = {
  hosts: {
    experimental_client() {
      return {
        async call(method, args, options) {
          calls.push({ method, args, options });
          if (method === 'list') {
            return { tools: [{ name: 'search', description: 'Search code' }] };
          }
          return { content: [{ type: 'text', text: 'found symbol' }], isError: false };
        },
      };
    },
  },
  sdk: {
    threads: {
      async get() {
        return { environmentId: 'environment-1' };
      },
    },
    environments: {
      async get() {
        return { path: '/repo/on-remote-host', hostId: 'remote-host-1' };
      },
    },
  },
  agents: {
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
  },
};

await plugin(bb);
assert.deepEqual(
  [...tools.keys()],
  [
    'trace_search',
    'trace_get_symbol',
    'trace_get_outline',
    'trace_query_decisions',
    'trace_tools',
    'trace_call',
  ],
);
const context = {
  threadId: 'thread-1',
  projectId: 'project-1',
  signal: new AbortController().signal,
};
const search = await tools.get('trace_search').execute({ query: 'needle' }, context);
assert.equal(search.content[0].text, 'found symbol');
assert.deepEqual(calls[0], {
  method: 'call',
  args: { path: '/repo/on-remote-host', name: 'search', args: { query: 'needle' } },
  options: { hostId: 'remote-host-1', signal: context.signal },
});
assert.match(
  await tools.get('trace_tools').execute({ query: 'search', limit: 12 }, context),
  /search: Search code/u,
);
await assert.rejects(
  () => tools.get('trace_call').execute({ name: 'unknown', arguments: {} }, context),
  /Unknown trace-mcp tool/u,
);
assert.equal(calls.filter((call) => call.method === 'call').length, 1);
console.log('bb native tool routing verified');
