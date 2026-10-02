import { describe, expect, it } from 'vitest';
import {
  extractTemporalGo,
  extractTemporalJava,
  extractTemporalPython,
  extractTemporalTypeScript,
  findTsActivitiesProxies,
  findTsDefineBindings,
  findTsNamedImports,
} from '../../../src/indexer/plugins/integration/messaging/temporal/extract.js';
import { TemporalPlugin } from '../../../src/indexer/plugins/integration/messaging/temporal/index.js';
import type { ProjectContext, ResolveContext } from '../../../src/plugin-api/types.js';

function makeCtx(overrides: Partial<ProjectContext> = {}): ProjectContext {
  return {
    rootPath: '/tmp/no-such',
    configFiles: [],
    detectedVersions: [],
    allDependencies: [],
    ...overrides,
  };
}

describe('TemporalPlugin — detection', () => {
  it('detects via @temporalio/workflow', () => {
    const plugin = new TemporalPlugin();
    expect(
      plugin.detect(
        makeCtx({ allDependencies: [{ name: '@temporalio/workflow', version: '1.0.0' }] }),
      ),
    ).toBe(true);
  });

  it('detects via temporalio (Python)', () => {
    const plugin = new TemporalPlugin();
    expect(
      plugin.detect(makeCtx({ allDependencies: [{ name: 'temporalio', version: '1.0.0' }] })),
    ).toBe(true);
  });

  it('detects via io.temporal:temporal-sdk (Java/Gradle)', () => {
    const plugin = new TemporalPlugin();
    expect(
      plugin.detect(
        makeCtx({ allDependencies: [{ name: 'io.temporal:temporal-sdk', version: '1.22.0' }] }),
      ),
    ).toBe(true);
  });

  it('detects via go.temporal.io/sdk (Go)', () => {
    const plugin = new TemporalPlugin();
    expect(
      plugin.detect(
        makeCtx({ allDependencies: [{ name: 'go.temporal.io/sdk', version: 'v1.25.0' }] }),
      ),
    ).toBe(true);
  });

  it('rejects without any Temporal dependency', () => {
    const plugin = new TemporalPlugin();
    expect(plugin.detect(makeCtx({ allDependencies: [{ name: 'lodash', version: '*' }] }))).toBe(
      false,
    );
  });
});

describe('TemporalPlugin — schema', () => {
  it('registers all four Temporal edge types', () => {
    const schema = new TemporalPlugin().registerSchema();
    const names = schema.edgeTypes?.map((e) => e.name) ?? [];
    expect(names).toContain('temporal_executes_activity');
    expect(names).toContain('temporal_sends_signal');
    expect(names).toContain('temporal_executes_child_workflow');
    expect(names).toContain('temporal_sends_update');
  });
});

describe('extractTemporalPython', () => {
  it('tags @workflow.defn class and @workflow.run method as workflow', () => {
    const refs = extractTemporalPython(`
@workflow.defn
class GreetingWorkflow:
    @workflow.run
    async def run(self, name: str) -> str:
        return await workflow.execute_activity(say_hello, name)
`);
    expect(refs.find((r) => r.name === 'GreetingWorkflow')?.role).toBe('workflow');
    expect(refs.find((r) => r.name === 'run')?.role).toBe('workflow');
  });

  it('tags @workflow.signal and @workflow.query methods', () => {
    const refs = extractTemporalPython(`
@workflow.defn
class OrderWorkflow:
    @workflow.signal
    def cancel(self):
        pass

    @workflow.query
    def status(self) -> str:
        return "pending"
`);
    expect(refs.find((r) => r.name === 'cancel')?.role).toBe('signal');
    expect(refs.find((r) => r.name === 'status')?.role).toBe('query');
  });

  it('tags @activity.defn function as activity', () => {
    const refs = extractTemporalPython(`
@activity.defn
async def say_hello(name: str) -> str:
    return f"Hello, {name}!"
`);
    expect(refs).toEqual([{ name: 'say_hello', role: 'activity', line: 2 }]);
  });

  it('tags @workflow.update methods as update', () => {
    const refs = extractTemporalPython(`
@workflow.defn
class OrderWorkflow:
    @workflow.update
    def change_quantity(self, qty: int):
        pass
`);
    expect(refs.find((r) => r.name === 'change_quantity')?.role).toBe('update');
  });

  it('matches a string-literal activity name (regression: bug #2 from review)', () => {
    const refs = extractTemporalPython(`
@workflow.run
async def run(self):
    return await workflow.execute_activity("SayHello", "world")
`);
    expect(refs.find((r) => r.name === 'run')).toBeDefined();
  });
});

