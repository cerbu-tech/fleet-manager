import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../core/config.js'
import { addDecision, openDb } from '../core/db.js'
import { createScheduler } from '../core/scheduler.js'
import type { Driver } from '../drivers/driver.js'

const noopBrain = async () => {}

const noopDriver: Driver = {
  name: 'noop',
  start: () => {
    throw new Error('not used')
  },
  status: () => 'exited',
  continue: () => {},
  artifacts: () => [],
  stop: () => {},
  cleanup: () => {},
  parseLine: (msg) =>
    msg.type === 'result'
      ? { kind: 'result', status: msg.is_error ? 'error' : 'completed', result: msg.result ?? null, usage: msg.usage ?? null }
      : null,
}

const drivers = { 'claude-code': noopDriver }

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-test-'))
  const db = openDb(join(dir, 'test.db'))
  const cfg = {
    db: join(dir, 'test.db'),
    workdir: join(dir, 'workdir'),
    api: { host: '127.0.0.1', port: 0, token: 't' },
    scheduler: { max_active_subjects: 1, tick_seconds: 5, stall_minutes: 15 },
    policy: { budget: { sessions_per_day: 50, tokens_per_day: 2_000_000 }, protected_branches: ['main', 'master'] },
    artifacts: { hub: '' },
  }
  const ts = new Date().toISOString()
  db.prepare(
    "INSERT INTO subjects (id, title, goal, repo, status, created_at, updated_at) VALUES ('subj1', 't', 'g', '/tmp/x', 'active', ?, ?)",
  ).run(ts, ts)
  return { dir, db, cfg }
}

test('config loader reads example config with env token', () => {
  process.env.FLEET_API_TOKEN = 'secret'
  const cfg = loadConfig(join(import.meta.dirname, '../../config.example.yaml'))
  assert.equal(cfg.api.host, '127.0.0.1')
  assert.equal(cfg.api.token, 'secret')
  assert.equal(cfg.scheduler.stall_minutes, 15)
})

test('reconcile: running session without tmux becomes failed', () => {
  const { db, cfg } = setup()
  const ts = new Date().toISOString()
  db.prepare(
    "INSERT INTO sessions (id, subject_id, driver, claude_session_id, tmux_name, created_at, updated_at) VALUES ('sess1', 'subj1', 'claude-code', 'sess1', 'fleet-does-not-exist', ?, ?)",
  ).run(ts, ts)
  createScheduler(cfg, db, drivers, noopBrain).reconcile()
  const session = db.prepare('SELECT status FROM sessions WHERE id = ?').get('sess1') as any
  assert.equal(session.status, 'failed')
  const lost = db.prepare("SELECT * FROM events WHERE type = 'session_lost'").all()
  assert.equal(lost.length, 1)
})

test('reconcile: running session with live tmux is re-adopted', (t) => {
  try {
    execFileSync('tmux', ['-V'])
  } catch {
    t.skip('tmux not available')
    return
  }
  const { db, cfg } = setup()
  const name = `fleet-test-${process.pid}`
  execFileSync('tmux', ['new-session', '-d', '-s', name, 'sleep 30'])
  try {
    const ts = new Date().toISOString()
    db.prepare(
      "INSERT INTO sessions (id, subject_id, driver, claude_session_id, tmux_name, created_at, updated_at) VALUES ('sess2', 'subj1', 'claude-code', 'sess2', ?, ?, ?)",
    ).run(name, ts, ts)
    createScheduler(cfg, db, drivers, noopBrain).reconcile()
    const session = db.prepare('SELECT status FROM sessions WHERE id = ?').get('sess2') as any
    assert.equal(session.status, 'running')
    const readopted = db.prepare("SELECT * FROM events WHERE type = 'session_readopted'").all()
    assert.equal(readopted.length, 1)
  } finally {
    execFileSync('tmux', ['kill-session', '-t', `=${name}`])
  }
})

