import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Config } from '../core/config.js'
import { addEvent, type SessionRow, type SubjectRow } from '../core/db.js'
import type { Driver } from './driver.js'
import {
  cleanupSubject,
  listArtifacts,
  provisionSession,
  sessionJsonl,
  sh,
  stopSession,
  subjectDir,
  tmux,
  tmuxAlive,
} from './workspace.js'

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
      const session = provisionSession(cfg, db, subject, 'claude-code')
      runHeadless(subject, session, prompt, false)
      addEvent(db, subject.id, 'worker_started', { tmux: session.tmux_name, prompt }, session.id)
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
      return listArtifacts(cfg, session)
    },

    stop(session) {
      stopSession(session)
    },

    cleanup(subject) {
      cleanupSubject(cfg, db, subject)
    },

    parseLine(msg) {
      if (msg.type !== 'result') return null
      return {
        kind: 'result',
        status: msg.is_error ? 'error' : 'completed',
        result: msg.result ?? null,
        usage: msg.usage ?? null,
      }
    },
  }
}