describe('extractTemporalPython — call-site regexes', () => {
  it('PY_EXECUTE_ACTIVITY_RE matches a leading-quoted string-literal activity name', async () => {
    const { PY_EXECUTE_ACTIVITY_RE } = await import(
      '../../../src/indexer/plugins/integration/messaging/temporal/extract.js'
    );
    const re = new RegExp(PY_EXECUTE_ACTIVITY_RE.source);
    const m = re.exec('await workflow.execute_activity("SayHello", name)');
    expect(m?.[1]).toBe('SayHello');
  });

  it('PY_SEND_SIGNAL_RE matches handle.signal(...)', async () => {
    const { PY_SEND_SIGNAL_RE } = await import(
      '../../../src/indexer/plugins/integration/messaging/temporal/extract.js'
    );
    const re = new RegExp(PY_SEND_SIGNAL_RE.source);
    const m = re.exec('await handle.signal(OrderWorkflow.cancel)');
    expect(m?.[1]).toBe('OrderWorkflow.cancel');
  });

  it('PY_EXECUTE_CHILD_WORKFLOW_RE matches workflow.execute_child_workflow(...)', async () => {
    const { PY_EXECUTE_CHILD_WORKFLOW_RE } = await import(
      '../../../src/indexer/plugins/integration/messaging/temporal/extract.js'
    );
    const re = new RegExp(PY_EXECUTE_CHILD_WORKFLOW_RE.source);
    const m = re.exec('await workflow.execute_child_workflow(ChildWorkflow.run, name)');
    expect(m?.[1]).toBe('ChildWorkflow.run');
  });

  it('PY_SEND_UPDATE_RE matches handle.execute_update(...)', async () => {
    const { PY_SEND_UPDATE_RE } = await import(
      '../../../src/indexer/plugins/integration/messaging/temporal/extract.js'
    );
    const re = new RegExp(PY_SEND_UPDATE_RE.source);
    const m = re.exec('await handle.execute_update(OrderWorkflow.change_quantity, 5)');
    expect(m?.[1]).toBe('OrderWorkflow.change_quantity');
  });
});

describe('extractTemporalTypeScript', () => {
  it('tags exported functions in a workflow file as workflow', () => {
    const refs = extractTemporalTypeScript(`
import { proxyActivities } from '@temporalio/workflow';
import type * as activities from './activities';

const { greet } = proxyActivities<typeof activities>({ startToCloseTimeout: '1 minute' });

export async function greetingWorkflow(name: string): Promise<string> {
  return await greet(name);
}
`);
    expect(refs).toEqual([{ name: 'greetingWorkflow', role: 'workflow', line: 7 }]);
  });

  it('ignores files that do not import @temporalio/workflow', () => {
    const refs = extractTemporalTypeScript(`export function greet(name: string) { return name; }`);
    expect(refs).toEqual([]);
  });

  it('does not tag an exported helper called internally as workflow (regression: bug #3 from review)', () => {
    const refs = extractTemporalTypeScript(`
import { proxyActivities } from '@temporalio/workflow';

export function formatGreeting(name: string): string {
  return \`Hello, \${name}!\`;
}

export async function greetingWorkflow(name: string): Promise<string> {
  return formatGreeting(name);
}
`);
    expect(refs.find((r) => r.name === 'formatGreeting')).toBeUndefined();
    expect(refs.find((r) => r.name === 'greetingWorkflow')?.role).toBe('workflow');
  });

  it('tags a setHandler-registered defineSignal/defineUpdate as signal/update', () => {
    const refs = extractTemporalTypeScript(`
import { defineSignal, defineUpdate, setHandler } from '@temporalio/workflow';

export const cancelSignal = defineSignal('cancel');
export const changeQuantity = defineUpdate<number, [number]>('changeQuantity');

export async function orderWorkflow(): Promise<void> {
  setHandler(cancelSignal, () => {});
  setHandler(changeQuantity, (qty: number) => qty);
}
`);
    expect(refs.find((r) => r.name === 'cancel')?.role).toBe('signal');
    expect(refs.find((r) => r.name === 'changeQuantity')?.role).toBe('update');
  });
});

describe('findTsDefineBindings / findTsNamedImports', () => {
  it('maps a defineSignal const to its kind and wire name', () => {
    const bindings = findTsDefineBindings(`export const cancelSignal = defineSignal('cancel');`);
    expect(bindings.get('cancelSignal')).toEqual({
      localName: 'cancelSignal',
      definedName: 'cancel',
      kind: 'signal',
    });
  });

  it('resolves named imports including aliasing', () => {
    const imports = findTsNamedImports(
      `import { cancelSignal, greet as sayHello } from './workflows';`,
    );
    expect(imports).toEqual([
      { exportName: 'cancelSignal', localName: 'cancelSignal', modulePath: './workflows' },
      { exportName: 'greet', localName: 'sayHello', modulePath: './workflows' },
    ]);
  });
});

describe('findTsActivitiesProxies', () => {
  it('resolves the inline typeof import() form', () => {
    const proxies = findTsActivitiesProxies(`
const activities = proxyActivities<typeof import('./activities')>({ startToCloseTimeout: '1 minute' });
`);
    expect(proxies).toEqual([{ binding: 'activities', modulePath: './activities' }]);
  });

  it('resolves the namespace-import alias form', () => {
    const proxies = findTsActivitiesProxies(`
import type * as activities from './activities';
const acts = proxyActivities<typeof activities>({ startToCloseTimeout: '1 minute' });
`);
    expect(proxies).toEqual([{ binding: 'acts', modulePath: './activities' }]);
  });
});

