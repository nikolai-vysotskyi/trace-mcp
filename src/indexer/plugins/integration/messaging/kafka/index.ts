/**
 * Kafka plugin — extracts producer/consumer relationships into a topic graph.
 *
 * Borrowed from CRG v2.3.3 (#383). Event-driven architectures usually have
 * one or two services that produce a topic and several others that consume
 * it; without a producer→topic→consumer edge model the graph misses the
 * actual flow of work between services. We emit two edge types:
 *
 *   kafka_consumes — a method or function reads a topic
 *   kafka_produces — a method or function writes a topic
 *
 * Topics are surfaced as routes (method='KAFKA_TOPIC', uri=<topic>) so the
 * existing route tooling can list them. The metadata on each edge carries
 * the topic name plus a hint about the construct that surfaced it
 * (annotation / api call / subscribe / produce).
 *
 * Supported source shapes:
 *
 *   Java/Kotlin (Spring Kafka):
 *     @KafkaListener(topics = "orders")
 *     @KafkaListener(topicPattern = "orders\\..*")
 *     kafkaTemplate.send("orders", payload)
 *
 *   JavaScript/TypeScript (kafkajs):
 *     consumer.subscribe({ topic: 'orders' })
 *     consumer.subscribe({ topics: ['orders', 'payments'] })
 *     producer.send({ topic: 'orders', messages: [...] })
 *     producer.sendBatch({ topicMessages: [{ topic: 'orders', ... }] })
 *
 *   Python (confluent-kafka, kafka-python):
 *     consumer.subscribe(['orders'])
 *     producer.produce('orders', ...)
 *     producer.send('orders', ...)
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok, type TraceMcpResult } from '../../../../../errors.js';
import type {
  FileParseResult,
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
} from '../../../../../plugin-api/types.js';

// ─── Java / Kotlin (Spring Kafka) ─────────────────────────────────────────

// @KafkaListener(topics = "orders") OR @KafkaListener(topics = {"a","b"})
const KAFKA_LISTENER_TOPICS_RE = /@KafkaListener\s*\([^)]*?topics\s*=\s*(?:\{([^}]+)\}|"([^"]+)")/g;
// @KafkaListener(topicPattern = "orders\\..*")
const KAFKA_LISTENER_PATTERN_RE = /@KafkaListener\s*\([^)]*?topicPattern\s*=\s*"([^"]+)"/g;
// kafkaTemplate.send("orders", payload) — receiver name is heuristic
const KAFKA_TEMPLATE_SEND_RE =
  /\b\w*[Kk]afka(?:Template)?\b\s*\.\s*send(?:Default)?\s*\(\s*"([^"]+)"/g;

// ─── JavaScript / TypeScript (kafkajs) ────────────────────────────────────

// consumer.subscribe({ topic: 'orders' })
const KAFKAJS_SUBSCRIBE_SINGLE_RE =
  /\.\s*subscribe\s*\(\s*\{[^}]*?\btopic\s*:\s*['"`]([^'"`]+)['"`]/g;
// consumer.subscribe({ topics: ['a', 'b'] })
const KAFKAJS_SUBSCRIBE_LIST_RE = /\.\s*subscribe\s*\(\s*\{[^}]*?\btopics\s*:\s*\[([^\]]+)\]/g;
// producer.send({ topic: 'orders', messages: [...] })
const KAFKAJS_SEND_RE = /\.\s*send\s*\(\s*\{[^}]*?\btopic\s*:\s*['"`]([^'"`]+)['"`]/g;
// producer.sendBatch({ topicMessages: [{ topic: 'orders', ... }] })
const KAFKAJS_SEND_BATCH_RE =
  /\.\s*sendBatch\s*\(\s*\{[^}]*?topicMessages[^}]*?topic\s*:\s*['"`]([^'"`]+)['"`]/gs;

// ─── Python (confluent-kafka, kafka-python) ───────────────────────────────

// consumer.subscribe(['orders']) OR consumer.subscribe(["orders", "payments"])
const PY_SUBSCRIBE_RE = /\.\s*subscribe\s*\(\s*\[([^\]]+)\]/g;
// producer.produce('orders', ...) OR producer.send('orders', ...)
const PY_PRODUCE_RE = /\.\s*(?:produce|send)\s*\(\s*['"]([^'"]+)['"]\s*,/g;

// ─── Helpers ──────────────────────────────────────────────────────────────

function splitQuoted(list: string): string[] {
  // Pull every quoted string from a list expression: "a","b" or 'a','b'
  const out: string[] = [];
  const re = /['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(list)) !== null) out.push(m[1]);
  return out;
}

export interface KafkaTopicRef {
  topic: string;
  direction: 'consumes' | 'produces';
  /** What construct surfaced the topic — useful for downstream filtering. */
  source:
    | 'kafka_listener'
    | 'kafka_template_send'
    | 'kafkajs_subscribe'
    | 'kafkajs_send'
    | 'kafkajs_send_batch'
    | 'py_subscribe'
    | 'py_produce';
  /** Set when the topic is a regex pattern, not a literal name. */
  pattern?: boolean;
}

