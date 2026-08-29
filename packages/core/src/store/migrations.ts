// Architecture doc §5.1 (repo db) and §5.3 (registry db).

export const REPO_DB_MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS sessions (
    id            TEXT PRIMARY KEY,
    agent         TEXT NOT NULL,
    agent_session TEXT,
    repo_root     TEXT NOT NULL,
    branch        TEXT,
    head_before   TEXT,
    head_after    TEXT,
    started_at    INTEGER NOT NULL,
    ended_at      INTEGER,
    end_reason    TEXT,
    task_text     TEXT,
    token_in      INTEGER,
    token_out     INTEGER,
    cost_usd      REAL,
    source        TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    session_id TEXT NOT NULL REFERENCES sessions(id),
    seq        INTEGER NOT NULL,
    ts         INTEGER NOT NULL,
    kind       TEXT NOT NULL,
    payload    TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
  );

  CREATE TABLE IF NOT EXISTS findings (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL REFERENCES sessions(id),
    analyzer    TEXT NOT NULL,
    severity    TEXT NOT NULL,
    title       TEXT NOT NULL,
    explanation TEXT NOT NULL,
    from_seq    INTEGER,
    to_seq      INTEGER,
    data        TEXT,
    created_at  INTEGER NOT NULL,
    resolved_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS briefs (
    session_id   TEXT PRIMARY KEY,
    generated_at INTEGER NOT NULL,
    markdown     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_findings_session ON findings(session_id);
  CREATE INDEX IF NOT EXISTS idx_findings_resolved ON findings(resolved_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
  `,
];

export const REGISTRY_DB_MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS repos (
    repo_id       TEXT PRIMARY KEY,
    root          TEXT NOT NULL UNIQUE,
    name          TEXT,
    agents        TEXT NOT NULL,
    registered_at INTEGER NOT NULL,
    last_seen     INTEGER
  );

  CREATE TABLE IF NOT EXISTS session_index (
    session_id     TEXT PRIMARY KEY,
    repo_id        TEXT NOT NULL,
    agent          TEXT,
    started_at     INTEGER,
    ended_at       INTEGER,
    open_findings  INTEGER
  );

  CREATE TABLE IF NOT EXISTS daemon_state (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_session_index_repo ON session_index(repo_id);
  `,
];
