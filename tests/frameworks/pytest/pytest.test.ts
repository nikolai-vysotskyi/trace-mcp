import { describe, expect, it } from 'vitest';
import { PytestPlugin } from '../../../src/indexer/plugins/integration/testing/pytest/index.js';

const plugin = new PytestPlugin();

async function extract(code: string, filePath = 'tests/test_users.py') {
  const result = await plugin.extractNodes(filePath, Buffer.from(code), 'python');
  if (!result.isOk()) {
    throw new Error(
      `PytestPlugin extractNodes failed: ${JSON.stringify(result._unsafeUnwrapErr())}`,
    );
  }
  return result._unsafeUnwrap();
}

describe('PytestPlugin', () => {
  it('has correct manifest', () => {
    expect(plugin.manifest.name).toBe('pytest');
    expect(plugin.manifest.category).toBe('testing');
  });

  it('skips non-Python files', async () => {
    const result = await plugin.extractNodes('test.ts', Buffer.from('test()'), 'typescript');
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().symbols!.length).toBe(0);
  });

  it('skips non-test Python files', async () => {
    const result = await extract(
      `
def my_function():
    pass
`,
      'myapp/models.py',
    );
    expect(result.symbols!.length).toBe(0);
  });

  // ─── Test function extraction ──────────────────────────────

  describe('test functions', () => {
    it('extracts test_ prefixed functions', async () => {
      const result = await extract(`
def test_create_user():
    user = User(name="test")
    assert user.name == "test"

def test_delete_user():
    pass
      `);
      expect(result.frameworkRole).toBe('pytest_test');
      const tests = result.symbols!.filter((s) => s.metadata?.pytest_test);
      expect(tests.length).toBe(2);
      expect(tests.map((t) => t.name)).toContain('test_create_user');
      expect(tests.map((t) => t.name)).toContain('test_delete_user');
    });

    it('extracts async test functions', async () => {
      const result = await extract(`
import pytest

async def test_async_fetch():
    result = await fetch_data()
    assert result is not None
      `);
      const test = result.symbols!.find((s) => s.name === 'test_async_fetch');
      expect(test).toBeDefined();
      expect(test!.metadata?.async).toBe(true);
    });
  });

  // ─── Test classes ──────────────────────────────────────────

  describe('test classes', () => {
    it('extracts Test* class methods', async () => {
      const result = await extract(`
class TestUserService:
    def test_create(self):
        pass

    def test_update(self):
        pass

    def helper_method(self):
        pass
      `);
      const tests = result.symbols!.filter((s) => s.metadata?.pytest_test);
      expect(tests.length).toBe(2);
      expect(tests[0].metadata?.testClass).toBe('TestUserService');
    });
  });

  // ─── Markers ───────────────────────────────────────────────

  describe('pytest markers', () => {
    it('extracts pytest.mark.skip', async () => {
      const result = await extract(`
import pytest

@pytest.mark.skip(reason="not implemented")
def test_future_feature():
    pass
      `);
      const test = result.symbols!.find((s) => s.name === 'test_future_feature');
      expect(test).toBeDefined();
      expect(test!.metadata?.markers).toContain('skip');
      expect(test!.metadata?.skipped).toBe(true);
    });

    it('extracts pytest.mark.xfail', async () => {
      const result = await extract(`
import pytest

@pytest.mark.xfail
def test_known_bug():
    pass
      `);
      const test = result.symbols!.find((s) => s.name === 'test_known_bug');
      expect(test!.metadata?.markers).toContain('xfail');
      expect(test!.metadata?.expectedFailure).toBe(true);
    });

    it('extracts pytest.mark.parametrize', async () => {
      const result = await extract(`
import pytest

@pytest.mark.parametrize("input,expected", [(1, 2), (3, 4)])
def test_increment(input, expected):
    assert input + 1 == expected
      `);
      const test = result.symbols!.find((s) => s.name === 'test_increment');
      expect(test!.metadata?.markers).toContain('parametrize');
      expect(test!.metadata?.parametrize).toBe('input,expected');
    });
  });

  // ─── Fixtures ──────────────────────────────────────────────

  describe('fixtures', () => {
    it('extracts conftest.py fixtures', async () => {
      const result = await extract(
        `
import pytest

@pytest.fixture
def db_session():
    session = create_session()
    yield session
    session.close()

@pytest.fixture(scope="module")
def app():
    return create_app()
      `,
        'tests/conftest.py',
      );

      expect(result.frameworkRole).toBe('conftest');
      const fixtures = result.symbols!.filter((s) => s.metadata?.pytest_fixture);
      expect(fixtures.length).toBe(2);

      const dbSession = fixtures.find((f) => f.name === 'db_session');
      expect(dbSession).toBeDefined();
      expect(dbSession!.metadata?.scope).toBe('function');

      const app = fixtures.find((f) => f.name === 'app');
      expect(app).toBeDefined();
      expect(app!.metadata?.scope).toBe('module');
    });

    it('extracts autouse fixtures', async () => {
      const result = await extract(
        `
import pytest

@pytest.fixture(autouse=True, scope="session")
def setup_logging():
    configure_logging()
      `,
        'tests/conftest.py',
      );

      const fix = result.symbols!.find((s) => s.name === 'setup_logging');
      expect(fix).toBeDefined();
      expect(fix!.metadata?.autouse).toBe(true);
      expect(fix!.metadata?.scope).toBe('session');
    });

    it('extracts inline fixtures in test files', async () => {
      const result = await extract(`
import pytest

@pytest.fixture
def user():
    return User(name="test")

def test_user_name(user):
    assert user.name == "test"
      `);
      const fixtures = result.symbols!.filter((s) => s.metadata?.pytest_fixture);
      expect(fixtures.length).toBe(1);
      expect(fixtures[0].name).toBe('user');
    });
  });

  // ─── File path detection ───────────────────────────────────

  describe('file path patterns', () => {
    it('recognizes test_ prefix files', async () => {
      const result = await extract(`def test_foo(): pass`, 'test_main.py');
      expect(result.symbols!.length).toBeGreaterThan(0);
    });

    it('recognizes _test suffix files', async () => {
      const result = await extract(`def test_foo(): pass`, 'main_test.py');
      expect(result.symbols!.length).toBeGreaterThan(0);
    });

    it('recognizes tests/ directory', async () => {
      const result = await extract(`def test_foo(): pass`, 'tests/unit/test_users.py');
      expect(result.symbols!.length).toBeGreaterThan(0);
    });
  });
});
