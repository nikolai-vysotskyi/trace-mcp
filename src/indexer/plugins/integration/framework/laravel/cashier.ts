/**
 * laravel/cashier (Stripe) extraction.
 *
 * Extracts:
 * - Models using Billable trait → edges to Stripe integration
 * - Webhook controller routes
 * - Subscription/payment method references
 * - Cashier config (cashier.php) — model mapping, currency, etc.
 */
import type { RawEdge } from '../../../../../plugin-api/types.js';

// ─── Interfaces ──────────────────────────────────────────────

export interface BillableModelInfo {
  className: string;
  fqn: string;
  hasBillable: boolean;
  subscriptionMethods: string[];
  chargeMethods: string[];
}

export interface CashierConfigInfo {
  model: string | null;
  currency: string | null;
  currencyLocale: string | null;
}

// ─── Detection ───────────────────────────────────────────────

const NAMESPACE_RE = /namespace\s+([\w\\]+)\s*;/;
const CLASS_NAME_RE = /class\s+(\w+)/;
const BILLABLE_RE = /use\s+(?:[\w\\]*\\)?Billable\b/;

// Subscription/charge method calls
const SUBSCRIPTION_METHODS = [
  'newSubscription', 'subscription', 'subscribed', 'onTrial',
  'subscribedToProduct', 'subscribedToPrice', 'onGenericTrial',
] as const;

const CHARGE_METHODS = [
  'charge', 'invoiceFor', 'tab', 'invoice', 'pay',
  'refund', 'createSetupIntent', 'updateDefaultPaymentMethod',
] as const;

// ─── Model extraction ────────────────────────────────────────

/**
 * Extract Billable trait usage from a model class.
 */
export function extractBillableModel(
  source: string,
  _filePath: string,
): BillableModelInfo | null {
  if (!BILLABLE_RE.test(source)) return null;
  if (!/class\s+\w+/.test(source)) return null;

  const nsMatch = source.match(NAMESPACE_RE);
  const namespace = nsMatch?.[1] ?? '';
  const classMatch = source.match(CLASS_NAME_RE);
  if (!classMatch) return null;
  const className = classMatch[1];
  const fqn = namespace ? `${namespace}\\${className}` : className;

  const subscriptionMethods: string[] = [];
  for (const method of SUBSCRIPTION_METHODS) {
    if (source.includes(method)) subscriptionMethods.push(method);
  }

  const chargeMethods: string[] = [];
  for (const method of CHARGE_METHODS) {
    if (source.includes(method)) chargeMethods.push(method);
  }

  return {
    className,
    fqn,
    hasBillable: true,
    subscriptionMethods,
    chargeMethods,
  };
}

/**
 * Extract Cashier webhook controller references.
 * Detects: Route::post for /stripe/webhook or WebhookController usage.
 */
export function extractCashierWebhook(source: string): string | null {
  // Check for WebhookController reference
  const webhookRe = /(?:Cashier|Laravel\\Cashier)\\Http\\Controllers\\WebhookController/;
  if (webhookRe.test(source)) return 'stripe_webhook';

  // Check for cashier.webhook route
  if (/['"]cashier\.webhook['"]/.test(source)) return 'stripe_webhook';
  if (/stripe\/webhook/.test(source)) return 'stripe_webhook';

  return null;
}

// ─── Config extraction ───────────────────────────────────────

/**
 * Extract cashier.php configuration.
 */
export function extractCashierConfig(source: string): CashierConfigInfo | null {
  if (!source.includes('cashier') && !source.includes('Cashier')) return null;

  const model = extractConfigString(source, 'model');
  const currency = extractConfigString(source, 'currency');
  const currencyLocale = extractConfigString(source, 'currency_locale');

  if (!model && !currency) return null;

  return { model, currency, currencyLocale };
}

// ─── Edge builders ───────────────────────────────────────────

export function buildBillableModelEdges(info: BillableModelInfo): RawEdge[] {
  const edges: RawEdge[] = [];

  edges.push({
    edgeType: 'cashier_billable',
    metadata: { modelFqn: info.fqn },
  });

  for (const method of info.subscriptionMethods) {
    edges.push({
      edgeType: 'cashier_subscription',
      metadata: { modelFqn: info.fqn, method },
    });
  }

  return edges;
}

// ─── Internal helpers ────────────────────────────────────────

function extractConfigString(source: string, key: string): string | null {
  const re = new RegExp(`['"]${key}['"]\\s*=>\\s*['"]([^'"]+)['"]`);
  return source.match(re)?.[1] ?? null;
}