describe('extractTemporalJava', () => {
  it('tags @WorkflowInterface and its methods as workflow', () => {
    const { refs, interfaceMethods } = extractTemporalJava(`
@WorkflowInterface
public interface GreetingWorkflow {
  @WorkflowMethod
  String getGreeting(String name);
}
`);
    expect(refs.find((r) => r.name === 'GreetingWorkflow')?.role).toBe('workflow');
    expect(refs.find((r) => r.name === 'getGreeting')?.role).toBe('workflow');
    expect(interfaceMethods.get('GreetingWorkflow')?.has('getGreeting')).toBe(true);
  });

  it('tags @ActivityInterface and its methods as activity', () => {
    const { refs, interfaceMethods } = extractTemporalJava(`
@ActivityInterface
public interface GreetingActivities {
  @ActivityMethod
  String composeGreeting(String name);
}
`);
    expect(refs.find((r) => r.name === 'GreetingActivities')?.role).toBe('activity');
    expect(interfaceMethods.get('GreetingActivities')?.has('composeGreeting')).toBe(true);
  });

  it('tags @SignalMethod/@QueryMethod/@UpdateMethod inside a @WorkflowInterface individually', () => {
    const { refs, interfaceMethods } = extractTemporalJava(`
@WorkflowInterface
public interface OrderWorkflow {
  @WorkflowMethod
  void run();

  @SignalMethod
  void cancel();

  @QueryMethod
  String status();

  @UpdateMethod
  void changeQuantity(int qty);
}
`);
    expect(refs.find((r) => r.name === 'run')?.role).toBe('workflow');
    expect(refs.find((r) => r.name === 'cancel')?.role).toBe('signal');
    expect(refs.find((r) => r.name === 'status')?.role).toBe('query');
    expect(refs.find((r) => r.name === 'changeQuantity')?.role).toBe('update');
    expect(interfaceMethods.get('OrderWorkflow')?.get('cancel')).toBe('signal');
    expect(interfaceMethods.get('OrderWorkflow')?.get('changeQuantity')).toBe('update');
  });
});

describe('extractTemporalGo', () => {
  it('tags functions passed to RegisterWorkflow/RegisterActivity', () => {
    const refs = extractTemporalGo(`
func main() {
  w.RegisterWorkflow(GreetingWorkflow)
  w.RegisterActivity(ComposeGreeting)
}
`);
    expect(refs).toEqual([
      { name: 'GreetingWorkflow', role: 'workflow', line: 3 },
      { name: 'ComposeGreeting', role: 'activity', line: 4 },
    ]);
  });

  it('resolves the struct-method DI pattern to its method name (regression: bug #1 from review)', () => {
    const refs = extractTemporalGo(`
func main() {
  a := &Activities{}
  w.RegisterActivity(a.ComposeGreeting)
}
`);
    expect(refs.find((r) => r.name === 'ComposeGreeting')?.role).toBe('activity');
  });

  it('tags GetSignalChannel/SetQueryHandler by their string literal name', () => {
    const refs = extractTemporalGo(`
func GreetingWorkflow(ctx workflow.Context) error {
  sigCh := workflow.GetSignalChannel(ctx, "cancel")
  err := workflow.SetQueryHandler(ctx, "status", func() (string, error) {
    return "ok", nil
  })
  return err
}
`);
    expect(refs.find((r) => r.name === 'cancel')?.role).toBe('signal');
    expect(refs.find((r) => r.name === 'status')?.role).toBe('query');
  });
});

describe('extractTemporalGo — call-site regexes', () => {
  it('GO_EXECUTE_ACTIVITY_RE matches a quoted string-literal activity name', async () => {
    const { GO_EXECUTE_ACTIVITY_RE } = await import(
      '../../../src/indexer/plugins/integration/messaging/temporal/extract.js'
    );
    const re = new RegExp(GO_EXECUTE_ACTIVITY_RE.source);
    const m = re.exec('workflow.ExecuteActivity(ctx, "ComposeGreeting", name)');
    expect(m?.[1]).toBe('ComposeGreeting');
  });

  it('GO_EXECUTE_CHILD_WORKFLOW_RE matches a bare identifier', async () => {
    const { GO_EXECUTE_CHILD_WORKFLOW_RE } = await import(
      '../../../src/indexer/plugins/integration/messaging/temporal/extract.js'
    );
    const re = new RegExp(GO_EXECUTE_CHILD_WORKFLOW_RE.source);
    const m = re.exec('workflow.ExecuteChildWorkflow(ctx, ChildWorkflow, name)');
    expect(m?.[2]).toBe('ChildWorkflow');
  });

  it('GO_SIGNAL_EXTERNAL_RE matches SignalExternalWorkflow by literal name', async () => {
    const { GO_SIGNAL_EXTERNAL_RE } = await import(
      '../../../src/indexer/plugins/integration/messaging/temporal/extract.js'
    );
    const re = new RegExp(GO_SIGNAL_EXTERNAL_RE.source);
    const m = re.exec('workflow.SignalExternalWorkflow(ctx, workflowID, "", "cancel", nil)');
    expect(m?.[1]).toBe('cancel');
  });
});

