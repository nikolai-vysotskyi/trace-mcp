import { describe, it, expect } from 'vitest';
import { SpringPlugin } from '../../../src/indexer/plugins/integration/framework/spring/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

function makeCtx(overrides: Partial<ProjectContext> = {}): ProjectContext {
  return {
    rootPath: '/tmp/spring-project',
    configFiles: ['pom.xml', 'application.yml'],
    ...overrides,
  };
}

describe('SpringPlugin — detection', () => {
  it('detects via pom.xml', () => {
    expect(new SpringPlugin().detect(makeCtx())).toBe(true);
  });
  it('detects via build.gradle', () => {
    expect(new SpringPlugin().detect(makeCtx({ configFiles: ['build.gradle'] }))).toBe(true);
  });
  it('rejects without Spring markers', () => {
    expect(new SpringPlugin().detect(makeCtx({ configFiles: ['package.json'] }))).toBe(false);
  });
});

describe('SpringPlugin — schema', () => {
  it('registers Spring edge types', () => {
    const schema = new SpringPlugin().registerSchema();
    const names = schema.edgeTypes?.map((e) => e.name) ?? [];
    expect(names).toContain('spring_route');
    expect(names).toContain('spring_injects');
    expect(names).toContain('spring_entity_relation');
  });
});

describe('SpringPlugin — route extraction', () => {
  it('extracts @GetMapping routes', async () => {
    const source = `
@RestController
@RequestMapping("/api/users")
public class UserController {
  @GetMapping("/{id}")
  public User getById(@PathVariable long id) { return null; }

  @PostMapping
  public User create(@RequestBody User user) { return null; }
}
    `;
    const plugin = new SpringPlugin();
    const result = await plugin.extractNodes!('UserController.java', Buffer.from(source), 'java');
    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();
    expect(parsed.frameworkRole).toBe('controller');
    expect(parsed.routes!.length).toBeGreaterThanOrEqual(2);
    const uris = parsed.routes!.map((r) => r.uri);
    expect(uris.some((u) => u.includes('/api/users'))).toBe(true);
  });
});

describe('SpringPlugin — DI extraction', () => {
  it('extracts @Autowired injections', async () => {
    const source = `
@Service
public class OrderService {
  @Autowired
  private UserRepository userRepo;
}
    `;
    const plugin = new SpringPlugin();
    const result = await plugin.extractNodes!('OrderService.java', Buffer.from(source), 'java');
    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();
    expect(parsed.frameworkRole).toBe('service');
    const injections = parsed.edges!.filter((e) => e.edgeType === 'spring_injects');
    expect(injections.length).toBeGreaterThanOrEqual(1);
  });
});

describe('SpringPlugin — entity extraction', () => {
  it('extracts JPA entity relations', async () => {
    const source = `
@Entity
public class Order {
  @ManyToOne
  private User user;

  @OneToMany(mappedBy = "order")
  private List<OrderItem> items;
}
    `;
    const plugin = new SpringPlugin();
    const result = await plugin.extractNodes!('Order.java', Buffer.from(source), 'java');
    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();
    expect(parsed.frameworkRole).toBe('entity');
    const relations = parsed.edges!.filter((e) => e.edgeType === 'spring_entity_relation');
    expect(relations.length).toBeGreaterThanOrEqual(2);
  });
});
