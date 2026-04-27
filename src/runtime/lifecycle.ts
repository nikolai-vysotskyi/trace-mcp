/**
 * Runtime Intelligence lifecycle — orchestrates OTLP receiver, ingestion, mapping, aggregation.
 */

import type { Store } from '../db/store.js';
import { OtlpReceiver } from './otlp-receiver.js';
import { SpanIngester } from './ingest.js';
import { SpanMapper } from './mapper.js';
import { RuntimeAggregator } from './aggregator.js';
import { logger } from '../logger.js';

interface RuntimeConfig {
  enabled: boolean;
  otlp: {
    port: number;
    host: string;
    max_body_bytes: number;
  };
  retention: {
    max_span_age_days: number;
    max_aggregate_age_days: number;
    prune_interval: number;
  };
  mapping: {
    fqn_attributes: string[];
    route_patterns: string[];
  };
}

export class RuntimeIntelligence {
  private receiver: OtlpReceiver | null = null;
  private ingester: SpanIngester;
  private mapper: SpanMapper;
  private aggregator: RuntimeAggregator;

  constructor(store: Store,
    private config: RuntimeConfig,
  ) {
    this.ingester = new SpanIngester(store.db, config.retention.prune_interval);
    this.mapper = new SpanMapper(store, {
      fqnAttributes: config.mapping.fqn_attributes,
      routePatterns: config.mapping.route_patterns.map((p) => new RegExp(p)),
    });
    this.aggregator = new RuntimeAggregator(store.db);
  }

  async start(): Promise<void> {
    this.receiver = new OtlpReceiver({
      host: this.config.otlp.host,
      port: this.config.otlp.port,
      maxBodyBytes: this.config.otlp.max_body_bytes,
      onSpans: (request) => {
        // Process asynchronously so the HTTP handler responds immediately
        setImmediate(() => {
          try {
            const result = this.ingester.ingest(request);

            // Map spans to code after ingestion
            if (result.spans > 0) {
              try {
                this.mapper.mapUnmapped();
              } catch (e) {
                logger.warn({ error: e }, 'Span mapping failed, will retry next batch');
              }
              try {
                this.aggregator.aggregate();
              } catch (e) {
                logger.warn({ error: e }, 'Aggregation failed, will retry next batch');
              }
            }
          } catch (e) {
            logger.error({ error: e }, 'Failed to process OTLP spans');
          }
        });
      },
    });

    await this.receiver.start();
    logger.info('Runtime Intelligence started');
  }

  async stop(): Promise<void> {
    if (this.receiver) {
      await this.receiver.stop();
    }
    logger.info('Runtime Intelligence stopped');
  }

  /** Manual trigger for mapping unmapped spans */
  mapUnmapped(limit?: number): number {
    return this.mapper.mapUnmapped(limit);
  }

  /** Manual trigger for aggregation */
  aggregate(since?: string): { bucketsUpdated: number; nodesAffected: number } {
    return this.aggregator.aggregate(since);
  }

  /** Manual prune */
  prune(): { spans: number; aggregates: number; traces: number } {
    return this.ingester.prune(
      this.config.retention.max_span_age_days,
      this.config.retention.max_aggregate_age_days,
    );
  }
}
