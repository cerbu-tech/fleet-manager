import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addDecision, openDb, type SessionRow, type SubjectRow } from '../core/db.js'
import { createScheduler } from '../core/scheduler.js'
import type { Config } from '../core/config.js'
import type { Driver, ParsedLine } from '../drivers/driver.js'

const noopBrain = async () => {}

function makeDriver(started: string[]): Driver {
  return {
    name: 'noop',
    start: (subject, prompt) => {
      started.push(prompt)
      return { id: 'started', subject_id: subject.id } as SessionRow
    },
    status: () => 'exited',
    continue: () => {},
    artifacts: () => [],
    stop: () => {},
    cleanup: () => {},
    parseLine: (): ParsedLine | null => null,
  }
}

function setup(hub = '') {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-pub-'))
  const db = openDb(join(dir, 'test.db'))
  const cfg: Config = {
    db: join(dir, 'test.db'),
    workdir: join(dir, 'workdir'),
    api: { host: '127.0.0.1', port: 0, token: 't' },
    scheduler: { max_active_subjects: 1, tick_seconds: 5, stall_minutes: 15 },
    policy: { budget: { sessions_per_day: 3, tokens_per_day: 1_000_000 }, protected_branches: ['main', 'master'] },
    artifacts: { hub },
  }
  mkdirSync(cfg.workdir, { recursive: true })
  const ts = new Date().toISOString()
  db.prepare(
    "INSERT INTO subjects (id, title, goal, repo, status, created_at, updated_at) VALUES ('subj1', 't', 'g', '/repos/work.git', 'active', ?, ?)",
  ).run(ts, ts)
  return { dir, db, cfg }
}

test('policy loop: spawn_worker within budget is executed without a human', () => {
  const { db, cfg } = setup()
  const started: string[] = []
  const scheduler = createScheduler(cfg, db, { 'claude-code': makeDriver(started) }, noopBrain)
  addDecision(db, 'subj1', 'spawn_worker', 'Start worker', { prompt: 'do things' })
  scheduler.tick()
  const d = db.prepare('SELECT * FROM decisions').get() as any
  assert.equal(d.status, 'approved')
  assert.equal(d.resolved_by, 'policy')
  assert.match(d.note, /policy:auto/)
  assert.deepEqual(started, ['do things'])
  const subject = db.prepare("SELECT status FROM subjects WHERE id = 'subj1'").get() as any
  assert.equal(subject.status, 'active')
})

test('policy loop: spawn_worker over budget stays pending (escalated)', () => {
  const { db, cfg } = setup()
  const ts = new Date().toISOString()
  for (let i = 0; i < 3; i++) {
    db.prepare(
      "INSERT INTO sessions (id, subject_id, driver, claude_session_id, tmux_name, status, created_at, updated_at) VALUES (?, 'subj1', 'claude-code', ?, ?, 'completed', ?, ?)",
    ).run(`s${i}`, `s${i}`, `fleet-s${i}`, ts, ts)
  }
  const started: string[] = []
  const scheduler = createScheduler(cfg, db, { 'claude-code': makeDriver(started) }, noopBrain)
  addDecision(db, 'subj1', 'spawn_worker', 'Start worker', { prompt: 'do things' })
  scheduler.tick()
  const d = db.prepare('SELECT * FROM decisions').get() as any
  assert.equal(d.status, 'pending')
  assert.deepEqual(started, [])
})

test('negative e2e: publish targeting a protected branch is blocked as a pending decisions row', () => {
  const { db, cfg } = setup()
  const scheduler = createScheduler(cfg, db, { 'claude-code': makeDriver([]) }, noopBrain)
  // A scripted/compromised request: merge into main. Policy must escalate, not run it.
  addDecision(db, 'subj1', 'publish_artifact', 'Publish report to main', {
    path: 'REPORT.md',
    title: 'report',
    branch: 'main',
  })
  scheduler.tick()
  const d = db.prepare('SELECT * FROM decisions').get() as any
  assert.equal(d.status, 'pending')
  assert.equal(d.resolved_by, null)
  const publishes = db.prepare('SELECT COUNT(*) AS n FROM publishes').get() as any
  assert.equal(publishes.n, 0)
})

test('publish queue: pushes branch to hub; offline destination retries and recovers', () => {
  const { dir, db, cfg } = setup()
  // Hub: local bare repo standing in for the git destination.
  const hub = join(dir, 'hub.git')
  execFileSync('git', ['init', '--bare', hub])
  cfg.artifacts.hub = hub

  // Artifact file in a fake session worktree.
  const ts = new Date().toISOString()
  db.prepare(
    "INSERT INTO sessions (id, subject_id, driver, claude_session_id, tmux_name, status, created_at, updated_at) VALUES ('w1', 'subj1', 'claude-code', 'w1', 'fleet-w1', 'completed', ?, ?)",
  ).run(ts, ts)
  const worktree = join(cfg.workdir, 'subj1', 'sessions', 'w1')
  mkdirSync(worktree, { recursive: true })
  writeFileSync(join(worktree, 'REPORT.md'), '# report\n')

  const scheduler = createScheduler(cfg, db, { 'claude-code': makeDriver([]) }, noopBrain)

  // Happy path: auto-approved, queued, pushed on the same tick.
  addDecision(db, 'subj1', 'publish_artifact', 'Publish report', { path: 'REPORT.md', title: 'report' })
  scheduler.tick()
  const done = db.prepare("SELECT * FROM publishes WHERE status = 'done'").get() as any
  assert.ok(done, 'publish should be done')
  const branches = execFileSync('git', ['-C', hub, 'branch', '--list'], { encoding: 'utf8' })
  assert.match(branches, /fleet\/artifact-/)

  // Offline destination: rename the hub away → publish fails and is retried later.
  renameSync(hub, `${hub}.away`)
  addDecision(db, 'subj1', 'publish_artifact', 'Publish again', { path: 'REPORT.md', title: 'again' })
  scheduler.tick()
  let failed = db.prepare("SELECT * FROM publishes WHERE status = 'failed'").get() as any
  assert.equal(failed.attempts, 1)
  assert.ok(failed.last_error)

  // Within the retry window nothing happens.
  scheduler.tick()
  failed = db.prepare("SELECT * FROM publishes WHERE status = 'failed'").get() as any
  assert.equal(failed.attempts, 1)

  // Destination back + retry window elapsed → done without any human.
  renameSync(`${hub}.away`, hub)
  db.prepare("UPDATE publishes SET updated_at = ? WHERE status = 'failed'").run(
    new Date(Date.now() - 120_000).toISOString(),
  )
  scheduler.tick()
  const recovered = db.prepare("SELECT COUNT(*) AS n FROM publishes WHERE status = 'done'").get() as any
  assert.equal(recovered.n, 2)
})
