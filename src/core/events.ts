import { EventEmitter } from 'node:events';
import type { DB } from './db';

export interface MFEvent {
  id?: number;
  ts?: string;
  kind: string;
  agent?: string;
  data: Record<string, unknown>;
}

/** In-process event bus feeding the dashboard (SSE) and the `events` table (last ~2000 kept). */
export class EventBus extends EventEmitter {
  private insert;
  private prune;
  private n = 0;
  constructor(private db: DB) {
    super();
    this.setMaxListeners(100);
    this.insert = db.prepare('INSERT INTO events (kind, agent, data) VALUES (?, ?, ?)');
    this.prune = db.prepare('DELETE FROM events WHERE id < (SELECT MAX(id) - 2000 FROM events)');
  }
  /** Persisted events (dashboard history). */
  publish(kind: string, agent: string | undefined, data: Record<string, unknown>) {
    const info = this.insert.run(kind, agent ?? null, JSON.stringify(data));
    const ev: MFEvent = { id: Number(info.lastInsertRowid), ts: new Date().toISOString(), kind, agent, data };
    if (++this.n % 200 === 0) this.prune.run();
    this.emit('event', ev);
    return ev;
  }
  /** Transient events (render progress ticks) — streamed, not stored. */
  transient(kind: string, agent: string | undefined, data: Record<string, unknown>) {
    this.emit('event', { ts: new Date().toISOString(), kind, agent, data } satisfies MFEvent);
  }
  recent(limit = 100, kinds?: string[]): MFEvent[] {
    const rows = kinds?.length
      ? this.db
          .prepare(`SELECT * FROM events WHERE kind IN (${kinds.map(() => '?').join(',')}) ORDER BY id DESC LIMIT ?`)
          .all(...kinds, limit)
      : this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
    return (rows as any[]).map((r) => ({ id: r.id, ts: r.ts, kind: r.kind, agent: r.agent ?? undefined, data: JSON.parse(r.data) }));
  }
}
