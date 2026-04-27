import { describe, expect, it } from 'vitest';
import { JavaLanguagePlugin } from '../../src/indexer/plugins/language/java/index.js';

const plugin = new JavaLanguagePlugin();

async function extract(code: string, filePath = 'com/example/App.java') {
  const result = await plugin.extractSymbols(filePath, Buffer.from(code));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe('JavaLanguagePlugin', () => {
  it('has correct manifest', () => {
    expect(plugin.manifest.name).toBe('java-language');
    expect(plugin.supportedExtensions).toContain('.java');
  });

  it('extracts class with package', async () => {
    const result = await extract(`
package com.example;

public class UserService {
  private String name;

  public void doWork() {}
}
    `);
    const cls = result.symbols.find((s) => s.name === 'UserService');
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe('class');
    expect(cls!.fqn).toBe('com.example.UserService');
  });

  it('extracts methods and fields', async () => {
    const result = await extract(`
package com.example;

public class Service {
  private final String name;
  public static final int MAX = 100;

  public String getName() { return name; }
}
    `);
    const method = result.symbols.find((s) => s.name === 'getName');
    expect(method).toBeDefined();
    expect(method!.kind).toBe('method');

    const constant = result.symbols.find((s) => s.name === 'MAX');
    expect(constant).toBeDefined();
    expect(constant!.kind).toBe('constant');
  });

  it('extracts interface with extends', async () => {
    const result = await extract(`
package com.example;

public interface Repository extends CrudRepository {
  User findById(long id);
}
    `);
    const iface = result.symbols.find((s) => s.name === 'Repository');
    expect(iface).toBeDefined();
    expect(iface!.kind).toBe('interface');
  });

  it('extracts enum with constants', async () => {
    const result = await extract(`
package com.example;

public enum Color {
  RED, GREEN, BLUE;
  public String hex() { return ""; }
}
    `);
    const enumSym = result.symbols.find((s) => s.name === 'Color');
    expect(enumSym).toBeDefined();
    expect(enumSym!.kind).toBe('enum');

    const red = result.symbols.find((s) => s.name === 'RED');
    expect(red).toBeDefined();
    expect(red!.kind).toBe('enum_case');
  });

  it('extracts import edges', async () => {
    const result = await extract(`
package com.example;

import java.util.List;
import java.util.Map;
import static java.lang.Math.PI;
    `);
    expect(result.edges).toBeDefined();
    expect(result.edges!.length).toBeGreaterThanOrEqual(3);
    const froms = result.edges!.map((e) => (e.metadata as any).from);
    expect(froms).toContain('java.util.List');
  });

  it('detects extends and implements', async () => {
    const result = await extract(`
package com.example;

public class UserServiceImpl extends BaseService implements UserService, Serializable {
}
    `);
    const cls = result.symbols.find((s) => s.name === 'UserServiceImpl');
    expect(cls!.metadata).toBeDefined();
    expect(cls!.metadata!.extends).toBe('BaseService');
    expect(cls!.metadata!.implements).toContain('UserService');
  });

  it('detects annotations', async () => {
    const result = await extract(`
package com.example;

@RestController
@RequestMapping("/api")
public class ApiController {
  @GetMapping("/users")
  public List<User> getUsers() { return null; }
}
    `);
    const cls = result.symbols.find((s) => s.name === 'ApiController');
    expect(cls!.metadata!.annotations).toContain('RestController');
  });
});
