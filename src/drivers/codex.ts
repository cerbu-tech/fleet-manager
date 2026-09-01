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

// Codex driver (M1.4, S0.3 PASS): same one-shot + resume model as claude-code.
// The agent session id (thread_id) is only known from the output stream — the
// sessions row starts with '' and the scheduler fills it in from thread.started.

export function createCodexDriver(cfg: Config, db: DatabaseSync): Driver {
  const runHeadless = (subject: SubjectRow, session: SessionRow, prompt: string, resume: boolean) => {
    const dir = join(subjectDir(cfg, subject.id), 'sessions')
    const worktree = join(dir, session.id)
    const promptFile = join(dir, `${session.id}.prompt`)
    const jsonl = sessionJsonl(cfg, subject, session.id)
    writeFileSync(promptFile, prompt)
    // `-` reads the prompt from stdin; --sandbox exists only on exec, resume inherits it (S0.3).
    const codex = resume
      ? `codex exec resume ${session.claude_session_id} --json`
      : `codex exec --json --sandbox workspace-write`
    const cmd =
      `cd ${sh(worktree)} && ${codex} - < ${sh(promptFile)} >> ${sh(jsonl)} 2>> ${sh(jsonl + '.err')}`
    tmux('new-session', '-d', '-s', session.tmux_name, cmd)
  }

  return {
    name: 'codex',

    start(subject, prompt) {
      const session = provisionSession(cfg, db, subject, 'codex', '')
      runHeadless(subject, session, prompt, false)
      addEvent(db, subject.id, 'worker_started', { tmux: session.tmux_name, prompt }, session.id)
      return session
    },

    status(session) {
      return tmuxAlive(session.tmux_name) ? 'running' : 'exited'
    },

    continue(session, message) {
      if (tmuxAlive(session.tmux_name)) throw new Error(`session ${session.id} still running`)
      if (!session.claude_session_id) throw new Error(`session ${session.id} has no codex thread id yet`)
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
      if (msg.type === 'thread.started' && msg.thread_id) return { kind: 'session_id', id: msg.thread_id }
      if (msg.type === 'item.completed' && msg.item?.type === 'agent_message' && msg.item.text) {
        return { kind: 'message', text: msg.item.text }
      }
      if (msg.type === 'turn.completed') {
        return { kind: 'result', status: 'completed', result: null, usage: msg.usage ?? null }
      }
      if (msg.type === 'turn.failed') {
        return { kind: 'result', status: 'error', result: msg.error?.message ?? null, usage: null }
      }
      return null
    },
  }
}