describe('TemporalPlugin.extractNodes — full integration', () => {
  it('emits temporal_workflow frameworkRole + TEMPORAL_WORKFLOW route for Python', async () => {
    const source = `
@workflow.defn
class GreetingWorkflow:
    @workflow.run
    async def run(self, name: str) -> str:
        return await workflow.execute_activity(say_hello, name)
`;
    const result = await new TemporalPlugin().extractNodes(
      'workflows.py',
      Buffer.from(source),
      'python',
    );
    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();
    expect(parsed.frameworkRole).toBe('temporal_workflow');
    expect(
      parsed.routes?.some((r) => r.method === 'TEMPORAL_WORKFLOW' && r.uri === 'GreetingWorkflow'),
    ).toBe(true);
  });

  it('emits temporal_activity frameworkRole for a Python activity-only file', async () => {
    const source = `
@activity.defn
async def say_hello(name: str) -> str:
    return f"Hello, {name}!"
`;
    const result = await new TemporalPlugin().extractNodes(
      'activities.py',
      Buffer.from(source),
      'python',
    );
    const parsed = result._unsafeUnwrap();
    expect(parsed.frameworkRole).toBe('temporal_activity');
    expect(parsed.routes).toEqual([{ method: 'TEMPORAL_ACTIVITY', uri: 'say_hello', line: 2 }]);
  });

  it('returns empty result for unsupported languages', async () => {
    const result = await new TemporalPlugin().extractNodes('a.rb', Buffer.from('whatever'), 'ruby');
    const parsed = result._unsafeUnwrap();
    expect(parsed.symbols).toEqual([]);
  });
});

describe('TemporalPlugin.resolveEdges — same-file Python', () => {
  it('resolves workflow.execute_activity to the activity symbol in the same file', () => {
    const src = `
@workflow.defn
class GreetingWorkflow:
    @workflow.run
    async def run(self, name: str) -> str:
        return await workflow.execute_activity(say_hello, name)

@activity.defn
async def say_hello(name: str) -> str:
    return f"Hello, {name}!"
`;
    const ctx: ResolveContext = {
      rootPath: '/x',
      getAllFiles: () => [{ id: 1, path: 'workflow.py', language: 'python' }],
      getSymbolsByFile: () => [
        { id: 10, symbolId: 'w', name: 'run', kind: 'method', fqn: null, lineStart: 5, lineEnd: 6 },
        {
          id: 20,
          symbolId: 'a',
          name: 'say_hello',
          kind: 'function',
          fqn: null,
          lineStart: 9,
          lineEnd: 10,
        },
      ],
      getSymbolByFqn: () => undefined,
      getNodeId: () => undefined,
      createNodeIfNeeded: () => 0,
      readFile: () => src,
    } as unknown as ResolveContext;

    const edges = new TemporalPlugin().resolveEdges(ctx)._unsafeUnwrap();
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      sourceRefId: 10,
      targetRefId: 20,
      edgeType: 'temporal_executes_activity',
      resolution: 'text_matched',
    });
  });
});

describe('TemporalPlugin.resolveEdges — cross-file TypeScript', () => {
  it('resolves proxyActivities() call through to the activities module export', () => {
    const workflowSrc = `
import { proxyActivities } from '@temporalio/workflow';
import type * as activities from './activities';

const { greet } = proxyActivities<typeof activities>({ startToCloseTimeout: '1 minute' });

export async function greetingWorkflow(name: string): Promise<string> {
  return await greet(name);
}
`;
    const activitiesSrc = `
export async function greet(name: string): Promise<string> {
  return \`Hello, \${name}!\`;
}
`;
    const files = [
      { id: 1, path: 'workflows/greeting.ts', language: 'typescript' },
      { id: 2, path: 'workflows/activities.ts', language: 'typescript' },
    ];
    const symbolsByFile: Record<number, unknown[]> = {
      1: [
        {
          id: 100,
          symbolId: 'wf',
          name: 'greetingWorkflow',
          kind: 'function',
          fqn: null,
          lineStart: 7,
          lineEnd: 9,
        },
      ],
      2: [
        {
          id: 200,
          symbolId: 'act',
          name: 'greet',
          kind: 'function',
          fqn: null,
          lineStart: 2,
          lineEnd: 4,
        },
      ],
    };
    const ctx: ResolveContext = {
      rootPath: '/x',
      getAllFiles: () => files,
      getSymbolsByFile: (fileId: number) => symbolsByFile[fileId] ?? [],
      getSymbolByFqn: () => undefined,
      getNodeId: () => undefined,
      createNodeIfNeeded: () => 0,
      readFile: (relPath: string) =>
        relPath === 'workflows/greeting.ts' ? workflowSrc : activitiesSrc,
    } as unknown as ResolveContext;

    const edges = new TemporalPlugin().resolveEdges(ctx)._unsafeUnwrap();
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      sourceRefId: 100,
      targetRefId: 200,
      edgeType: 'temporal_executes_activity',
      resolution: 'text_matched',
    });
  });
});

