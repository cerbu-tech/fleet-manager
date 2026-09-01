import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import type { Config } from '../core/config.js'
import { addEvent, bus, type EventRow } from '../core/db.js'
import type { Scheduler } from '../core/scheduler.js'
import { DASHBOARD_HTML } from './dashboard.js'

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const readBody = (req: IncomingMessage): Promise<any> =>
  new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch (err) {
        reject(err)
      }
    })
  })

// API-first (M0.5): everything the dashboard or CLI does goes through here.
// Static bearer token on every /api/* route; bind address comes from config.
export function startServer(cfg: Config, db: DatabaseSync, scheduler: Scheduler) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    try {
      if (!url.pathname.startsWith('/api/')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(DASHBOARD_HTML)
        return
      }
      if (req.headers.authorization !== `Bearer ${cfg.api.token}`) {
        json(res, 401, { error: 'unauthorized' })
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/subjects') {
        json(res, 200, db.prepare('SELECT * FROM subjects ORDER BY created_at DESC').all())
        return
      }

      const subjectMatch = url.pathname.match(/^\/api\/subjects\/([\w-]+)$/)
      if (req.method === 'GET' && subjectMatch) {
        const subject = db.prepare('SELECT * FROM subjects WHERE id = ?').get(subjectMatch[1])
        if (!subject) return json(res, 404, { error: 'not found' })
        json(res, 200, {
          subject,
          sessions: db.prepare('SELECT * FROM sessions WHERE subject_id = ? ORDER BY created_at').all(subjectMatch[1]),
          decisions: db.prepare('SELECT * FROM decisions WHERE subject_id = ? ORDER BY created_at').all(subjectMatch[1]),
          events: db.prepare('SELECT * FROM events WHERE subject_id = ? ORDER BY id').all(subjectMatch[1]),
        })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/subjects') {
        const body = await readBody(req)
        for (const key of ['title', 'goal', 'repo']) {
          if (!body[key]) return json(res, 400, { error: `missing ${key}` })
        }
        const id = crypto.randomUUID()
        const ts = new Date().toISOString()
        db.prepare(
          'INSERT INTO subjects (id, title, goal, repo, node, skill_hints, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(id, body.title, body.goal, body.repo, body.node ?? 'local', body.skill_hints ?? '', ts, ts)
        addEvent(db, id, 'subject_created', { title: body.title })
        json(res, 201, db.prepare('SELECT * FROM subjects WHERE id = ?').get(id))
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/decisions') {
        const status = url.searchParams.get('status') ?? 'pending'
        json(res, 200, db.prepare('SELECT * FROM decisions WHERE status = ? ORDER BY created_at').all(status))
        return
      }

      const decisionMatch = url.pathname.match(/^\/api\/decisions\/([\w-]+)\/(approve|deny)$/)
      if (req.method === 'POST' && decisionMatch) {
        const body = await readBody(req)
        json(res, 200, scheduler.resolveDecision(decisionMatch[1], decisionMatch[2] === 'approve', body.note))
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        const onEvent = (e: EventRow) => res.write(`data: ${JSON.stringify(e)}\n\n`)
        bus.on('event', onEvent)
        const ping = setInterval(() => res.write(': ping\n\n'), 30_000)
        req.on('close', () => {
          bus.off('event', onEvent)
          clearInterval(ping)
        })
        return
      }

      json(res, 404, { error: 'not found' })
    } catch (err) {
      json(res, 500, { error: String(err) })
    }
  })
  server.listen(cfg.api.port, cfg.api.host, () => {
    console.log(`fleet-manager API on http://${cfg.api.host}:${cfg.api.port}`)
  })
  return server
}
