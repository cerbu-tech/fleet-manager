import { existsSync, readSync, openSync, closeSync, statSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import type { Config } from './config.js'
import { addEvent, getSubject, setSubjectStatus, type DecisionRow, type SessionRow, type SubjectRow } from './db.js'
import { brainTurn, newSubjectMessage } from './brain.js'
import { ensureClone, sessionJsonl, tmuxAlive } from '../drivers/claude-code.js'
import type { Driver } from '../drivers/driver.js'

// The scheduler owns the limits (M0.2): the brain requests, this loop decides.
// All state lives in SQLite; the in-memory maps below are just tail offsets.

export interface Scheduler {
  tick(): void
  reconcile(): void
  resolveDecision(id: string, approve: boolean, note?: string): DecisionRow
  start(): void
  stop(): void
}

export function createScheduler(cfg: Config, db: DatabaseSync, driver: Driver, brain = brainTurn): Scheduler {
  const offsets = new Map<string, number>()
  const stalled = new Set<string>()
  let timer: NodeJS.Timeout | undefined

  const runningSessions = () =>
    db.prepare("SELECT * FROM sessions WHERE status = 'running'").all() as unknown as SessionRow[]

  const pendingCount = (subjectId: string) =>
    (db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE subject_id = ? AND status = 'pending'").get(subjectId) as any)
      .n as number

  // Reads new jsonl bytes; on the stream's `result` message persists usage and
  // hands the outcome to the brain. Termination = result message (M0.3).
  function pollSession(session: SessionRow): void {
    const subject = getSubject(db, session.subject_id)
    if (!subject) return
    const file = sessionJsonl(cfg, subject, session.id)
    if (!existsSync(file)) return
    const size = statSync(file).size
    const offset = offsets.get(session.id) ?? 0
    if (size <= offset) return
    const fd = openSync(file, 'r')
    const buf = Buffer.alloc(size - offset)
    readSync(fd, buf, 0, buf.length, offset)
    closeSync(fd)
    const chunk = buf.toString('utf8')
    const consumed = chunk.lastIndexOf('\n') + 1
    offsets.set(session.id, offset + Buffer.byteLength(chunk.slice(0, consumed)))
    for (const line of chunk.slice(0, consumed).split('\n')) {
      if (!line.trim()) continue
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.type !== 'result') continue
      const status = msg.is_error ? 'error' : 'completed'
      db.prepare('UPDATE sessions SET status = ?, usage = ?, updated_at = ? WHERE id = ?').run(
        status,
        JSON.stringify(msg.usage ?? null),
        new Date().toISOString(),
        session.id,
      )
      const files = driver.artifacts(session)
      addEvent(db, subject.id, 'session_result', { status, result: msg.result ?? null, usage: msg.usage ?? null, files }, session.id)
      void brain(
        cfg,
        db,
        subject.id,
        `Worker session finished (${status}). Changed files: ${files.join(', ') || 'none'}.\n` +
          `Worker report:\n${String(msg.result ?? '').slice(0, 2000)}\n` +
          `Decide the next step: another spawn_worker, or request_decision('close_subject') if the goal is met.`,
      )
      return
    }
  }

  function checkStall(session: SessionRow): void {
    if (stalled.has(session.id)) return
    const subject = getSubject(db, session.subject_id)
    if (!subject) return
    const file = sessionJsonl(cfg, subject, session.id)
    if (!existsSync(file)) return
    const idleMs = Date.now() - statSync(file).mtimeMs
    if (idleMs > cfg.scheduler.stall_minutes * 60_000) {
      stalled.add(session.id)
      addEvent(db, subject.id, 'stall', { idle_minutes: Math.round(idleMs / 60_000) }, session.id)
      void brain(
        cfg,
        db,
        subject.id,
        `Worker session ${session.id} produced no output for ${Math.round(idleMs / 60_000)} minutes. ` +
          `Escalate with request_decision('clarification') or wait.`,
      )
    }
  }

  function activateNext(): void {
    const occupied = (
      db.prepare("SELECT COUNT(*) AS n FROM subjects WHERE status IN ('active','awaiting_decision','closing')").get() as any
    ).n as number
    if (occupied >= cfg.scheduler.max_active_subjects) return
    const next = db
      .prepare("SELECT * FROM subjects WHERE status = 'queued' ORDER BY created_at LIMIT 1")
      .get() as SubjectRow | undefined
    if (!next) return
    try {
      ensureClone(cfg, next)
    } catch (err) {
      addEvent(db, next.id, 'error', { message: `clone failed: ${String(err)}` })
      setSubjectStatus(db, next.id, 'failed')
      return
    }
    setSubjectStatus(db, next.id, 'active')
    void brain(cfg, db, next.id, newSubjectMessage(next))
  }

  return {
    tick() {
      activateNext()
      for (const s of runningSessions()) {
        pollSession(s)
        const fresh = db.prepare('SELECT status FROM sessions WHERE id = ?').get(s.id) as any
        if (fresh?.status === 'running') checkStall(s)
      }
    },

    // Boot reconciliation (M0.2): running sessions are re-adopted when their tmux
    // session still exists; otherwise their jsonl is drained once (the worker may
    // have finished while the daemon was down) and what remains becomes failed.
    reconcile() {
      for (const s of runningSessions()) {
        if (tmuxAlive(s.tmux_name)) {
          addEvent(db, s.subject_id, 'session_readopted', { tmux: s.tmux_name }, s.id)
          continue
        }
        pollSession(s)
        const fresh = db.prepare('SELECT status FROM sessions WHERE id = ?').get(s.id) as any
        if (fresh?.status === 'running') {
          db.prepare("UPDATE sessions SET status = 'failed', updated_at = ? WHERE id = ?").run(
            new Date().toISOString(),
            s.id,
          )
          addEvent(db, s.subject_id, 'session_lost', { tmux: s.tmux_name }, s.id)
        }
      }
    },

    resolveDecision(id, approve, note) {
      const decision = db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as unknown as DecisionRow | undefined
      if (!decision) throw new Error(`decision ${id} not found`)
      if (decision.status !== 'pending') throw new Error(`decision ${id} already ${decision.status}`)
      db.prepare("UPDATE decisions SET status = ?, note = ?, resolved_at = ? WHERE id = ?").run(
        approve ? 'approved' : 'denied',
        note ?? null,
        new Date().toISOString(),
        id,
      )
      addEvent(db, decision.subject_id, 'decision_resolved', { decision_id: id, approved: approve, note: note ?? null })

      const subject = getSubject(db, decision.subject_id)!
      if (subject.status === 'awaiting_decision' && pendingCount(subject.id) === 0) {
        setSubjectStatus(db, subject.id, 'active')
      }

      if (!approve) {
        void brain(cfg, db, subject.id, `Decision denied (${decision.type}): ${decision.question}. Note: ${note ?? 'none'}.`)
        return db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as unknown as DecisionRow
      }

      if (decision.type === 'spawn_worker') {
        try {
          driver.start(getSubject(db, subject.id)!, (JSON.parse(decision.payload) as any).prompt)
        } catch (err) {
          addEvent(db, subject.id, 'error', { message: `worker start failed: ${String(err)}` })
        }
      } else if (decision.type === 'close_subject') {
        setSubjectStatus(db, subject.id, 'closing')
        db.prepare("UPDATE sessions SET status = 'failed', updated_at = ? WHERE subject_id = ? AND status = 'running'").run(
          new Date().toISOString(),
          subject.id,
        )
        driver.cleanup(getSubject(db, subject.id)!)
        setSubjectStatus(db, subject.id, 'closed')
      } else {
        void brain(cfg, db, subject.id, `Decision approved (${decision.type}): ${decision.question}. Note: ${note ?? 'none'}.`)
      }
      return db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as unknown as DecisionRow
    },

    start() {
      timer = setInterval(() => this.tick(), cfg.scheduler.tick_seconds * 1000)
    },
    stop() {
      if (timer) clearInterval(timer)
    },
  }
}
