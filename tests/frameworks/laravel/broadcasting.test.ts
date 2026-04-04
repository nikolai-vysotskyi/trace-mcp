/**
 * Tests for Laravel Broadcasting extraction.
 * Covers: ShouldBroadcast events, channel types, broadcastAs/With,
 * and routes/channels.php authorization parsing.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  extractBroadcastingEvent,
  extractChannelAuthorizations,
} from '../../../src/indexer/plugins/integration/framework/laravel/broadcasting.js';

const FIXTURE = path.resolve(__dirname, '../../fixtures/laravel-10');

function read(rel: string) {
  return fs.readFileSync(path.join(FIXTURE, rel), 'utf-8');
}

// ─── ShouldBroadcast event ────────────────────────────────────

describe('Broadcasting — OrderShipped event', () => {
  const source = read('app/Events/OrderShipped.php');
  const info = extractBroadcastingEvent(source, 'app/Events/OrderShipped.php');

  it('detects the broadcasting event', () => {
    expect(info).not.toBeNull();
  });

  it('extracts class name and FQN', () => {
    expect(info!.className).toBe('OrderShipped');
    expect(info!.fqn).toBe('App\\Events\\OrderShipped');
  });

  it('extracts private channel with concatenation', () => {
    const priv = info!.channels.find((c) => c.type === 'private');
    expect(priv).toBeDefined();
    expect(priv!.name).toContain('orders.');
  });

  it('extracts public channel', () => {
    const pub = info!.channels.find((c) => c.type === 'public');
    expect(pub).toBeDefined();
    expect(pub!.name).toBe('public-orders');
  });

  it('extracts broadcastAs() custom name', () => {
    expect(info!.broadcastAs).toBe('order.shipped');
  });

  it('extracts broadcastWith() payload fields', () => {
    expect(info!.payloadFields).toContain('id');
    expect(info!.payloadFields).toContain('status');
  });
});

// ─── Non-broadcasting event returns null ─────────────────────

describe('extractBroadcastingEvent — non-broadcasting files', () => {
  it('returns null for a regular event', () => {
    const source = `<?php
namespace App\\Events;
use Illuminate\\Foundation\\Events\\Dispatchable;
class UserCreated {
    use Dispatchable;
}`;
    expect(extractBroadcastingEvent(source, 'app/Events/UserCreated.php')).toBeNull();
  });

  it('detects ShouldBroadcastNow', () => {
    const source = `<?php
namespace App\\Events;
use Illuminate\\Contracts\\Broadcasting\\ShouldBroadcastNow;
class PingEvent implements ShouldBroadcastNow {
    public function broadcastOn(): array { return []; }
}`;
    expect(extractBroadcastingEvent(source, 'app/Events/PingEvent.php')).not.toBeNull();
  });
});

// ─── Channel authorization (channels.php) ────────────────────

describe('Broadcasting — channels.php authorization', () => {
  const source = read('routes/channels.php');
  const mappings = extractChannelAuthorizations(source);

  it('parses channel entries', () => {
    expect(mappings.length).toBeGreaterThanOrEqual(3);
  });

  it('detects closure-authorized channel', () => {
    const orders = mappings.find((m) => m.pattern === 'orders.{userId}');
    expect(orders).toBeDefined();
    expect(orders!.authClass).toBe('closure');
  });

  it('detects presence channel with closure', () => {
    const presence = mappings.find((m) => m.pattern === 'presence-chat.{roomId}');
    expect(presence).toBeDefined();
    expect(presence!.authClass).toBe('closure');
  });

  it('detects class-authorized channel', () => {
    const admin = mappings.find((m) => m.pattern === 'admin');
    expect(admin).toBeDefined();
    expect(admin!.authClass).toBe('App\\Broadcasting\\OrderChannel');
  });
});
