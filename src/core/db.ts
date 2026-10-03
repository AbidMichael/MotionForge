import Database from 'better-sqlite3';

export type DB = Database.Database;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- Search index over every library version on disk (rebuilt by reindex).
CREATE TABLE IF NOT EXISTS presets (
  key TEXT PRIMARY KEY,            -- @scope/name/slug@version
  library TEXT NOT NULL,
  version TEXT NOT NULL,           -- semver or 'draft'
  is_latest INTEGER NOT NULL DEFAULT 0,
  slug TEXT NOT NULL,
  alias TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags TEXT NOT NULL,
  required TEXT NOT NULL,
  params TEXT NOT NULL,
  duration REAL,
  owner TEXT,
  visibility TEXT NOT NULL,
  deprecated TEXT,
  signature TEXT
);
CREATE INDEX IF NOT EXISTS presets_lib ON presets(library, version);
CREATE VIRTUAL TABLE IF NOT EXISTS presets_fts USING fts5(key UNINDEXED, slug, summary, tags, kind, library, tokenize='porter unicode61');

-- Usage signals survive reindexing (keyed by library + slug, across versions).
CREATE TABLE IF NOT EXISTS preset_stats (
  library TEXT NOT NULL,
  slug TEXT NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  renders_ok INTEGER NOT NULL DEFAULT 0,
  renders_fail INTEGER NOT NULL DEFAULT 0,
  rating_sum REAL NOT NULL DEFAULT 0,
  rating_n INTEGER NOT NULL DEFAULT 0,
  last_used TEXT,
  PRIMARY KEY (library, slug)
);

CREATE TABLE IF NOT EXISTS ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library TEXT NOT NULL,
  slug TEXT NOT NULL,
  agent TEXT NOT NULL,
  score INTEGER NOT NULL,
  note TEXT,
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,            -- @lib/slug@version that was promoted
  shared_id TEXT NOT NULL,         -- shared:slug
  mode TEXT NOT NULL,              -- auto | human
  by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- active | demoted
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS compositions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  title TEXT,
  head INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL DEFAULT (datetime('now')),
  updated TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS revisions (
  comp_id TEXT NOT NULL REFERENCES compositions(id) ON DELETE CASCADE,
  rev INTEGER NOT NULL,
  json TEXT NOT NULL,
  lock TEXT NOT NULL,
  ok INTEGER NOT NULL,
  errors TEXT,
  warnings TEXT,
  duration REAL,
  agent TEXT NOT NULL,
  created TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (comp_id, rev)
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,              -- render | preview | thumb
  status TEXT NOT NULL,            -- queued | running | done | failed | cancelled
  priority INTEGER NOT NULL DEFAULT 0,
  agent TEXT NOT NULL,
  comp_id TEXT,
  rev INTEGER,
  params TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  stage TEXT,
  result TEXT,
  error TEXT,
  created TEXT NOT NULL DEFAULT (datetime('now')),
  started TEXT,
  finished TEXT
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, priority DESC, created);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,             -- sha256 (first 16 hex)
  sha TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  tags TEXT,
  agent TEXT NOT NULL,
  path TEXT NOT NULL,
  created TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  kind TEXT NOT NULL,
  agent TEXT,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  agent TEXT NOT NULL,
  client TEXT NOT NULL,            -- mcp | rest
  tool TEXT NOT NULL,
  in_chars INTEGER NOT NULL,
  out_chars INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS calls_agent ON calls(agent, ts);
`;

export function openDb(file: string): DB {
  const db = new Database(file);
  db.exec(SCHEMA);
  // migrations (columns added after the first release)
  const cols = new Set((db.prepare('PRAGMA table_info(compositions)').all() as { name: string }[]).map((c) => c.name));
  if (!cols.has('source')) db.exec('ALTER TABLE compositions ADD COLUMN source TEXT');
  if (!cols.has('source_hash')) db.exec('ALTER TABLE compositions ADD COLUMN source_hash TEXT');
  return db;
}
