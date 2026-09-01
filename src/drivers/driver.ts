import type { SessionRow, SubjectRow } from '../core/db.js'

// Contract from the plan (M0.3, extended in M1.4). continue has resume semantics —
// a new headless run that resumes the same agent session, not a message into a live
// process. cleanup is the provisioning counterpart: it removes the subject's workspace.
// parseLine interprets one line of the session's output stream — formats differ per
// agent CLI, so the scheduler stays format-agnostic.

export type ParsedLine =
  | { kind: 'result'; status: 'completed' | 'error'; result: string | null; usage: unknown }
  | { kind: 'session_id'; id: string }
  | { kind: 'message'; text: string }

export interface Driver {
  name: string
  start(subject: SubjectRow, prompt: string): SessionRow
  status(session: SessionRow): 'running' | 'exited'
  continue(session: SessionRow, message: string): void
  artifacts(session: SessionRow): string[]
  stop(session: SessionRow): void
  cleanup(subject: SubjectRow): void
  parseLine(msg: Record<string, any>): ParsedLine | null
}
