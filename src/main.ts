import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { loadConfig } from './core/config.js'
import { openDb } from './core/db.js'
import { createScheduler } from './core/scheduler.js'
import { createClaudeCodeDriver } from './drivers/claude-code.js'
import { createCodexDriver } from './drivers/codex.js'
import { startServer } from './web/server.js'

// Boot health-check (Spike 0 lesson): CLI auth is separate from the desktop app —
// verify `claude auth status` before doing anything, refuse to start when logged out.
function checkClaudeAuth(): void {
  let out = ''
  try {
    out = execFileSync('claude', ['auth', 'status'], { encoding: 'utf8', timeout: 30_000 })
  } catch (err: any) {
    out = String(err.stdout ?? '') + String(err.stderr ?? '')
    if (!out) throw new Error(`claude CLI not available: ${String(err)}`)
  }
  if (/loggedIn.*false|not logged in/i.test(out)) {
    throw new Error('claude CLI is not logged in — run `claude auth login` first')
  }
}

const cfg = loadConfig(process.argv[2])
checkClaudeAuth()
// Informative only — the codex driver is optional; a spawn with agent=codex fails loudly anyway.
try {
  console.log(`codex CLI: ${execFileSync('codex', ['--version'], { encoding: 'utf8', timeout: 15_000 }).trim()}`)
} catch {
  console.log('codex CLI: not found — codex driver unavailable')
}
mkdirSync(cfg.workdir, { recursive: true })
const db = openDb(cfg.db)
const drivers = { 'claude-code': createClaudeCodeDriver(cfg, db), codex: createCodexDriver(cfg, db) }
const scheduler = createScheduler(cfg, db, drivers)
scheduler.reconcile()
scheduler.start()
const server = startServer(cfg, db, scheduler)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    scheduler.stop()
    server.close()
    process.exit(0)
  })
}
