import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type SubjectRow } from '../core/db.js'
import { evaluatePolicy } from '../core/policy.js'
import type { Config } from '../core/config.js'

function setup(overrides: Partial<Config['policy']['budget']> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-policy-'))
  const db = openDb(join(dir, 'test.db'))
  const cfg: Config = {
    db: join(dir, 'test.db'),
    workdir: join(dir, 'workdir'),
    api: { host: '127.0.0.1', port: 0, token: 't' },
    scheduler: { max_active_subjects: 1, tick_seconds: 5, stall_minutes: 15 },
    policy: {
      budget: { sessions_per_day: 3, tokens_per_day: 1000, ...overrides },
      protected_branches: ['main', 'master'],
    },
    artifacts: { hub: '/hub/repo.git' },
  }
  const ts = new Date().toISOString()
  db.prepare(
    "INSERT INTO subjects (id, title, goal, repo, status, created_at, updated_at) VALUES ('subj1', 't', 'g', '/repos/work.git', 'active', ?, ?)",
  ).run(ts, ts)
  const subject = db.prepare("SELECT * FROM subjects WHERE id = 'subj1'").get() as unknown as SubjectRow
  return { db, cfg, subject }
}

function addSession(db: any, id: string, usage: unknown) {
  const ts = new Date().toISOString()
  db.prepare(
    "INSERT INTO sessions (id, subject_id, driver, claude_session_id, tmux_name, status, usage, created_at, updated_at) VALUES (?, 'subj1', 'claude-code', ?, ?, 'completed', ?, ?, ?)",
  ).run(id, id, `fleet-${id}`, usage === null ? null : JSON.stringify(usage), ts, ts)
}

test('policy: close_subject and clarification always escalate', () => {
  const { db, cfg, subject } = setup()
  assert.equal(evaluatePolicy(cfg, db, subject, 'close_subject', {}).verdict, 'escalate')
  assert.equal(evaluatePolicy(cfg, db, subject, 'clarification', {}).verdict, 'escalate')
})

test('policy: unknown decision types escalate by default', () => {
  const { db, cfg, subject } = setup()
  assert.equal(evaluatePolicy(cfg, db, subject, 'send_message_to_human', {}).verdict, 'escalate')
  assert.equal(evaluatePolicy(cfg, db, subject, 'deploy', {}).verdict, 'escalate')
})

test('policy: spawn_worker within budget is auto', () => {
  const { db, cfg, subject } = setup()
  addSession(db, 's1', { input_tokens: 100, output_tokens: 50 })
  assert.equal(evaluatePolicy(cfg, db, subject, 'spawn_worker', { prompt: 'x' }).verdict, 'auto')
})

test('policy: spawn_worker over sessions_per_day escalates', () => {
  const { db, cfg, subject } = setup()
  for (let i = 0; i < 3; i++) addSession(db, `s${i}`, null)
  const v = evaluatePolicy(cfg, db, subject, 'spawn_worker', { prompt: 'x' })
  assert.equal(v.verdict, 'escalate')
  assert.match(v.reason, /budget: 3 sessions/)
})

test('policy: spawn_worker over tokens_per_day escalates', () => {
  const { db, cfg, subject } = setup()
  addSession(db, 's1', { input_tokens: 900, output_tokens: 200 })
  const v = evaluatePolicy(cfg, db, subject, 'spawn_worker', { prompt: 'x' })
  assert.equal(v.verdict, 'escalate')
  assert.match(v.reason, /tokens today/)
})

test('policy: publish_artifact to hub or subject repo on a free branch is auto', () => {
  const { db, cfg, subject } = setup()
  assert.equal(evaluatePolicy(cfg, db, subject, 'publish_artifact', { path: 'a.md', title: 't' }).verdict, 'auto')
  assert.equal(
    evaluatePolicy(cfg, db, subject, 'publish_artifact', { repo: '/repos/work.git', branch: 'fleet/x' }).verdict,
    'auto',
  )
})

test('policy: publish_artifact to a repo outside the allowlist escalates', () => {
  const { db, cfg, subject } = setup()
  const v = evaluatePolicy(cfg, db, subject, 'publish_artifact', { repo: 'https://github.com/evil/exfil.git' })
  assert.equal(v.verdict, 'escalate')
  assert.match(v.reason, /not allowlisted/)
})

test('policy: publish_artifact to a protected branch escalates', () => {
  const { db, cfg, subject } = setup()
  const v = evaluatePolicy(cfg, db, subject, 'publish_artifact', { branch: 'main' })
  assert.equal(v.verdict, 'escalate')
  assert.match(v.reason, /protected branch: main/)
})
