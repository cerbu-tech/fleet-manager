import type { DatabaseSync } from 'node:sqlite'
import type { Config } from './config.js'
import type { SubjectRow } from './db.js'

export interface Verdict {
  verdict: 'auto' | 'escalate'
  reason: string
}

// Declarative gate (M1.1): explicit auto verdicts only — anything unknown
// (messages to humans, deploys, proposals) escalates without dedicated code.
// Pure judgement over config + DB; execution stays in the scheduler.
export function evaluatePolicy(
  cfg: Config,
  db: DatabaseSync,
  subject: SubjectRow,
  type: string,
  payload: Record<string, unknown>,
): Verdict {
  if (type === 'spawn_worker') {
    // "Today" is the UTC day — created_at is ISO, so a date-prefix compare works.
    const today = new Date().toISOString().slice(0, 10)
    const rows = db.prepare('SELECT usage FROM sessions WHERE created_at >= ?').all(today) as unknown as {
      usage: string | null
    }[]
    if (rows.length >= cfg.policy.budget.sessions_per_day) {
      return { verdict: 'escalate', reason: `budget: ${rows.length} sessions today >= ${cfg.policy.budget.sessions_per_day}` }
    }
    let tokens = 0
    for (const r of rows) {
      try {
        const u = JSON.parse(r.usage ?? 'null')
        tokens += (u?.input_tokens ?? 0) + (u?.output_tokens ?? 0)
      } catch {
        // unparsable usage counts as zero
      }
    }
    if (tokens >= cfg.policy.budget.tokens_per_day) {
      return { verdict: 'escalate', reason: `budget: ${tokens} tokens today >= ${cfg.policy.budget.tokens_per_day}` }
    }
    return { verdict: 'auto', reason: 'within budget' }
  }

  if (type === 'publish_artifact') {
    const repo = String(payload.repo ?? (cfg.artifacts.hub || subject.repo))
    const allowed = [subject.repo, cfg.artifacts.hub].filter(Boolean)
    if (!allowed.includes(repo)) return { verdict: 'escalate', reason: `repo not allowlisted: ${repo}` }
    const branch = payload.branch === undefined ? '' : String(payload.branch)
    if (cfg.policy.protected_branches.includes(branch)) {
      return { verdict: 'escalate', reason: `protected branch: ${branch}` }
    }
    return { verdict: 'auto', reason: 'allowlisted repo, unprotected branch' }
  }

  // close_subject (M1 closure = human-approved decision), clarification, and any new type.
  return { verdict: 'escalate', reason: `${type} always escalates` }
}
