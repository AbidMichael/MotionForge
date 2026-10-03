import type { DB } from '../core/db';
import type { EventBus } from '../core/events';
import { notFound } from '../core/errors';
import { shortId } from '../core/util';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export type Lane = 'render' | 'fast';

export interface Job {
  id: string;
  type: string;
  status: JobStatus;
  priority: number;
  agent: string;
  comp_id: string | null;
  rev: number | null;
  params: Record<string, any>;
  progress: number;
  stage: string | null;
  result: Record<string, any> | null;
  error: string | null;
  created: string;
  started: string | null;
  finished: string | null;
  lane: Lane;
}

export interface JobCtx {
  progress: (p: number, stage?: string) => void;
  onCancel: (cb: () => void) => void;
  cancelled: () => boolean;
}

type Handler = (job: Job, ctx: JobCtx) => Promise<Record<string, any>>;

const LANE_OF: Record<string, Lane> = { render: 'render', preview: 'fast', thumb: 'fast' };

/** SQLite-backed job queue with two lanes: long renders, and fast previews/thumbnails that never wait behind them. */
export class JobQueue {
  private handlers = new Map<string, Handler>();
  private running = new Map<string, { cancel: (() => void)[]; cancelled: boolean }>();
  private waiters = new Map<string, ((j: Job) => void)[]>();
  private lastWrite = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private db: DB,
    private events: EventBus,
    private lanes: Record<Lane, number>,
    private log: (m: string) => void,
  ) {
    // crash safety: running jobs resume (finished segments are cached, so they continue where they stopped)
    this.db.prepare("UPDATE jobs SET status = 'queued', stage = 'resumed after restart' WHERE status = 'running'").run();
  }

  on(type: string, h: Handler) {
    this.handlers.set(type, h);
  }

  start() {
    if (!this.timer) this.timer = setInterval(() => this.pump(), 250);
    this.pump();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  enqueue(type: string, agent: string, params: Record<string, any>, o: { priority?: number; lane?: Lane; compId?: string; rev?: number } = {}): Job {
    const id = shortId(type === 'render' ? 'job' : type, 5);
    this.db
      .prepare('INSERT INTO jobs (id, type, status, priority, agent, comp_id, rev, params) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, type, 'queued', o.priority ?? 0, agent, o.compId ?? null, o.rev ?? null, JSON.stringify({ ...params, lane: o.lane ?? LANE_OF[type] ?? 'fast' }));
    const job = this.get(id);
    if (type === 'render') this.events.publish('job', agent, { id, type, status: 'queued', comp: o.compId, rev: o.rev, quality: params.quality });
    setImmediate(() => this.pump());
    return job;
  }

  get(id: string): Job {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as any;
    if (!r) throw notFound(`job ${id}`);
    return this.hydrate(r);
  }

  list(o: { limit?: number; type?: string; agent?: string; status?: string } = {}): Job[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (o.type) where.push('type = ?'), args.push(o.type);
    if (o.agent) where.push('agent = ?'), args.push(o.agent);
    if (o.status) where.push('status = ?'), args.push(o.status);
    const rows = this.db
      .prepare(`SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created DESC, rowid DESC LIMIT ?`)
      .all(...args, o.limit ?? 30) as any[];
    return rows.map((r) => this.hydrate(r));
  }

  cancel(id: string): Job {
    const job = this.get(id);
    if (job.status === 'queued') {
      this.finish(id, 'cancelled', null, 'cancelled before start');
    } else if (job.status === 'running') {
      const r = this.running.get(id);
      if (r) {
        r.cancelled = true;
        r.cancel.forEach((c) => c());
      }
    }
    return this.get(id);
  }

  /** Resolve when the job finishes, or after timeoutMs with its current state. */
  wait(id: string, timeoutMs: number): Promise<Job> {
    const job = this.get(id);
    if (['done', 'failed', 'cancelled'].includes(job.status) || timeoutMs <= 0) return Promise.resolve(job);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        const list = this.waiters.get(id) ?? [];
        this.waiters.set(id, list.filter((f) => f !== done));
        resolve(this.get(id));
      }, timeoutMs);
      const done = (j: Job) => {
        clearTimeout(t);
        resolve(j);
      };
      this.waiters.set(id, [...(this.waiters.get(id) ?? []), done]);
    });
  }

  private hydrate(r: any): Job {
    const params = JSON.parse(r.params);
    return { ...r, params, lane: params.lane ?? 'fast', result: r.result ? JSON.parse(r.result) : null };
  }

  private runningIn(lane: Lane) {
    let n = 0;
    for (const id of this.running.keys()) if (this.get(id).lane === lane) n++;
    return n;
  }

  private pump() {
    for (const lane of ['fast', 'render'] as Lane[]) {
      while (this.runningIn(lane) < this.lanes[lane]) {
        const row = this.db
          .prepare(`SELECT * FROM jobs WHERE status = 'queued' AND json_extract(params, '$.lane') = ? ORDER BY priority DESC, created, rowid LIMIT 1`)
          .get(lane) as any;
        if (!row) break;
        this.run(this.hydrate(row));
      }
    }
  }

  private run(job: Job) {
    const h = this.handlers.get(job.type);
    if (!h) {
      this.finish(job.id, 'failed', null, `no handler for job type ${job.type}`);
      return;
    }
    const state = { cancel: [] as (() => void)[], cancelled: false };
    this.running.set(job.id, state);
    this.db.prepare("UPDATE jobs SET status = 'running', started = datetime('now') WHERE id = ?").run(job.id);
    if (job.type === 'render') this.events.publish('job', job.agent, { id: job.id, type: job.type, status: 'running', comp: job.comp_id });
    const ctx: JobCtx = {
      progress: (p, stage) => {
        const now = Date.now();
        if (now - (this.lastWrite.get(job.id) ?? 0) < 400 && p < 1) return;
        this.lastWrite.set(job.id, now);
        this.db.prepare('UPDATE jobs SET progress = ?, stage = COALESCE(?, stage) WHERE id = ?').run(Math.min(1, p), stage ?? null, job.id);
        this.events.transient('progress', job.agent, { id: job.id, type: job.type, progress: Math.round(p * 1000) / 10, stage });
      },
      onCancel: (cb) => state.cancel.push(cb),
      cancelled: () => state.cancelled,
    };
    h(job, ctx)
      .then((result) => this.finish(job.id, state.cancelled ? 'cancelled' : 'done', result, null))
      .catch((e) => {
        const msg = state.cancelled ? 'cancelled' : String((e as Error)?.message ?? e).split('\n').slice(0, 6).join('\n');
        if (!state.cancelled) this.log(`job ${job.id} (${job.type}) failed: ${msg}`);
        this.finish(job.id, state.cancelled ? 'cancelled' : 'failed', null, msg);
      })
      .finally(() => {
        this.running.delete(job.id);
        this.lastWrite.delete(job.id);
        this.pump();
      });
  }

  private finish(id: string, status: JobStatus, result: Record<string, any> | null, error: string | null) {
    this.db
      .prepare("UPDATE jobs SET status = ?, result = ?, error = ?, progress = CASE WHEN ? = 'done' THEN 1 ELSE progress END, finished = datetime('now') WHERE id = ?")
      .run(status, result ? JSON.stringify(result) : null, error, status, id);
    const job = this.get(id);
    if (job.type === 'render' || status === 'failed') {
      this.events.publish('job', job.agent, { id, type: job.type, status, comp: job.comp_id, rev: job.rev, error: error ?? undefined, output: result?.url, ms: result?.ms });
    }
    for (const w of this.waiters.get(id) ?? []) w(job);
    this.waiters.delete(id);
  }
}