describe('TemporalPlugin.resolveEdges — cross-file Java', () => {
  it('resolves Workflow.newActivityStub call chain to the activity interface method', () => {
    const workflowSrc = `
public class GreetingWorkflowImpl implements GreetingWorkflow {
  private final GreetingActivities activities =
      Workflow.newActivityStub(GreetingActivities.class);

  public String getGreeting(String name) {
    return activities.composeGreeting(name);
  }
}
`;
    const activitiesSrc = `
@ActivityInterface
public interface GreetingActivities {
  @ActivityMethod
  String composeGreeting(String name);
}
`;
    const files = [
      { id: 1, path: 'GreetingWorkflowImpl.java', language: 'java' },
      { id: 2, path: 'GreetingActivities.java', language: 'java' },
    ];
    const symbolsByFile: Record<number, unknown[]> = {
      1: [
        {
          id: 100,
          symbolId: 'm',
          name: 'getGreeting',
          kind: 'method',
          fqn: null,
          lineStart: 6,
          lineEnd: 8,
        },
      ],
      2: [
        {
          id: 200,
          symbolId: 'a',
          name: 'composeGreeting',
          kind: 'method',
          fqn: null,
          lineStart: 4,
          lineEnd: 4,
        },
      ],
    };
    const ctx: ResolveContext = {
      rootPath: '/x',
      getAllFiles: () => files,
      getSymbolsByFile: (fileId: number) => symbolsByFile[fileId] ?? [],
      getSymbolByFqn: () => undefined,
      getNodeId: () => undefined,
      createNodeIfNeeded: () => 0,
      readFile: (relPath: string) =>
        relPath === 'GreetingWorkflowImpl.java' ? workflowSrc : activitiesSrc,
    } as unknown as ResolveContext;

    const edges = new TemporalPlugin().resolveEdges(ctx)._unsafeUnwrap();
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      sourceRefId: 100,
      targetRefId: 200,
      edgeType: 'temporal_executes_activity',
      resolution: 'text_matched',
    });
  });
});

describe('TemporalPlugin.resolveEdges — same-file Go', () => {
  it('resolves workflow.ExecuteActivity(ctx, Fn) to the registered activity function', () => {
    const src = `
func GreetingWorkflow(ctx workflow.Context, name string) (string, error) {
  var result string
  err := workflow.ExecuteActivity(ctx, ComposeGreeting, name).Get(ctx, &result)
  return result, err
}

func ComposeGreeting(ctx context.Context, name string) (string, error) {
  return "Hello, " + name, nil
}

func main() {
  w.RegisterWorkflow(GreetingWorkflow)
  w.RegisterActivity(ComposeGreeting)
}
`;
    const ctx: ResolveContext = {
      rootPath: '/x',
      getAllFiles: () => [{ id: 1, path: 'workflow.go', language: 'go' }],
      getSymbolsByFile: () => [
        {
          id: 10,
          symbolId: 'w',
          name: 'GreetingWorkflow',
          kind: 'function',
          fqn: null,
          lineStart: 2,
          lineEnd: 6,
        },
        {
          id: 20,
          symbolId: 'a',
          name: 'ComposeGreeting',
          kind: 'function',
          fqn: null,
          lineStart: 8,
          lineEnd: 10,
        },
      ],
      getSymbolByFqn: () => undefined,
      getNodeId: () => undefined,
      createNodeIfNeeded: () => 0,
      readFile: () => src,
    } as unknown as ResolveContext;

    const edges = new TemporalPlugin().resolveEdges(ctx)._unsafeUnwrap();
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      sourceRefId: 10,
      targetRefId: 20,
      edgeType: 'temporal_executes_activity',
      resolution: 'text_matched',
    });
  });
});

