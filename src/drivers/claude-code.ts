import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Config } from '../core/config.js'
import { addEvent, type SessionRow, type SubjectRow } from '../core/db.js'
import type { Driver } from './driver.js'

const sh = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

const tmux = (...args: string[]) => execFileSync('tmux', args, { encoding: 'utf8' })

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

// Clone once per subject; every session gets its own worktree (M0.3).
export function ensureClone(cfg: Config, subject: SubjectRow): string {
  const repo = join(subjectDir(cfg, subject.id), 'repo')
  if (!existsSync(repo)) {
    mkdirSync(subjectDir(cfg, subject.id), { recursive: true })
    execFileSync('git', ['clone', '--depth', '1', subject.repo, repo], { encoding: 'utf8' })
  }
  return repo
}

export function createClaudeCodeDriver(cfg: Config, db: DatabaseSync): Driver {
  const runHeadless = (subject: SubjectRow, session: SessionRow, prompt: string, resume: boolean) => {
    const dir = join(subjectDir(cfg, subject.id), 'sessions')
    const worktree = join(dir, session.id)
    const promptFile = join(dir, `${session.id}.prompt`)
    const jsonl = sessionJsonl(cfg, subject, session.id)
    writeFileSync(promptFile, prompt)
    const claude = resume
      ? `claude -p --resume ${session.claude_session_id}`
      : `claude -p --session-id ${session.claude_session_id}`
    const cmd =
      `cd ${sh(worktree)} && ${claude} --output-format stream-json --verbose ` +
      `--permission-mode acceptEdits < ${sh(promptFile)} >> ${sh(jsonl)} 2>> ${sh(jsonl + '.err')}`
    tmux('new-session', '-d', '-s', session.tmux_name, cmd)
  }

  return {
    name: 'claude-code',

    start(subject, prompt) {
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
         VALUES (?, ?, 'claude-code', ?, ?, ?, ?)`,
      ).run(id, subject.id, id, `fleet-${id.slice(0, 8)}`, ts, ts)
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as SessionRow
      runHeadless(subject, session, prompt, false)
      addEvent(db, subject.id, 'worker_started', { tmux: session.tmux_name, prompt }, id)
      return session
    },

    status(session) {
      return tmuxAlive(session.tmux_name) ? 'running' : 'exited'
    },

    continue(session, message) {
      if (tmuxAlive(session.tmux_name)) throw new Error(`session ${session.id} still running`)
      const subject = db.prepare('SELECT * FROM subjects WHERE id = ?').get(session.subject_id) as
        | SubjectRow
        | undefined
      if (!subject) throw new Error(`subject ${session.subject_id} not found`)
      db.prepare("UPDATE sessions SET status = 'running', updated_at = ? WHERE id = ?").run(
        new Date().toISOString(),
        session.id,
      )
      runHeadless(subject, session, message, true)
      addEvent(db, subject.id, 'worker_resumed', { message }, session.id)
    },

    artifacts(session) {
      const worktree = join(subjectDir(cfg, session.subject_id), 'sessions', session.id)
      if (!existsSync(worktree)) return []
      const out = execFileSync('git', ['-C', worktree, 'status', '--porcelain'], { encoding: 'utf8' })
      return out.split('\n').filter(Boolean).map((l) => l.slice(3))
    },

    stop(session) {
      if (tmuxAlive(session.tmux_name)) tmux('kill-session', '-t', `=${session.tmux_name}`)
    },

    cleanup(subject) {
      const repo = join(subjectDir(cfg, subject.id), 'repo')
      const rows = db
        .prepare('SELECT * FROM sessions WHERE subject_id = ?')
        .all(subject.id) as unknown as SessionRow[]
      for (const s of rows) {
        this.stop(s)
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
    },
  }
}
