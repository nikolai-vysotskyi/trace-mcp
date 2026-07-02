/**
 * Event-channel operations — extracted from `TopologyStore` (god-class
 * decomposition). Owns the `event_channels` table surface: insert, per-service
 * lookup, and producer/consumer matching across services.
 *
 * Depends only on the raw `Database` handle; `TopologyStore` holds one instance
 * and delegates its public event methods to it verbatim.
 */

import type Database from 'better-sqlite3';
import type { EventChannelRow } from './topology-types.js';

export class EventOperations {
  constructor(private readonly db: Database.Database) {}

  insertEventChannels(
    contractId: number | null,
    serviceId: number,
    channels: Array<{
      channelName: string;
      direction: 'publish' | 'subscribe';
      payloadSchema?: string;
    }>,
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO event_channels (contract_id, service_id, channel_name, direction, payload_schema)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.db.transaction(() => {
      for (const ch of channels) {
        stmt.run(contractId, serviceId, ch.channelName, ch.direction, ch.payloadSchema ?? null);
      }
    })();
  }

  getEventsByService(serviceId: number): EventChannelRow[] {
    return this.db
      .prepare('SELECT * FROM event_channels WHERE service_id = ?')
      .all(serviceId) as EventChannelRow[];
  }

  matchProducersConsumers(): Array<{
    channel: string;
    publishers: string[];
    subscribers: string[];
  }> {
    const rows = this.db
      .prepare(`
      SELECT ec.channel_name, ec.direction, s.name as service_name
      FROM event_channels ec
      JOIN services s ON ec.service_id = s.id
      ORDER BY ec.channel_name
    `)
      .all() as Array<{ channel_name: string; direction: string; service_name: string }>;

    const map = new Map<string, { publishers: string[]; subscribers: string[] }>();
    for (const row of rows) {
      if (!map.has(row.channel_name))
        map.set(row.channel_name, { publishers: [], subscribers: [] });
      const entry = map.get(row.channel_name)!;
      if (row.direction === 'publish') entry.publishers.push(row.service_name);
      else entry.subscribers.push(row.service_name);
    }

    return [...map.entries()]
      .filter(([, v]) => v.publishers.length > 0 && v.subscribers.length > 0)
      .map(([channel, v]) => ({ channel, ...v }));
  }
}