describe('TemporalPlugin.resolveEdges — same-file Python signal + child workflow', () => {
  it('resolves execute_child_workflow(ClassName.run, ...) to the child workflow class, not by the shared "run" method name', () => {
    const src = `
@workflow.defn
class OrderWorkflow:
    @workflow.run
    async def run(self):
        await workflow.start_child_workflow(ShippingWorkflow.run, self)

@workflow.defn
class ShippingWorkflow:
    @workflow.run
    async def run(self):
        pass
`;
    const ctx: ResolveContext = {
      rootPath: '/x',
      getAllFiles: () => [{ id: 1, path: 'workflow.py', language: 'python' }],
      getSymbolsByFile: () => [
        {
          id: 10,
          symbolId: 'w1',
          name: 'run',
          kind: 'method',
          fqn: null,
          lineStart: 5,
          lineEnd: 6,
        },
        {
          id: 20,
          symbolId: 'sw',
          name: 'ShippingWorkflow',
          kind: 'class',
          fqn: null,
          lineStart: 8,
          lineEnd: 11,
        },
        {
          id: 21,
          symbolId: 'w2',
          name: 'run',
          kind: 'method',
          fqn: null,
          lineStart: 10,
          lineEnd: 11,
        },
      ],
      getSymbolByFqn: () => undefined,
      getNodeId: () => undefined,
      createNodeIfNeeded: () => 0,
      readFile: () => src,
    } as unknown as ResolveContext;

    const edges = new TemporalPlugin().resolveEdges(ctx)._unsafeUnwrap();
    const childEdges = edges.filter((e) => e.edgeType === 'temporal_executes_child_workflow');
    expect(childEdges).toContainEqual(
      expect.objectContaining({ sourceRefId: 10, targetRefId: 20 }),
    );
    // The shared "run" method name must not leak a spurious edge to OrderWorkflow's own run method.
    expect(childEdges.some((e) => e.targetRefId === 10)).toBe(false);
  });

  it('resolves handle.signal(...) to the signal handler method', () => {
    const src = `
@workflow.defn
class OrderWorkflow:
    @workflow.run
    async def run(self):
        handle = get_external_handle()
        await handle.signal(OrderWorkflow.cancel_order)

    @workflow.signal
    def cancel_order(self):
        pass
`;
    const ctx: ResolveContext = {
      rootPath: '/x',
      getAllFiles: () => [{ id: 1, path: 'workflow.py', language: 'python' }],
      getSymbolsByFile: () => [
        {
          id: 10,
          symbolId: 'w1',
          name: 'run',
          kind: 'method',
          fqn: null,
          lineStart: 5,
          lineEnd: 7,
        },
        {
          id: 11,
          symbolId: 'c1',
          name: 'cancel_order',
          kind: 'method',
          fqn: null,
          lineStart: 9,
          lineEnd: 10,
        },
      ],
      getSymbolByFqn: () => undefined,
      getNodeId: () => undefined,
      createNodeIfNeeded: () => 0,
      readFile: () => src,
    } as unknown as ResolveContext;

    const edges = new TemporalPlugin().resolveEdges(ctx)._unsafeUnwrap();
    expect(edges).toContainEqual(
      expect.objectContaining({
        sourceRefId: 10,
        targetRefId: 11,
        edgeType: 'temporal_sends_signal',
      }),
    );
  });
});

describe('TemporalPlugin.resolveEdges — same-file Go signal', () => {
  it('resolves workflow.SignalExternalWorkflow(...) to the GetSignalChannel enclosing function', () => {
    const src = `
func CancelHandler(ctx workflow.Context) error {
  sigCh := workflow.GetSignalChannel(ctx, "cancel")
  _ = sigCh
  return nil
}

func Sender(ctx workflow.Context, workflowID string) error {
  return workflow.SignalExternalWorkflow(ctx, workflowID, "", "cancel", nil).Get(ctx, nil)
}
`;
    const ctx: ResolveContext = {
      rootPath: '/x',
      getAllFiles: () => [{ id: 1, path: 'workflow.go', language: 'go' }],
      getSymbolsByFile: () => [
        {
          id: 10,
          symbolId: 'h',
          name: 'CancelHandler',
          kind: 'function',
          fqn: null,
          lineStart: 2,
          lineEnd: 6,
        },
        {
          id: 20,
          symbolId: 's',
          name: 'Sender',
          kind: 'function',
          fqn: null,
          lineStart: 8,
          lineEnd: 10,
        },
      ],
      getSymbolByFqn: () => undefined,
      getNodeId: () => undefined,
      createNodeIfNeeded: () => 0,
      readFile: () => src,
    } as unknown as ResolveContext;

    const edges = new TemporalPlugin().resolveEdges(ctx)._unsafeUnwrap();
    expect(edges).toContainEqual(
      expect.objectContaining({
        sourceRefId: 20,
        targetRefId: 10,
        edgeType: 'temporal_sends_signal',
      }),
    );
  });
});

describe('TemporalPlugin.resolveEdges — cross-file Java child workflow stub', () => {
  it('resolves Workflow.newChildWorkflowStub call chain to the child workflow interface method', () => {
    const parentSrc = `
public class OrderWorkflowImpl implements OrderWorkflow {
  public void run() {
    ShippingWorkflow child = Workflow.newChildWorkflowStub(ShippingWorkflow.class);
    child.ship();
  }
}
`;
    const childSrc = `
@WorkflowInterface
public interface ShippingWorkflow {
  @WorkflowMethod
  void ship();
}
`;
    const files = [
      { id: 1, path: 'OrderWorkflowImpl.java', language: 'java' },
      { id: 2, path: 'ShippingWorkflow.java', language: 'java' },
    ];
    const symbolsByFile: Record<number, unknown[]> = {
      1: [
        {
          id: 100,
          symbolId: 'm',
          name: 'run',
          kind: 'method',
          fqn: null,
          lineStart: 3,
          lineEnd: 6,
        },
      ],
      2: [
        {
          id: 200,
          symbolId: 'a',
          name: 'ship',
          kind: 'method',
          fqn: null,
          lineStart: 4,
          lineEnd: 4,
        },
      ],
    };
    const ctx: ResolveContext = {
      rootPath: '/x',
      getAllFiles: () => files,
      getSymbolsByFile: (fileId: number) => symbolsByFile[fileId] ?? [],
      getSymbolByFqn: () => undefined,
      getNodeId: () => undefined,
      createNodeIfNeeded: () => 0,
      readFile: (relPath: string) => (relPath === 'OrderWorkflowImpl.java' ? parentSrc : childSrc),
    } as unknown as ResolveContext;

    const edges = new TemporalPlugin().resolveEdges(ctx)._unsafeUnwrap();
    expect(edges).toContainEqual(
      expect.objectContaining({
        sourceRefId: 100,
        targetRefId: 200,
        edgeType: 'temporal_executes_child_workflow',
      }),
    );
  });
});

