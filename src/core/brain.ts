import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { DatabaseSync } from 'node:sqlite'
import type { Config } from './config.js'
import { addDecision, addEvent, getSubject, type SubjectRow } from './db.js'
import { subjectDir } from '../drivers/claude-code.js'

const SYSTEM = `You are the brain of fleet-manager for exactly one subject (a unit of work).
You decide WHAT happens next; you never execute anything yourself. Every request you
make becomes a pending decision that a human must approve before it runs.

Tools:
- spawn_worker(prompt): request a headless coding-agent session in the subject's repo.
  The prompt must be fully self-contained (the worker has no other context).
- request_decision(type, question): 'close_subject' when the goal is met (or cannot be),
  'clarification' when you need input from the human.
- report_event(message): log a short progress note.

Be economical: one tool call per step, short reasoning, no repeated requests while a
decision is still pending.`

// One brain conversation per subject, persisted via SDK resume: the session id lives
// on the subjects row, so daemon restarts do not lose brain context.
const chains = new Map<string, Promise<void>>()

export function brainTurn(cfg: Config, db: DatabaseSync, subjectId: string, message: string): Promise<void> {
  const next = (chains.get(subjectId) ?? Promise.resolve()).then(() => runTurn(cfg, db, subjectId, message))
  chains.set(subjectId, next.catch(() => {}))
  return next
}

async function runTurn(cfg: Config, db: DatabaseSync, subjectId: string, message: string): Promise<void> {
  const subject = getSubject(db, subjectId)
  if (!subject || ['closing', 'closed', 'failed'].includes(subject.status)) return

  const server = createSdkMcpServer({
    name: 'fleet',
    version: '0.1.0',
    tools: [
      tool(
        'spawn_worker',
        'Request a coding-agent worker session (requires human approval)',
        { prompt: z.string() },
        async ({ prompt }) => {
          const d = addDecision(db, subjectId, 'spawn_worker', `Start worker: ${prompt.slice(0, 200)}`, { prompt })
          return { content: [{ type: 'text', text: `decision ${d.id} pending approval` }] }
        },
      ),
      tool(
        'request_decision',
        'Escalate a decision to the human operator',
        { type: z.enum(['close_subject', 'clarification']), question: z.string() },
        async ({ type, question }) => {
          const d = addDecision(db, subjectId, type, question)
          return { content: [{ type: 'text', text: `decision ${d.id} pending approval` }] }
        },
      ),
      tool('report_event', 'Log a short progress note', { message: z.string() }, async ({ message: note }) => {
        addEvent(db, subjectId, 'brain_note', { message: note })
        return { content: [{ type: 'text', text: 'logged' }] }
      }),
    ],
  })

  const q = query({
    prompt: message,
    options: {
      systemPrompt: `${SYSTEM}\n\nSubject: ${subject.title}\nGoal: ${subject.goal}\nRepo: ${subject.repo}${
        subject.skill_hints ? `\nSkill hints: ${subject.skill_hints}` : ''
      }`,
      mcpServers: { fleet: server },
      allowedTools: ['mcp__fleet__spawn_worker', 'mcp__fleet__request_decision', 'mcp__fleet__report_event'],
      maxTurns: 8,
      cwd: subjectDir(cfg, subjectId),
      ...(subject.brain_session_id ? { resume: subject.brain_session_id } : {}),
    },
  })

  let result: any = null
  for await (const msg of q) {
    if (msg.type === 'result') result = msg
  }
  if (result?.session_id) {
    db.prepare('UPDATE subjects SET brain_session_id = ?, updated_at = ? WHERE id = ?').run(
      result.session_id,
      new Date().toISOString(),
      subjectId,
    )
  }
  addEvent(db, subjectId, 'brain_turn', {
    message,
    reply: result?.result ?? null,
    is_error: result?.is_error ?? true,
    usage: result?.usage ?? null,
  })
}

export function newSubjectMessage(subject: SubjectRow): string {
  return `New subject. Decide the first step toward the goal (usually spawn_worker with a self-contained prompt).`
}
