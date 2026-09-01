#!/usr/bin/env node
// `fleet` — thin client of the HTTP API (M0.5). No direct SQLite access.

const BASE = process.env.FLEET_API_URL ?? 'http://127.0.0.1:7171'
const TOKEN = process.env.FLEET_API_TOKEN ?? ''

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(data)}`)
  return data
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

const [cmd, ...args] = process.argv.slice(2)

try {
  switch (cmd) {
    case 'add': {
      const [title] = args
      const repo = flag(args, 'repo')
      const goal = flag(args, 'goal')
      if (!title || !repo || !goal) throw new Error('usage: fleet add "<title>" --repo <path|url> --goal "<goal>" [--node <node>] [--skill-hints "<hints>"]')
      const s = await call('POST', '/api/subjects', {
        title,
        repo,
        goal,
        node: flag(args, 'node'),
        skill_hints: flag(args, 'skill-hints'),
      })
      console.log(`${s.id}  ${s.status}  ${s.title}`)
      break
    }
    case 'subjects': {
      for (const s of await call('GET', '/api/subjects')) console.log(`${s.id}  ${s.status.padEnd(17)}  ${s.title}`)
      break
    }
    case 'show': {
      const d = await call('GET', `/api/subjects/${args[0]}`)
      console.log(JSON.stringify(d, null, 2))
      break
    }
    case 'decisions': {
      for (const d of await call('GET', `/api/decisions?status=${flag(args, 'status') ?? 'pending'}`)) {
        console.log(`${d.id}  [${d.type}]  ${d.question}`)
      }
      break
    }
    case 'approve':
    case 'deny': {
      if (!args[0]) throw new Error(`usage: fleet ${cmd} <decision-id> [--note "<note>"]`)
      const d = await call('POST', `/api/decisions/${args[0]}/${cmd === 'approve' ? 'approve' : 'deny'}`, {
        note: flag(args, 'note'),
      })
      console.log(`${d.id}  ${d.status}`)
      break
    }
    default:
      console.log('usage: fleet <add|subjects|show|decisions|approve|deny>')
      process.exitCode = cmd ? 1 : 0
  }
} catch (err) {
  console.error(String(err instanceof Error ? err.message : err))
  process.exitCode = 1
}
