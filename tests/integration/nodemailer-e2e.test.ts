/**
 * nodemailer E2E integration test.
 * Asserts strict file → framework_role mapping across nodemailer/Resend/SendGrid,
 * and verifies that resolveEdges emits transport + send edges at symbol granularity.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { createTestStore } from '../test-utils.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { NodemailerPlugin } from '../../src/indexer/plugins/integration/tooling/nodemailer/index.js';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/nodemailer-app');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE,
    include: ['src/**/*.ts'],
    exclude: ['node_modules/**'],
    db: { path: ':memory:' },
    plugins: [],
  };
}

const EXPECTED_ROLES: Record<string, string> = {
  'src/transport.ts': 'email_transport',
  'src/mailer.ts': 'email_sender',
  'src/resend-sender.ts': 'email_sender',
  'src/sendgrid-sender.ts': 'email_sender',
};

interface EdgeWithMeta {
  meta: Record<string, unknown>;
  srcSymbolId: string | null;
}

function loadEdges(store: Store, edgeType: string): EdgeWithMeta[] {
  const edges = store.getEdgesByType(edgeType);
  return edges.map((e) => {
    const meta = e.metadata ? JSON.parse(e.metadata) : {};
    const node = store.db
      .prepare('SELECT node_type, ref_id FROM nodes WHERE id = ?')
      .get(e.source_node_id) as { node_type: string; ref_id: number } | undefined;
    let srcSymbolId: string | null = null;
    if (node?.node_type === 'symbol') {
      const s = store.db.prepare('SELECT symbol_id FROM symbols WHERE id = ?').get(node.ref_id) as
        | { symbol_id: string }
        | undefined;
      if (s) srcSymbolId = s.symbol_id;
    }
    return { meta, srcSymbolId };
  });
}

describe('nodemailer E2E', () => {
  let store: Store;
  let fileByRel: Map<string, { framework_role: string | null }>;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerFrameworkPlugin(new NodemailerPlugin());

    const pipeline = new IndexingPipeline(store, registry, makeConfig(), FIXTURE);
    await pipeline.indexAll();

    fileByRel = new Map();
    for (const f of store.getAllFiles()) {
      fileByRel.set(f.path.replace(/\\/g, '/'), f);
    }
  });

  describe('framework roles', () => {
    it('indexes every fixture file', () => {
      for (const rel of Object.keys(EXPECTED_ROLES)) {
        expect(fileByRel.has(rel), `missing ${rel}`).toBe(true);
      }
    });

    it.each(Object.entries(EXPECTED_ROLES))('tags %s with role %s', (rel, expectedRole) => {
      const file = fileByRel.get(rel);
      expect(file, `missing ${rel}`).toBeDefined();
      expect(file!.framework_role).toBe(expectedRole);
    });

    it('detects sending files that use a shared transport (no direct nodemailer import)', () => {
      expect(fileByRel.get('src/mailer.ts')!.framework_role).toBe('email_sender');
    });
  });

  describe('false-positive guards', () => {
    it('does not tag unrelated `.sendEmail()` methods as email_sender (postmark FP)', async () => {
      // Regression: previously POSTMARK_RE matched any `.sendEmail(` call,
      // so a class with a `sendEmail()` method got mis-tagged as email_sender
      // even when postmark wasn't imported.
      const { NodemailerPlugin: Plugin } = await import(
        '../../src/indexer/plugins/integration/tooling/nodemailer/index.js'
      );
      const plugin = new Plugin();
      const source = `class Notifier { sendEmail(to: string) { return to; } }\nnew Notifier().sendEmail('a');`;
      const result = await plugin.extractNodes!('fp-probe.ts', Buffer.from(source), 'typescript');
      expect(result.isOk()).toBe(true);
      const value = result._unsafeUnwrap();
      expect(value.frameworkRole).toBeUndefined();
    });
  });

  describe('edges', () => {
    it('emits email_transport edge with SMTP host from createTransport', () => {
      const edges = loadEdges(store, 'email_transport');
      const smtp = edges.find((e) => e.meta.kind === 'smtp');
      expect(smtp).toBeDefined();
      expect(smtp!.meta.host).toBe('smtp.example.com');
      expect(smtp!.srcSymbolId).toBe('src/transport.ts::transporter#variable');
    });

    it('emits email_transport provider edges for SaaS clients', () => {
      const edges = loadEdges(store, 'email_transport');
      const providers = edges
        .filter((e) => e.meta.kind === 'provider')
        .map((e) => e.meta.provider)
        .sort();
      expect(providers).toEqual(['resend', 'sendgrid']);
    });

    it('emits email_sends edges for every send call, attributed to its enclosing function', () => {
      const edges = loadEdges(store, 'email_sends');
      // Two nodemailer sendMail calls + one resend + one sendgrid.
      expect(edges).toHaveLength(4);

      const byProvider: Record<string, string[]> = {};
      for (const e of edges) {
        const p = e.meta.provider as string;
        (byProvider[p] ||= []).push(e.srcSymbolId!);
      }
      expect(byProvider.nodemailer.sort()).toEqual([
        'src/mailer.ts::sendPasswordReset#function',
        'src/mailer.ts::sendWelcomeEmail#function',
      ]);
      expect(byProvider.resend).toEqual(['src/resend-sender.ts::sendReceipt#function']);
      expect(byProvider.sendgrid).toEqual(['src/sendgrid-sender.ts::sendAlert#function']);
    });
  });
});
