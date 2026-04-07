/**
 * Tests for laravel/cashier extraction.
 */
import { describe, it, expect } from 'vitest';
import {
  extractBillableModel,
  extractCashierWebhook,
  buildBillableModelEdges,
} from '../../../src/indexer/plugins/integration/framework/laravel/cashier.js';

// ─── Billable model ──────────────────────────────────────────

const BILLABLE_MODEL = `<?php

namespace App\\Models;

use Illuminate\\Foundation\\Auth\\User as Authenticatable;
use Laravel\\Cashier\\Billable;

class User extends Authenticatable
{
    use Billable;

    public function subscribe()
    {
        return $this->newSubscription('default', 'price_basic')
            ->create($paymentMethod);
    }

    public function chargeOnce()
    {
        return $this->charge(1000, $paymentMethod);
    }
}`;

describe('cashier — Billable model extraction', () => {
  const info = extractBillableModel(BILLABLE_MODEL, 'app/Models/User.php');

  it('detects Billable trait', () => {
    expect(info).not.toBeNull();
    expect(info!.hasBillable).toBe(true);
  });

  it('extracts class name and FQN', () => {
    expect(info!.className).toBe('User');
    expect(info!.fqn).toBe('App\\Models\\User');
  });

  it('detects subscription methods', () => {
    expect(info!.subscriptionMethods).toContain('newSubscription');
  });

  it('detects charge methods', () => {
    expect(info!.chargeMethods).toContain('charge');
  });

  it('builds edges', () => {
    const edges = buildBillableModelEdges(info!);
    expect(edges.length).toBeGreaterThanOrEqual(1);
    const billableEdge = edges.find(e => e.edgeType === 'cashier_billable');
    expect(billableEdge).toBeDefined();
    expect(billableEdge!.metadata.modelFqn).toBe('App\\Models\\User');
  });

  it('builds subscription edges', () => {
    const edges = buildBillableModelEdges(info!);
    const subEdges = edges.filter(e => e.edgeType === 'cashier_subscription');
    expect(subEdges.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Webhook detection ───────────────────────────────────────

describe('cashier — webhook detection', () => {
  it('detects WebhookController usage', () => {
    const source = `Route::post('/stripe/webhook', [\\Laravel\\Cashier\\Http\\Controllers\\WebhookController::class, 'handleWebhook']);`;
    expect(extractCashierWebhook(source)).toBe('stripe_webhook');
  });

  it('detects cashier.webhook named route', () => {
    const source = `Route::post('/stripe/webhook', 'WebhookController')->name('cashier.webhook');`;
    expect(extractCashierWebhook(source)).toBe('stripe_webhook');
  });

  it('detects stripe/webhook path', () => {
    const source = `Route::post('stripe/webhook', [WebhookController::class, 'handle']);`;
    expect(extractCashierWebhook(source)).toBe('stripe_webhook');
  });

  it('returns null for unrelated routes', () => {
    const source = `Route::get('/users', [UserController::class, 'index']);`;
    expect(extractCashierWebhook(source)).toBeNull();
  });
});

// ─── Non-Billable model ──────────────────────────────────────

describe('cashier — non-Billable model', () => {
  it('returns null for model without Billable', () => {
    const source = `<?php\nnamespace App\\Models;\nclass Post extends Model\n{\n    use HasFactory;\n}`;
    expect(extractBillableModel(source, 'app/Models/Post.php')).toBeNull();
  });
});
