import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Config } from '../core/config.js'
import type { SessionRow, SubjectRow } from '../core/db.js'

// Workspace provisioning shared by all drivers (M0.3): clone once per subject,
// one git worktree per session, cleanup when the subject closes.

export const sh = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

// Dedicated tmux server (-L fleet): started by the daemon, so workers inherit the
// daemon's environment (auth tokens) instead of whatever user server already runs.
export const tmux = (...args: string[]) => execFileSync('tmux', ['-L', 'fleet', ...args], { encoding: 'utf8' })

export function tmuxAlive(name: string): boolean {
  try {
    tmux('has-session', '-t', `=${name}`)
    return true
  } catch {
    return false
  }
}

export const subjectDir = (cfg: Config, subjectId: string) => join(cfg.workdir, subjectId)
export const sessionJsonl = (cfg: Config, subject: SubjectRow, sessionId: string) =>
  join(subjectDir(cfg, subject.id), 'sessions', `${sessionId}.jsonl`)

export function ensureClone(cfg: Config, subject: SubjectRow): string {
  const repo = join(subjectDir(cfg, subject.id), 'repo')
  if (!existsSync(repo)) {
    mkdirSync(subjectDir(cfg, subject.id), { recursive: true })
    execFileSync('git', ['clone', '--depth', '1', subject.repo, repo], { encoding: 'utf8' })
  }
  return repo
}

// agentSessionId: the agent-side session id when known up front (claude generates it);
// undefined = same as the row id; '' = discovered later from the output stream (codex).
export function provisionSession(
  cfg: Config,
  db: DatabaseSync,
  subject: SubjectRow,
  driverName: string,
  agentSessionId?: string,
): SessionRow {
  const repo = ensureClone(cfg, subject)
  const id = crypto.randomUUID()
  const worktree = join(subjectDir(cfg, subject.id), 'sessions', id)
  mkdirSync(join(subjectDir(cfg, subject.id), 'sessions'), { recursive: true })
  execFileSync('git', ['-C', repo, 'worktree', 'add', worktree, '-b', `fleet/${id.slice(0, 8)}`], {
    encoding: 'utf8',
  })
  const ts = new Date().toISOString()
  db.prepare(
    `INSERT INTO sessions (id, subject_id, driver, claude_session_id, tmux_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, subject.id, driverName, agentSessionId ?? id, `fleet-${id.slice(0, 8)}`, ts, ts)
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as SessionRow
}

export function stopSession(session: SessionRow): void {
  if (tmuxAlive(session.tmux_name)) tmux('kill-session', '-t', `=${session.tmux_name}`)
}

export function listArtifacts(cfg: Config, session: SessionRow): string[] {
  const worktree = join(subjectDir(cfg, session.subject_id), 'sessions', session.id)
  if (!existsSync(worktree)) return []
  const out = execFileSync('git', ['-C', worktree, 'status', '--porcelain'], { encoding: 'utf8' })
  return out.split('\n').filter(Boolean).map((l) => l.slice(3))
}

export function cleanupSubject(cfg: Config, db: DatabaseSync, subject: SubjectRow): void {
  const repo = join(subjectDir(cfg, subject.id), 'repo')
  const rows = db.prepare('SELECT * FROM sessions WHERE subject_id = ?').all(subject.id) as unknown as SessionRow[]
  for (const s of rows) {
    stopSession(s)
    const worktree = join(subjectDir(cfg, subject.id), 'sessions', s.id)
    if (existsSync(repo) && existsSync(worktree)) {
      try {
        execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', worktree])
      } catch {
        // fall through to rmSync below
      }
    }
  }
  rmSync(subjectDir(cfg, subject.id), { recursive: true, force: true })
}