describe('TemporalPlugin.resolveEdges — cross-file TypeScript signal + child workflow', () => {
  it('resolves handle.signal(...) through defineSignal/setHandler and executeChild(...) to the target workflow', () => {
    const parentSrc = `
import { executeChild } from '@temporalio/workflow';
import { shippingWorkflow } from './shipping';
import { cancelSignal } from './order';

export async function orchestratorWorkflow(): Promise<void> {
  const handle = await executeChild(shippingWorkflow, {});
  await handle.signal(cancelSignal);
}
`;
    const orderSrc = `
import { defineSignal, setHandler } from '@temporalio/workflow';

export const cancelSignal = defineSignal('cancel');

export async function orderWorkflow(): Promise<void> {
  setHandler(cancelSignal, () => {});
}
`;
    const shippingSrc = `
export async function shippingWorkflow(): Promise<void> {}
`;
    const files = [
      { id: 1, path: 'workflows/orchestrator.ts', language: 'typescript' },
      { id: 2, path: 'workflows/order.ts', language: 'typescript' },
      { id: 3, path: 'workflows/shipping.ts', language: 'typescript' },
    ];
    const symbolsByFile: Record<number, unknown[]> = {
      1: [
        {
          id: 100,
          symbolId: 'o',
          name: 'orchestratorWorkflow',
          kind: 'function',
          fqn: null,
          lineStart: 6,
          lineEnd: 9,
        },
      ],
      2: [
        {
          id: 200,
          symbolId: 'w',
          name: 'orderWorkflow',
          kind: 'function',
          fqn: null,
          lineStart: 6,
          lineEnd: 8,
        },
      ],
      3: [
        {
          id: 300,
          symbolId: 's',
          name: 'shippingWorkflow',
          kind: 'function',
          fqn: null,
          lineStart: 2,
          lineEnd: 2,
        },
      ],
    };
    const srcByPath: Record<string, string> = {
      'workflows/orchestrator.ts': parentSrc,
      'workflows/order.ts': orderSrc,
      'workflows/shipping.ts': shippingSrc,
    };
    const ctx: ResolveContext = {
      rootPath: '/x',
      getAllFiles: () => files,
      getSymbolsByFile: (fileId: number) => symbolsByFile[fileId] ?? [],
      getSymbolByFqn: () => undefined,
      getNodeId: () => undefined,
      createNodeIfNeeded: () => 0,
      readFile: (relPath: string) => srcByPath[relPath],
    } as unknown as ResolveContext;

    const edges = new TemporalPlugin().resolveEdges(ctx)._unsafeUnwrap();
    expect(edges).toContainEqual(
      expect.objectContaining({
        sourceRefId: 100,
        targetRefId: 300,
        edgeType: 'temporal_executes_child_workflow',
      }),
    );
    expect(edges).toContainEqual(
      expect.objectContaining({
        sourceRefId: 100,
        targetRefId: 200,
        edgeType: 'temporal_sends_signal',
      }),
    );
  });
});

