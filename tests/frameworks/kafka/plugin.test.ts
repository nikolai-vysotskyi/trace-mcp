/**
 * Tests for the Kafka plugin — Spring Kafka, kafkajs, and Python.
 *
 * The plugin's job is to surface a producer→topic→consumer model. The
 * tests below assert each construct we recognise and that the resulting
 * edge metadata carries enough context (topic name + source kind) for
 * downstream tooling to build the cross-service graph.
 */
import { describe, expect, it } from 'vitest';
import {
  extractKafkaRefs,
  KafkaPlugin,
} from '../../../src/indexer/plugins/integration/messaging/kafka/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

function makeCtx(overrides: Partial<ProjectContext> = {}): ProjectContext {
  return {
    rootPath: '/tmp/no-such',
    configFiles: [],
    ...overrides,
  };
}

describe('KafkaPlugin — detection', () => {
  it('detects via kafkajs in package.json', () => {
    const plugin = new KafkaPlugin();
    expect(plugin.detect(makeCtx({ packageJson: { dependencies: { kafkajs: '^2.0.0' } } }))).toBe(
      true,
    );
  });

  it('rejects without Kafka deps', () => {
    const plugin = new KafkaPlugin();
    expect(plugin.detect(makeCtx({ packageJson: { dependencies: { lodash: '*' } } }))).toBe(false);
  });
});

describe('KafkaPlugin — schema', () => {
  it('registers kafka_consumes and kafka_produces edge types', () => {
    const schema = new KafkaPlugin().registerSchema();
    const names = schema.edgeTypes?.map((e) => e.name) ?? [];
    expect(names).toContain('kafka_consumes');
    expect(names).toContain('kafka_produces');
  });
});

describe('extractKafkaRefs — Java/Spring Kafka', () => {
  it('picks up @KafkaListener single-topic', () => {
    const refs = extractKafkaRefs(
      `@KafkaListener(topics = "orders") public void handle(Order o) {}`,
      'java',
    );
    expect(refs).toEqual([{ topic: 'orders', direction: 'consumes', source: 'kafka_listener' }]);
  });

  it('picks up @KafkaListener multi-topic', () => {
    const refs = extractKafkaRefs(
      `@KafkaListener(topics = {"orders", "payments"}) public void handle(Object o) {}`,
      'java',
    );
    expect(refs.map((r) => r.topic).sort()).toEqual(['orders', 'payments']);
    for (const r of refs) {
      expect(r.direction).toBe('consumes');
      expect(r.source).toBe('kafka_listener');
    }
  });

  it('picks up @KafkaListener topicPattern as a pattern', () => {
    const refs = extractKafkaRefs(
      `@KafkaListener(topicPattern = "orders\\\\..*") public void handle() {}`,
      'java',
    );
    expect(refs).toHaveLength(1);
    expect(refs[0].pattern).toBe(true);
  });

  it('picks up KafkaTemplate.send literals', () => {
    const refs = extractKafkaRefs(`kafkaTemplate.send("orders", payload);`, 'java');
    expect(refs).toEqual([
      { topic: 'orders', direction: 'produces', source: 'kafka_template_send' },
    ]);
  });
});

describe('extractKafkaRefs — kafkajs (TypeScript)', () => {
  it('picks up consumer.subscribe single-topic', () => {
    const refs = extractKafkaRefs(
      `await consumer.subscribe({ topic: 'orders', fromBeginning: true });`,
      'typescript',
    );
    expect(refs).toEqual([{ topic: 'orders', direction: 'consumes', source: 'kafkajs_subscribe' }]);
  });

  it('picks up consumer.subscribe topics list', () => {
    const refs = extractKafkaRefs(
      `await consumer.subscribe({ topics: ['orders', 'payments'] });`,
      'typescript',
    );
    expect(refs.map((r) => r.topic).sort()).toEqual(['orders', 'payments']);
  });

  it('picks up producer.send', () => {
    const refs = extractKafkaRefs(
      `await producer.send({ topic: 'orders', messages: [{ value: 'x' }] });`,
      'typescript',
    );
    expect(refs).toEqual([{ topic: 'orders', direction: 'produces', source: 'kafkajs_send' }]);
  });
});

describe('extractKafkaRefs — Python', () => {
  it('picks up consumer.subscribe([...])', () => {
    const refs = extractKafkaRefs(`consumer.subscribe(['orders', 'payments'])`, 'python');
    expect(refs.map((r) => r.topic).sort()).toEqual(['orders', 'payments']);
    for (const r of refs) expect(r.source).toBe('py_subscribe');
  });

  it('picks up producer.produce("topic", ...)', () => {
    const refs = extractKafkaRefs(`producer.produce('orders', value)`, 'python');
    expect(refs).toEqual([{ topic: 'orders', direction: 'produces', source: 'py_produce' }]);
  });
});

describe('extractKafkaRefs — dedupe', () => {
  it('coalesces repeated identical refs from the same file', () => {
    const refs = extractKafkaRefs(
      `kafkaTemplate.send("orders", a);\nkafkaTemplate.send("orders", b);\nkafkaTemplate.send("orders", c);`,
      'java',
    );
    expect(refs).toHaveLength(1);
  });
});

describe('KafkaPlugin.extractNodes — full integration', () => {
  it('emits kafka_consumes + KAFKA_CONSUME route for a Spring listener', async () => {
    const source = `
      @Service
      public class OrderConsumer {
        @KafkaListener(topics = "orders")
        public void onOrder(Order o) { ... }
      }
    `;
    const result = await new KafkaPlugin().extractNodes(
      'OrderConsumer.java',
      Buffer.from(source),
      'java',
    );
    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();
    expect(parsed.frameworkRole).toBe('kafka_consumer');
    expect(parsed.routes).toEqual([{ method: 'KAFKA_CONSUME', uri: 'orders' }]);
    expect(parsed.edges?.[0].edgeType).toBe('kafka_consumes');
    expect(parsed.edges?.[0].metadata).toMatchObject({
      topic: 'orders',
      source: 'kafka_listener',
      pattern: false,
    });
  });

  it('emits kafka_produces + KAFKA_PRODUCE route for kafkajs producer', async () => {
    const source = `await producer.send({ topic: 'orders', messages: [...] });`;
    const result = await new KafkaPlugin().extractNodes(
      'src/producer.ts',
      Buffer.from(source),
      'typescript',
    );
    const parsed = result._unsafeUnwrap();
    expect(parsed.frameworkRole).toBe('kafka_producer');
    expect(parsed.routes).toEqual([{ method: 'KAFKA_PRODUCE', uri: 'orders' }]);
    expect(parsed.edges?.[0].edgeType).toBe('kafka_produces');
  });

  it('returns empty result for unsupported languages', async () => {
    const result = await new KafkaPlugin().extractNodes('a.go', Buffer.from('whatever'), 'go');
    const parsed = result._unsafeUnwrap();
    expect(parsed.symbols).toEqual([]);
  });
});
