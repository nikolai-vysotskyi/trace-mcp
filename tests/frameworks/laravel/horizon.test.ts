/**
 * Tests for laravel/horizon extraction.
 */
import { describe, expect, it } from 'vitest';
import {
  buildHorizonConfigEdges,
  buildHorizonConfigSymbols,
  buildHorizonJobEdges,
  extractHorizonConfig,
  extractHorizonJob,
} from '../../../src/indexer/plugins/integration/framework/laravel/horizon.js';

// ─── Horizon Config ──────────────────────────────────────────

const HORIZON_CONFIG = `<?php

return [
    'use' => 'default',
    'prefix' => 'horizon:',
    'path' => 'horizon',
    'waits' => ['redis:default' => 60],

    'environments' => [
        'production' => [
            'supervisor-1' => [
                'connection' => 'redis',
                'queue' => ['default', 'emails'],
                'balance' => 'auto',
                'processes' => 10,
                'tries' => 3,
                'timeout' => 60,
            ],
            'supervisor-2' => [
                'connection' => 'redis',
                'queue' => ['high-priority'],
                'balance' => 'simple',
                'processes' => 5,
            ],
        ],
        'local' => [
            'supervisor-1' => [
                'connection' => 'redis',
                'queue' => ['default'],
                'balance' => 'simple',
                'processes' => 3,
            ],
        ],
    ],
];`;

describe('horizon — config extraction', () => {
  const config = extractHorizonConfig(HORIZON_CONFIG);

  it('detects horizon config', () => {
    expect(config).not.toBeNull();
  });

  it('extracts environments', () => {
    expect(config!.environments).toHaveLength(2);
    expect(config!.environments.map((e) => e.name)).toContain('production');
    expect(config!.environments.map((e) => e.name)).toContain('local');
  });

  it('extracts supervisors', () => {
    const prod = config!.environments.find((e) => e.name === 'production')!;
    expect(prod.supervisors).toHaveLength(2);
    expect(prod.supervisors[0].name).toBe('supervisor-1');
    expect(prod.supervisors[0].queues).toEqual(['default', 'emails']);
    expect(prod.supervisors[0].balance).toBe('auto');
    expect(prod.supervisors[0].processes).toBe(10);
  });

  it('builds config edges', () => {
    const edges = buildHorizonConfigEdges(config!);
    expect(edges.length).toBeGreaterThanOrEqual(3);
    const queueEdge = edges.find((e) => e.metadata.queue === 'emails');
    expect(queueEdge).toBeDefined();
    expect(queueEdge!.edgeType).toBe('horizon_supervises_queue');
  });

  it('builds config symbols', () => {
    const symbols = buildHorizonConfigSymbols(config!);
    expect(symbols.length).toBeGreaterThanOrEqual(3);
    const sup1 = symbols.find((s) => s.name === 'production:supervisor-1');
    expect(sup1).toBeDefined();
    expect(sup1!.metadata!.frameworkRole).toBe('horizon_supervisor');
  });
});

// ─── Job extraction ──────────────────────────────────────────

const JOB_SOURCE = `<?php

namespace App\\Jobs;

use Illuminate\\Bus\\Queueable;
use Illuminate\\Contracts\\Queue\\ShouldQueue;
use Illuminate\\Foundation\\Bus\\Dispatchable;

class ProcessPayment implements ShouldQueue
{
    use Dispatchable, Queueable;

    public $queue = 'payments';
    public $connection = 'redis';
    public $tries = 5;
    public $timeout = 120;
    public $uniqueFor = 3600;

    public function handle(): void
    {
        // process payment
    }
}`;

describe('horizon — job extraction', () => {
  const info = extractHorizonJob(JOB_SOURCE, 'app/Jobs/ProcessPayment.php');

  it('detects ShouldQueue job', () => {
    expect(info).not.toBeNull();
  });

  it('extracts class name and FQN', () => {
    expect(info!.className).toBe('ProcessPayment');
    expect(info!.fqn).toBe('App\\Jobs\\ProcessPayment');
  });

  it('extracts queue name', () => {
    expect(info!.queue).toBe('payments');
  });

  it('extracts connection', () => {
    expect(info!.connection).toBe('redis');
  });

  it('extracts tries', () => {
    expect(info!.tries).toBe(5);
  });

  it('extracts timeout', () => {
    expect(info!.timeout).toBe(120);
  });

  it('extracts uniqueFor', () => {
    expect(info!.uniqueFor).toBe(3600);
  });

  it('builds job edges', () => {
    const edges = buildHorizonJobEdges(info!);
    expect(edges).toHaveLength(2);
    expect(edges[0].edgeType).toBe('horizon_job_on_queue');
    expect(edges[0].metadata.queue).toBe('payments');
    expect(edges[1].edgeType).toBe('horizon_job_connection');
  });
});

describe('horizon — non-queue class', () => {
  it('returns null for non-ShouldQueue class', () => {
    const source = `<?php\nnamespace App\\Models;\nclass User extends Model {}`;
    expect(extractHorizonJob(source, 'app/Models/User.php')).toBeNull();
  });
});
