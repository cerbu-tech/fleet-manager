import { DatabaseSync } from 'node:sqlite'
import { EventEmitter } from 'node:events'

// Subject lifecycle: queued → active → awaiting_decision → closing → closed | failed.
// awaiting_decision while any decision is pending; back to active when none are.

export interface SubjectRow {
  id: string
  title: string
  goal: string
  repo: string
  node: string
  skill_hints: string
  status: 'queued' | 'active' | 'awaiting_decision' | 'closing' | 'closed' | 'failed'
  brain_session_id: string | null
  created_at: string
  updated_at: string
}

export interface SessionRow {
  id: string
  subject_id: string
  driver: string
  claude_session_id: string
  tmux_name: string
  status: 'running' | 'completed' | 'error' | 'failed'
  usage: string | null
  created_at: string
  updated_at: string
}

export interface DecisionRow {
  id: string
  subject_id: string
  type: string
  question: string
  payload: string
  status: 'pending' | 'approved' | 'denied'
  note: string | null
  resolved_by: 'human' | 'policy' | null
  created_at: string
  resolved_at: string | null
}

export interface PublishRow {
  id: string
  subject_id: string
  path: string
  title: string
  repo: string
  branch: string
  status: 'pending' | 'done' | 'failed'
  attempts: number
  last_error: string | null
  created_at: string
  updated_at: string
}

export interface EventRow {
  id: number
  subject_id: string
  session_id: string | null
  type: string
  payload: string
  ts: string
}

// Emits 'event' with each EventRow as it is written — feeds the SSE stream.
export const bus = new EventEmitter()

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE IF NOT EXISTS subjects (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      goal TEXT NOT NULL,
      repo TEXT NOT NULL,
      node TEXT NOT NULL DEFAULT 'local',
      skill_hints TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','active','awaiting_decision','closing','closed','failed')),
      brain_session_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL REFERENCES subjects(id),
      driver TEXT NOT NULL,
      claude_session_id TEXT NOT NULL,
      tmux_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running','completed','error','failed')),
      usage TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL REFERENCES subjects(id),
      type TEXT NOT NULL,
      question TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
      note TEXT,
      resolved_by TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS publishes (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL REFERENCES subjects(id),
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      repo TEXT NOT NULL,
      branch TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id TEXT NOT NULL,
      session_id TEXT,
      type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      ts TEXT NOT NULL
    );
  `)
  // M0 databases predate resolved_by — add it in place, nothing is lost.
  const cols = db.prepare('PRAGMA table_info(decisions)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'resolved_by')) db.exec('ALTER TABLE decisions ADD COLUMN resolved_by TEXT')
  return db
}

const now = () => new Date().toISOString()

export function addEvent(
  db: DatabaseSync,
  subjectId: string,
  type: string,
  payload: Record<string, unknown> = {},
  sessionId?: string,
): void {
  const ts = now()
  const res = db
    .prepare('INSERT INTO events (subject_id, session_id, type, payload, ts) VALUES (?, ?, ?, ?, ?)')
    .run(subjectId, sessionId ?? null, type, JSON.stringify(payload), ts)
  bus.emit('event', {
    id: Number(res.lastInsertRowid),
    subject_id: subjectId,
    session_id: sessionId ?? null,
    type,
    payload: JSON.stringify(payload),
    ts,
  } satisfies EventRow)
}

export function getSubject(db: DatabaseSync, id: string): SubjectRow | undefined {
  return db.prepare('SELECT * FROM subjects WHERE id = ?').get(id) as SubjectRow | undefined
}

export function setSubjectStatus(db: DatabaseSync, id: string, status: SubjectRow['status']): void {
  db.prepare('UPDATE subjects SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id)
  addEvent(db, id, 'subject_status', { status })
}

// Every brain request becomes a pending decision; nothing executes before approval.
export function addDecision(
  db: DatabaseSync,
  subjectId: string,
  type: string,
  question: string,
  payload: Record<string, unknown> = {},
): DecisionRow {
  const id = crypto.randomUUID()
  const ts = now()
  db.prepare(
    'INSERT INTO decisions (id, subject_id, type, question, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, subjectId, type, question, JSON.stringify(payload), ts)
  addEvent(db, subjectId, 'decision_created', { decision_id: id, type, question })
  const subject = getSubject(db, subjectId)
  if (subject && (subject.status === 'active' || subject.status === 'queued')) {
    setSubjectStatus(db, subjectId, 'awaiting_decision')
  }
  return db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as unknown as DecisionRow
}