export function extractKafkaRefs(source: string, language: string): KafkaTopicRef[] {
  const refs: KafkaTopicRef[] = [];

  if (language === 'java' || language === 'kotlin') {
    let m: RegExpExecArray | null;

    const topicsRe = new RegExp(KAFKA_LISTENER_TOPICS_RE.source, 'g');
    while ((m = topicsRe.exec(source)) !== null) {
      const list = m[1] ?? null;
      const single = m[2] ?? null;
      const topics = list ? splitQuoted(list) : single ? [single] : [];
      for (const t of topics)
        refs.push({ topic: t, direction: 'consumes', source: 'kafka_listener' });
    }

    const patternRe = new RegExp(KAFKA_LISTENER_PATTERN_RE.source, 'g');
    while ((m = patternRe.exec(source)) !== null) {
      refs.push({
        topic: m[1],
        direction: 'consumes',
        source: 'kafka_listener',
        pattern: true,
      });
    }

    const sendRe = new RegExp(KAFKA_TEMPLATE_SEND_RE.source, 'g');
    while ((m = sendRe.exec(source)) !== null) {
      refs.push({ topic: m[1], direction: 'produces', source: 'kafka_template_send' });
    }
  } else if (
    language === 'typescript' ||
    language === 'javascript' ||
    language === 'tsx' ||
    language === 'jsx'
  ) {
    let m: RegExpExecArray | null;

    const subSingleRe = new RegExp(KAFKAJS_SUBSCRIBE_SINGLE_RE.source, 'g');
    while ((m = subSingleRe.exec(source)) !== null) {
      refs.push({ topic: m[1], direction: 'consumes', source: 'kafkajs_subscribe' });
    }

    const subListRe = new RegExp(KAFKAJS_SUBSCRIBE_LIST_RE.source, 'g');
    while ((m = subListRe.exec(source)) !== null) {
      for (const t of splitQuoted(m[1])) {
        refs.push({ topic: t, direction: 'consumes', source: 'kafkajs_subscribe' });
      }
    }

    const sendRe = new RegExp(KAFKAJS_SEND_RE.source, 'g');
    while ((m = sendRe.exec(source)) !== null) {
      refs.push({ topic: m[1], direction: 'produces', source: 'kafkajs_send' });
    }

    const sendBatchRe = new RegExp(KAFKAJS_SEND_BATCH_RE.source, 'gs');
    while ((m = sendBatchRe.exec(source)) !== null) {
      refs.push({ topic: m[1], direction: 'produces', source: 'kafkajs_send_batch' });
    }
  } else if (language === 'python') {
    let m: RegExpExecArray | null;

    const subRe = new RegExp(PY_SUBSCRIBE_RE.source, 'g');
    while ((m = subRe.exec(source)) !== null) {
      for (const t of splitQuoted(m[1])) {
        refs.push({ topic: t, direction: 'consumes', source: 'py_subscribe' });
      }
    }

    const produceRe = new RegExp(PY_PRODUCE_RE.source, 'g');
    while ((m = produceRe.exec(source)) !== null) {
      refs.push({ topic: m[1], direction: 'produces', source: 'py_produce' });
    }
  }

  // Deduplicate per (topic,direction,source) so a noisy file doesn't
  // produce 50 identical edges.
  const seen = new Set<string>();
  return refs.filter((r) => {
    const k = `${r.direction}|${r.topic}|${r.source}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ─── Plugin ───────────────────────────────────────────────────────────────

export class KafkaPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'kafka',
    version: '1.0.0',
    priority: 30,
    category: 'messaging',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    // Node — kafkajs / @kafkajs/* in package.json.
    const deps = readDeps(ctx);
    if (
      deps &&
      ('kafkajs' in deps || 'kafka-node' in deps || '@confluentinc/kafka-javascript' in deps)
    ) {
      return true;
    }

    // Python / Java — scan manifests for kafka markers.
    for (const f of ctx.configFiles ?? []) {
      const lower = f.toLowerCase();
      if (lower.endsWith('requirements.txt') || lower.endsWith('pyproject.toml')) {
        if (readContains(ctx.rootPath, f, /\bkafka(-python)?|confluent-kafka\b/i)) return true;
      }
      if (lower === 'pom.xml' || lower.startsWith('build.gradle')) {
        if (readContains(ctx.rootPath, f, /spring-kafka|org\.apache\.kafka|kafka-clients/i)) {
          return true;
        }
      }
    }
    return false;
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 'kafka_consumes',
          category: 'messaging',
          description: 'A method/function consumes messages from a Kafka topic',
        },
        {
          name: 'kafka_produces',
          category: 'messaging',
          description: 'A method/function produces messages to a Kafka topic',
        },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (
      language !== 'java' &&
      language !== 'kotlin' &&
      language !== 'typescript' &&
      language !== 'javascript' &&
      language !== 'tsx' &&
      language !== 'jsx' &&
      language !== 'python'
    ) {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const refs = extractKafkaRefs(source, language);
    if (refs.length === 0) return ok({ status: 'ok', symbols: [] });

    const result: FileParseResult = {
      status: 'ok',
      symbols: [],
      routes: [],
      edges: [],
      frameworkRole: refs.some((r) => r.direction === 'produces')
        ? 'kafka_producer'
        : 'kafka_consumer',
    };

    // Surface every topic as a route so downstream tooling can list them.
    const seenTopics = new Set<string>();
    for (const ref of refs) {
      const key = `${ref.direction}|${ref.topic}`;
      if (seenTopics.has(key)) continue;
      seenTopics.add(key);
      result.routes!.push({
        method: ref.direction === 'consumes' ? 'KAFKA_CONSUME' : 'KAFKA_PRODUCE',
        uri: ref.topic,
      });
      result.edges!.push({
        edgeType: ref.direction === 'consumes' ? 'kafka_consumes' : 'kafka_produces',
        metadata: {
          topic: ref.topic,
          source: ref.source,
          pattern: ref.pattern ?? false,
        },
      });
    }

    return ok(result);
  }
}

function readDeps(ctx: ProjectContext): Record<string, string> | null {
  if (ctx.packageJson) {
    return {
      ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
      ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
    };
  }
  try {
    const pkgPath = path.join(ctx.rootPath, 'package.json');
    const content = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(content);
    return {
      ...(pkg.dependencies as Record<string, string> | undefined),
      ...(pkg.devDependencies as Record<string, string> | undefined),
    };
  } catch {
    return null;
  }
}

function readContains(rootPath: string, relFile: string, re: RegExp): boolean {
  try {
    const text = fs.readFileSync(path.join(rootPath, relFile), 'utf-8');
    return re.test(text);
  } catch {
    return false;
  }
}