test('reconcile: finished worker (dead tmux, result in jsonl) is completed with usage', () => {
  const { db, cfg } = setup()
  const ts = new Date().toISOString()
  db.prepare(
    "INSERT INTO sessions (id, subject_id, driver, claude_session_id, tmux_name, created_at, updated_at) VALUES ('sess3', 'subj1', 'claude-code', 'sess3', 'fleet-gone', ?, ?)",
  ).run(ts, ts)
  const sessionsDir = join(cfg.workdir, 'subj1', 'sessions')
  execFileSync('mkdir', ['-p', sessionsDir])
  writeFileSync(
    join(sessionsDir, 'sess3.jsonl'),
    JSON.stringify({ type: 'result', is_error: false, result: 'done', usage: { output_tokens: 42 } }) + '\n',
  )
  // stale output (older than the stall window) → drained, not re-adopted
  const old = new Date(Date.now() - 20 * 60_000)
  utimesSync(join(sessionsDir, 'sess3.jsonl'), old, old)
  createScheduler(cfg, db, drivers, noopBrain).reconcile()
  const session = db.prepare('SELECT status, usage FROM sessions WHERE id = ?').get('sess3') as any
  assert.equal(session.status, 'completed')
  assert.match(session.usage, /output_tokens/)
})

test('reconcile: dead tmux but fresh jsonl output is re-adopted (claude leaves its pane at boot)', () => {
  const { db, cfg } = setup()
  const ts = new Date().toISOString()
  db.prepare(
    "INSERT INTO sessions (id, subject_id, driver, claude_session_id, tmux_name, created_at, updated_at) VALUES ('sess4', 'subj1', 'claude-code', 'sess4', 'fleet-gone', ?, ?)",
  ).run(ts, ts)
  const sessionsDir = join(cfg.workdir, 'subj1', 'sessions')
  execFileSync('mkdir', ['-p', sessionsDir])
  writeFileSync(join(sessionsDir, 'sess4.jsonl'), JSON.stringify({ type: 'system' }) + '\n')
  createScheduler(cfg, db, drivers, noopBrain).reconcile()
  const session = db.prepare('SELECT status FROM sessions WHERE id = ?').get('sess4') as any
  assert.equal(session.status, 'running')
  const readopted = db.prepare("SELECT * FROM events WHERE type = 'session_readopted'").all()
  assert.equal(readopted.length, 1)
})

test('tick: running session with output older than stall window raises stall event', () => {
  const { db, cfg } = setup()
  const ts = new Date().toISOString()
  db.prepare(
    "INSERT INTO sessions (id, subject_id, driver, claude_session_id, tmux_name, created_at, updated_at) VALUES ('sess5', 'subj1', 'claude-code', 'sess5', 'fleet-x', ?, ?)",
  ).run(ts, ts)
  const sessionsDir = join(cfg.workdir, 'subj1', 'sessions')
  execFileSync('mkdir', ['-p', sessionsDir])
  writeFileSync(join(sessionsDir, 'sess5.jsonl'), JSON.stringify({ type: 'system' }) + '\n')
  const old = new Date(Date.now() - 20 * 60_000)
  utimesSync(join(sessionsDir, 'sess5.jsonl'), old, old)
  createScheduler(cfg, db, drivers, noopBrain).tick()
  const stallEvents = db.prepare("SELECT * FROM events WHERE type = 'stall'").all()
  assert.equal(stallEvents.length, 1)
})

test('scheduler activates queued subject only under the active limit', () => {
  const { db, cfg } = setup()
  const ts = new Date().toISOString()
  db.prepare(
    "INSERT INTO subjects (id, title, goal, repo, status, created_at, updated_at) VALUES ('subj2', 't2', 'g2', '/tmp/x', 'queued', ?, ?)",
  ).run(ts, ts)
  // subj1 is active and max_active_subjects=1 → subj2 must stay queued
  createScheduler(cfg, db, drivers, noopBrain).tick()
  const s2 = db.prepare('SELECT status FROM subjects WHERE id = ?').get('subj2') as any
  assert.equal(s2.status, 'queued')
})

test('brain request becomes pending decision and subject awaits it', () => {
  const { db } = setup()
  const d = addDecision(db, 'subj1', 'spawn_worker', 'Start worker?', { prompt: 'do things' })
  assert.equal(d.status, 'pending')
  const subject = db.prepare('SELECT status FROM subjects WHERE id = ?').get('subj1') as any
  assert.equal(subject.status, 'awaiting_decision')
})
