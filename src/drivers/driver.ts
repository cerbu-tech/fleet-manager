import type { SessionRow, SubjectRow } from '../core/db.js'

// Contract from the plan (M0.3). continue has resume semantics — a new headless
// run that resumes the same agent session, not a message into a live process.
// cleanup is the provisioning counterpart: it removes the subject's workspace.
export interface Driver {
  name: string
  start(subject: SubjectRow, prompt: string): SessionRow
  status(session: SessionRow): 'running' | 'exited'
  continue(session: SessionRow, message: string): void
  artifacts(session: SessionRow): string[]
  stop(session: SessionRow): void
  cleanup(subject: SubjectRow): void
}
