import assert from 'node:assert/strict';
import plugin from './server.ts';

const tools = new Map();
const calls = [];
let rpc;
let cli;
const bb = {
  hosts: {
    experimental_client() {
      return {
        async call(method, args, options) {
          calls.push({ method, args, options });
          if (method === 'list') {
            return { tools: [{ name: 'search', description: 'Search code' }] };
          }
          if (args.name === 'unknown') throw new Error('Tool not found');
          if (args.name === 'get_index_health') {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'ready',
                    stats: { totalFiles: 23, totalSymbols: 80 },
                    warnings: ['Semantic search is disabled (ai.enabled=false): FTS-only.'],
                  }),
                },
              ],
              isError: false,
            };
          }
          if (args.name === 'query_decisions') {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    decisions: [
                      {
                        id: 'd1',
                        title: 'Use SQLite',
                        type: 'tech_choice',
                        summary: 'Local storage',
                        review_status: 'approved',
                      },
                    ],
                    total_results: 1,
                  }),
                },
              ],
              isError: false,
            };
          }
          if (args.name === 'add_decision') {
            return {
              content: [{ type: 'text', text: JSON.stringify({ added: { id: 'd2' } }) }],
              isError: false,
            };
          }
          if (args.name === 'remember_decision') {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ id: 'd3', review_status: 'approved', confidence: 0.9 }),
                },
              ],
              isError: false,
            };
          }
          if (args.name === 'reindex') {
            return {
              content: [
                { type: 'text', text: JSON.stringify({ status: 'ok', indexed: 23, errors: 0 }) },
              ],
              isError: false,
            };
          }
          return { content: [{ type: 'text', text: 'found symbol' }], isError: false };
        },
      };
    },
  },
  sdk: {
    threads: {
      async get() {
        return { environmentId: 'environment-1', projectId: 'project-1' };
      },
      async context() {
        return { usage: { usedTokens: 1200, modelContextWindow: 8000, estimated: false } };
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
  rpc: {
    register(_contract, handlers) {
      rpc = handlers;
    },
  },
  cli: {
    register(registration) {
      cli = registration;
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
    'trace_remember_decision',
    'trace_get_index_health',
    'trace_get_project_memo',
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
  options: { hostId: 'remote-host-1', signal: context.signal, timeoutMs: 180_000 },
});
assert.match(
  await tools.get('trace_tools').execute({ query: 'search', limit: 12 }, context),
  /search: Search code/u,
);
await assert.rejects(
  () => tools.get('trace_call').execute({ name: 'unknown', arguments: {} }, context),
  /Tool not found/u,
);
assert.equal(calls.filter((call) => call.method === 'call').length, 2);
assert.equal(calls.filter((call) => call.method === 'list').length, 1);
const snapshot = await rpc.readOverview({ threadId: 'thread-1' });
assert.equal(snapshot.index.status, 'ready');
assert.equal(snapshot.index.files, 23);
assert.equal(
  snapshot.index.warnings[0],
  'Semantic search is off. Indexed text search remains available.',
);
assert.equal(snapshot.context.usedTokens, 1200);
assert.deepEqual(
  snapshot.decisions.map((decision) => decision.title),
  ['Use SQLite'],
);
assert.ok(
  calls.some(
    (call) => call.args.name === 'get_index_health' && call.options.hostId === 'remote-host-1',
  ),
);
const saved = await rpc.saveDecision({
  threadId: 'thread-1',
  title: 'Use graph',
  content: 'For code navigation',
  type: 'tech_choice',
});
assert.equal(saved.id, 'd2');
assert.ok(calls.some((call) => call.args.name === 'add_decision'));
const reindexed = await rpc.reindex({ threadId: 'thread-1' });
assert.equal(reindexed.indexed, 23);
const remembered = await tools
  .get('trace_remember_decision')
  .execute({ title: 'Use SQLite', content: 'Local storage', type: 'tech_choice' }, context);
assert.equal(remembered.isError, false);
assert.ok(
  calls.some(
    (call) => call.args.name === 'remember_decision' && call.args.args.session_id === 'thread-1',
  ),
);
assert.equal(cli.name, 'trace');
const status = await cli.run(['status', '--thread', 'thread-1', '--json'], {});
assert.equal(status.exitCode, 0);
assert.equal(JSON.parse(status.stdout).index.files, 23);
const decisions = await cli.run(['decisions', 'SQLite', '--thread', 'thread-1'], {});
assert.equal(decisions.exitCode, 0);
assert.match(decisions.stdout, /Use SQLite/u);
const savedByCli = await cli.run(
  [
    'remember',
    '--thread',
    'thread-1',
    '--title',
    'Use graph',
    '--content',
    'For navigation',
    '--json',
  ],
  {},
);
assert.equal(savedByCli.exitCode, 0);
assert.equal(JSON.parse(savedByCli.stdout).id, 'd2');
const indexedByCli = await cli.run(['index', '--thread', 'thread-1', '--json'], {});
assert.equal(indexedByCli.exitCode, 0);
assert.equal(JSON.parse(indexedByCli.stdout).indexed, 23);
console.log('bb native tool routing verified');