describe('TemporalPlugin.resolveEdges — Python string-constant dispatch', () => {
  it('resolves an activity dispatched by an imported constant to its matching literal value, same file', () => {
    const src = `
PLAN_EVALUATION_ACTIVITY = "plan_evaluation_activity"

@workflow.defn
class PlanWorkflow:
    @workflow.run
    async def run(self):
        return await workflow.execute_activity(PLAN_EVALUATION_ACTIVITY, self)

@activity.defn
async def plan_evaluation_activity():
    pass
`;
    const ctx: ResolveContext = {
      rootPath: '/x',
      getAllFiles: () => [{ id: 1, path: 'workflow.py', language: 'python' }],
      getSymbolsByFile: () => [
        { id: 10, symbolId: 'w', name: 'run', kind: 'method', fqn: null, lineStart: 6, lineEnd: 8 },
        {
          id: 20,
          symbolId: 'a',
          name: 'plan_evaluation_activity',
          kind: 'function',
          fqn: null,
          lineStart: 11,
          lineEnd: 12,
        },
      ],
      getSymbolByFqn: () => undefined,
      getNodeId: () => undefined,
      createNodeIfNeeded: () => 0,
      readFile: () => src,
    } as unknown as ResolveContext;

    const edges = new TemporalPlugin().resolveEdges(ctx)._unsafeUnwrap();
    expect(edges).toContainEqual(
      expect.objectContaining({
        sourceRefId: 10,
        targetRefId: 20,
        edgeType: 'temporal_executes_activity',
      }),
    );
  });

  it('resolves a constant defined in a different file/package than the dispatch call site', () => {
    const workflowSrc = `
from constants import PLAN_EVALUATION_ACTIVITY

@workflow.defn
class PlanWorkflow:
    @workflow.run
    async def run(self):
        return await workflow.execute_activity(PLAN_EVALUATION_ACTIVITY, self)
`;
    const constantsSrc = `
PLAN_EVALUATION_ACTIVITY = "plan_evaluation_activity"
`;
    const activitySrc = `
@activity.defn
async def plan_evaluation_activity():
    pass
`;
    const files = [
      { id: 1, path: 'app/workflows.py', language: 'python' },
      { id: 2, path: 'app/constants.py', language: 'python' },
      { id: 3, path: 'other_app/activities.py', language: 'python' },
    ];
    const symbolsByFile: Record<number, unknown[]> = {
      1: [
        { id: 10, symbolId: 'w', name: 'run', kind: 'method', fqn: null, lineStart: 6, lineEnd: 8 },
      ],
      2: [],
      3: [
        {
          id: 30,
          symbolId: 'a',
          name: 'plan_evaluation_activity',
          kind: 'function',
          fqn: null,
          lineStart: 3,
          lineEnd: 4,
        },
      ],
    };
    const srcByPath: Record<string, string> = {
      'app/workflows.py': workflowSrc,
      'app/constants.py': constantsSrc,
      'other_app/activities.py': activitySrc,
    };
    const ctx: ResolveContext = {
      rootPath: '/x',
      getAllFiles: () => files,
      getSymbolsByFile: (fileId: number) => symbolsByFile[fileId] ?? [],
      getSymbolByFqn: () => undefined,
      getNodeId: () => undefined,
      createNodeIfNeeded: () => 0,
      readFile: (relPath: string) => srcByPath[relPath],
    } as unknown as ResolveContext;

    const edges = new TemporalPlugin().resolveEdges(ctx)._unsafeUnwrap();
    expect(edges).toContainEqual(
      expect.objectContaining({
        sourceRefId: 10,
        targetRefId: 30,
        edgeType: 'temporal_executes_activity',
      }),
    );
  });

  it('does not emit an edge when the constant has no matching target', () => {
    const src = `
UNKNOWN_ACTIVITY = "does_not_exist_anywhere"

@workflow.defn
class PlanWorkflow:
    @workflow.run
    async def run(self):
        return await workflow.execute_activity(UNKNOWN_ACTIVITY, self)

@activity.defn
async def plan_evaluation_activity():
    pass
`;
    const ctx: ResolveContext = {
      rootPath: '/x',
      getAllFiles: () => [{ id: 1, path: 'workflow.py', language: 'python' }],
      getSymbolsByFile: () => [
        { id: 10, symbolId: 'w', name: 'run', kind: 'method', fqn: null, lineStart: 6, lineEnd: 8 },
        {
          id: 20,
          symbolId: 'a',
          name: 'plan_evaluation_activity',
          kind: 'function',
          fqn: null,
          lineStart: 11,
          lineEnd: 12,
        },
      ],
      getSymbolByFqn: () => undefined,
      getNodeId: () => undefined,
      createNodeIfNeeded: () => 0,
      readFile: () => src,
    } as unknown as ResolveContext;

    const edges = new TemporalPlugin().resolveEdges(ctx)._unsafeUnwrap();
    expect(edges).toHaveLength(0);
  });

  it('resolves a constant whose value is wrapped in parens across multiple lines, alongside a single-line sibling', () => {
    const src = `
LIST_ACTIVITY = "list_activity"
PROCESS_ACTIVITY = (
    "process_activity"
)

@workflow.defn
class PlanWorkflow:
    @workflow.run
    async def run(self):
        await workflow.execute_activity(LIST_ACTIVITY, self)
        await workflow.execute_activity(PROCESS_ACTIVITY, self)

@activity.defn
async def list_activity():
    pass

@activity.defn
async def process_activity():
    pass
`;
    const ctx: ResolveContext = {
      rootPath: '/x',
      getAllFiles: () => [{ id: 1, path: 'workflow.py', language: 'python' }],
      getSymbolsByFile: () => [
        {
          id: 10,
          symbolId: 'w',
          name: 'run',
          kind: 'method',
          fqn: null,
          lineStart: 9,
          lineEnd: 12,
        },
        {
          id: 20,
          symbolId: 'a1',
          name: 'list_activity',
          kind: 'function',
          fqn: null,
          lineStart: 15,
          lineEnd: 16,
        },
        {
          id: 30,
          symbolId: 'a2',
          name: 'process_activity',
          kind: 'function',
          fqn: null,
          lineStart: 19,
          lineEnd: 20,
        },
      ],
      getSymbolByFqn: () => undefined,
      getNodeId: () => undefined,
      createNodeIfNeeded: () => 0,
      readFile: () => src,
    } as unknown as ResolveContext;

    const edges = new TemporalPlugin().resolveEdges(ctx)._unsafeUnwrap();
    expect(edges).toContainEqual(
      expect.objectContaining({
        sourceRefId: 10,
        targetRefId: 20,
        edgeType: 'temporal_executes_activity',
      }),
    );
    expect(edges).toContainEqual(
      expect.objectContaining({
        sourceRefId: 10,
        targetRefId: 30,
        edgeType: 'temporal_executes_activity',
      }),
    );
  });
});
