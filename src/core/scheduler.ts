import { existsSync, readSync, openSync, closeSync, statSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import type { Config } from './config.js'
import { addEvent, getSubject, setSubjectStatus, type DecisionRow, type SessionRow, type SubjectRow } from './db.js'
import { brainTurn, NEW_SUBJECT_MESSAGE } from './brain.js'
import { evaluatePolicy } from './policy.js'
import { enqueuePublish, processPublishes } from './publish.js'
import { ensureClone, sessionJsonl, tmuxAlive } from '../drivers/workspace.js'
import type { Driver } from '../drivers/driver.js'

// The scheduler owns the limits (M0.2): the brain requests, this loop decides.
// M1.1: every brain request still becomes a decisions row; at each tick the policy
// judges the pending ones and auto-resolves what it allows — through the exact same
// resolveDecision path a human uses. Everything else stays pending (escalated).
// All state lives in SQLite; the in-memory maps below are just stream-tail state.

export interface Scheduler {
  tick(): void
  reconcile(): void
  resolveDecision(id: string, approve: boolean, note?: string, resolvedBy?: 'human' | 'policy'): DecisionRow
  start(): void
  stop(): void
}

export function createScheduler(
  cfg: Config,
  db: DatabaseSync,
  drivers: Record<string, Driver>,
  brain = brainTurn,
): Scheduler {
  const offsets = new Map<string, number>()
  const lastMessage = new Map<string, string>()
  const stalled = new Set<string>()
  let timer: NodeJS.Timeout | undefined

  const driverFor = (session: SessionRow): Driver => {
    const d = drivers[session.driver]
    if (!d) throw new Error(`no driver registered for '${session.driver}'`)
    return d
  }

  const runningSessions = () =>
    db.prepare("SELECT * FROM sessions WHERE status = 'running'").all() as unknown as SessionRow[]

  const pendingDecisions = () =>
    db.prepare("SELECT * FROM decisions WHERE status = 'pending' ORDER BY created_at").all() as unknown as DecisionRow[]

  const pendingCount = (subjectId: string) =>
    (db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE subject_id = ? AND status = 'pending'").get(subjectId) as any)
      .n as number

  // Reads new jsonl bytes and feeds each line to the session's driver (formats
  // differ per agent CLI). Termination = the driver's 'result' line (M0.3).
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
    const driver = driverFor(session)
    for (const line of chunk.slice(0, consumed).split('\n')) {
      if (!line.trim()) continue
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      const parsed = driver.parseLine(msg)
      if (!parsed) continue
      if (parsed.kind === 'session_id') {
        db.prepare('UPDATE sessions SET claude_session_id = ?, updated_at = ? WHERE id = ?').run(
          parsed.id,
          new Date().toISOString(),
          session.id,
        )
        continue
      }
      if (parsed.kind === 'message') {
        lastMessage.set(session.id, parsed.text)
        continue
      }
      const status = parsed.status === 'error' ? 'error' : 'completed'
      const report = parsed.result ?? lastMessage.get(session.id) ?? ''
      db.prepare('UPDATE sessions SET status = ?, usage = ?, updated_at = ? WHERE id = ?').run(
        status,
        JSON.stringify(parsed.usage ?? null),
        new Date().toISOString(),
        session.id,
      )
      const files = driver.artifacts(session)
      addEvent(db, subject.id, 'session_result', { status, result: report || null, usage: parsed.usage ?? null, files }, session.id)
      void brain(
        cfg,
        db,
        subject.id,
        `Worker session finished (${status}). Changed files: ${files.join(', ') || 'none'}.\n` +
          `Worker report:\n${report.slice(0, 2000)}\n` +
          `Decide the next step: another spawn_worker, publish_artifact for the deliverable, ` +
          `or request_decision('close_subject') if the goal is met.`,
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
    void brain(cfg, db, next.id, NEW_SUBJECT_MESSAGE)
  }

  const scheduler: Scheduler = {
    tick() {
      for (const d of pendingDecisions()) {
        const subject = getSubject(db, d.subject_id)
        // Escalation is durable: only live subjects are re-judged, so an over-budget
        // escalation cannot silently self-approve after the UTC day rolls over.
        if (!subject || !['active', 'awaiting_decision'].includes(subject.status)) continue
        let payload: Record<string, unknown> = {}
        try {
          payload = JSON.parse(d.payload)
        } catch {
          // unparsable payload stays escalated
        }
        const v = evaluatePolicy(cfg, db, subject, d.type, payload)
        if (v.verdict !== 'auto') continue
        try {
          scheduler.resolveDecision(d.id, true, `policy:auto ${v.reason}`, 'policy')
        } catch (err) {
          addEvent(db, d.subject_id, 'error', { message: `auto-resolve failed: ${String(err)}` })
        }
      }
      processPublishes(cfg, db)
      activateNext()
      for (const s of runningSessions()) {
        pollSession(s)
        const fresh = db.prepare('SELECT status FROM sessions WHERE id = ?').get(s.id) as any
        if (fresh?.status === 'running') checkStall(s)
      }
    },

    // Boot reconciliation (M0.2): a running session is re-adopted when its tmux
    // session still exists OR its jsonl is still fresh — claude >= 2.1.252 leaves
    // its tmux pane at boot (relaunches detached), so recent output is the honest
    // liveness signal. Otherwise the jsonl is drained once (the worker may have
    // finished while the daemon was down) and what remains becomes failed.
    reconcile() {
      for (const s of runningSessions()) {
        const subject = getSubject(db, s.subject_id)
        const file = subject ? sessionJsonl(cfg, subject, s.id) : undefined
        const fresh =
          file !== undefined &&
          existsSync(file) &&
          Date.now() - statSync(file).mtimeMs < cfg.scheduler.stall_minutes * 60_000
        if (tmuxAlive(s.tmux_name) || fresh) {
          addEvent(db, s.subject_id, 'session_readopted', { tmux: s.tmux_name, fresh_output: fresh }, s.id)
          continue
        }
        pollSession(s)
        const after = db.prepare('SELECT status FROM sessions WHERE id = ?').get(s.id) as any
        if (after?.status === 'running') {
          db.prepare("UPDATE sessions SET status = 'failed', updated_at = ? WHERE id = ?").run(
            new Date().toISOString(),
            s.id,
          )
          addEvent(db, s.subject_id, 'session_lost', { tmux: s.tmux_name }, s.id)
          void brain(
            cfg,
            db,
            s.subject_id,
            `Worker session ${s.id} was lost (daemon restarted, tmux session gone, no result). Decide the next step.`,
          )
        }
      }
    },

    resolveDecision(id, approve, note, resolvedBy = 'human') {
      const decision = db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as unknown as DecisionRow | undefined
      if (!decision) throw new Error(`decision ${id} not found`)
      if (decision.status !== 'pending') throw new Error(`decision ${id} already ${decision.status}`)
      db.prepare('UPDATE decisions SET status = ?, note = ?, resolved_by = ?, resolved_at = ? WHERE id = ?').run(
        approve ? 'approved' : 'denied',
        note ?? null,
        resolvedBy,
        new Date().toISOString(),
        id,
      )
      addEvent(db, decision.subject_id, 'decision_resolved', {
        decision_id: id,
        approved: approve,
        resolved_by: resolvedBy,
        note: note ?? null,
      })

      const subject = getSubject(db, decision.subject_id)!
      if (subject.status === 'awaiting_decision' && pendingCount(subject.id) === 0) {
        setSubjectStatus(db, subject.id, 'active')
      }

      if (!approve) {
        void brain(cfg, db, subject.id, `Decision denied (${decision.type}): ${decision.question}. Note: ${note ?? 'none'}.`)
        return db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as unknown as DecisionRow
      }

      const payload = JSON.parse(decision.payload) as any
      if (decision.type === 'spawn_worker') {
        try {
          const name = payload.agent === 'codex' ? 'codex' : 'claude-code'
          const driver = drivers[name]
          if (!driver) throw new Error(`no driver registered for '${name}'`)
          driver.start(getSubject(db, subject.id)!, payload.prompt)
        } catch (err) {
          addEvent(db, subject.id, 'error', { message: `worker start failed: ${String(err)}` })
          void brain(cfg, db, subject.id, `Worker start failed: ${String(err)}. Decide the next step.`)
        }
      } else if (decision.type === 'publish_artifact') {
        const row = enqueuePublish(cfg, db, getSubject(db, subject.id)!, payload)
        if (!row) {
          addEvent(db, subject.id, 'error', { message: `publish failed: ${payload.path} not found in any session worktree` })
          void brain(cfg, db, subject.id, `Publish failed: file '${payload.path}' not found in any worker worktree. Decide the next step.`)
        }
      } else if (decision.type === 'close_subject') {
        setSubjectStatus(db, subject.id, 'closing')
        db.prepare("UPDATE sessions SET status = 'failed', updated_at = ? WHERE subject_id = ? AND status = 'running'").run(
          new Date().toISOString(),
          subject.id,
        )
        const anyDriver = Object.values(drivers)[0]
        anyDriver.cleanup(getSubject(db, subject.id)!)
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
  return scheduler
}
