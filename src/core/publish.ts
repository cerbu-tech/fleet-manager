import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Config } from './config.js'
import { addEvent, type PublishRow, type SubjectRow } from './db.js'
import { subjectDir } from '../drivers/workspace.js'

// Artifact publishing (M1.5): one destination — a git hub, as branch + PR.
// A queue with retry: the file is copied to a staging dir when the request is
// approved, so the publish survives worktree cleanup and destination downtime.

const git = (args: string[], cwd?: string) =>
  execFileSync('git', args, { encoding: 'utf8', ...(cwd ? { cwd } : {}) })

const stagingDir = (cfg: Config, publishId: string) => join(cfg.workdir, '_publish', publishId)

export function enqueuePublish(
  cfg: Config,
  db: DatabaseSync,
  subject: SubjectRow,
  payload: { path: string; title: string; repo?: string; branch?: string },
): PublishRow | null {
  const sessions = db
    .prepare('SELECT id FROM sessions WHERE subject_id = ? ORDER BY created_at DESC')
    .all(subject.id) as unknown as { id: string }[]
  let src: string | undefined
  for (const s of sessions) {
    const cand = join(subjectDir(cfg, subject.id), 'sessions', s.id, payload.path)
    if (existsSync(cand)) {
      src = cand
      break
    }
  }
  if (!src) return null
  const id = crypto.randomUUID()
  const staged = join(stagingDir(cfg, id), 'file', payload.path)
  mkdirSync(dirname(staged), { recursive: true })
  cpSync(src, staged)
  const ts = new Date().toISOString()
  db.prepare(
    `INSERT INTO publishes (id, subject_id, path, title, repo, branch, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    subject.id,
    payload.path,
    payload.title,
    payload.repo ?? (cfg.artifacts.hub || subject.repo),
    payload.branch || `fleet/artifact-${id.slice(0, 8)}`,
    ts,
    ts,
  )
  const row = db.prepare('SELECT * FROM publishes WHERE id = ?').get(id) as unknown as PublishRow
  addEvent(db, subject.id, 'publish_queued', { publish_id: id, path: payload.path, repo: row.repo, branch: row.branch })
  return row
}

// Retry policy: first attempt immediately, then at most once per minute.
export function processPublishes(cfg: Config, db: DatabaseSync): void {
  const rows = db.prepare("SELECT * FROM publishes WHERE status != 'done'").all() as unknown as PublishRow[]
  for (const p of rows) {
    if (p.attempts > 0 && Date.now() - Date.parse(p.updated_at) < 60_000) continue
    try {
      const prUrl = executePublish(cfg, p)
      db.prepare("UPDATE publishes SET status = 'done', last_error = NULL, updated_at = ? WHERE id = ?").run(
        new Date().toISOString(),
        p.id,
      )
      addEvent(db, p.subject_id, 'artifact_published', { publish_id: p.id, repo: p.repo, branch: p.branch, pr_url: prUrl })
      rmSync(stagingDir(cfg, p.id), { recursive: true, force: true })
    } catch (err) {
      db.prepare(
        "UPDATE publishes SET status = 'failed', attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?",
      ).run(String(err).slice(0, 500), new Date().toISOString(), p.id)
      addEvent(db, p.subject_id, 'publish_failed', { publish_id: p.id, attempts: p.attempts + 1, error: String(err).slice(0, 500) })
    }
  }
}

function executePublish(cfg: Config, p: PublishRow): string | null {
  const clone = join(stagingDir(cfg, p.id), 'hub')
  rmSync(clone, { recursive: true, force: true })
  git(['clone', '--depth', '1', p.repo, clone])
  git(['checkout', '-b', p.branch], clone)
  const dest = join(clone, p.path)
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(join(stagingDir(cfg, p.id), 'file', p.path), dest)
  git(['add', '-A'], clone)
  git(['commit', '-m', `fleet: ${p.title}`], clone)
  // --force keeps retries idempotent — fleet/artifact-* branches belong to the manager.
  git(['push', '--force', 'origin', p.branch], clone)

  const gh = p.repo.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (!gh) return null // generic git hub: branch pushed, no PR surface
  const repoSlug = `${gh[1]}/${gh[2]}`
  const existing = execFileSync('gh', ['pr', 'list', '--repo', repoSlug, '--head', p.branch, '--json', 'url'], {
    encoding: 'utf8',
  })
  const found = JSON.parse(existing) as { url: string }[]
  if (found.length) return found[0].url
  return execFileSync(
    'gh',
    ['pr', 'create', '--repo', repoSlug, '--head', p.branch, '--title', p.title, '--body',
      `Artifact from fleet-manager subject ${p.subject_id}.`],
    { encoding: 'utf8' },
  ).trim()
}
