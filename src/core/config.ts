import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

export interface Config {
  db: string
  workdir: string
  api: { host: string; port: number; token: string }
  scheduler: { max_active_subjects: number; tick_seconds: number; stall_minutes: number }
  policy: { budget: { sessions_per_day: number; tokens_per_day: number }; protected_branches: string[] }
  artifacts: { hub: string }
}

// FLEET_CONFIG > explicit path > ./config.yaml. The API token comes from
// FLEET_API_TOKEN or api.token — secrets are expected in the environment.
export function loadConfig(path?: string): Config {
  const file = path ?? process.env.FLEET_CONFIG ?? 'config.yaml'
  const raw = parse(readFileSync(file, 'utf8')) as Record<string, any>
  for (const key of ['db', 'workdir', 'api']) {
    if (!raw?.[key]) throw new Error(`config: missing "${key}" in ${file}`)
  }
  const token = process.env.FLEET_API_TOKEN || raw.api.token || ''
  if (!token) throw new Error('config: no API token (set FLEET_API_TOKEN or api.token)')
  if (!raw.api.host || !raw.api.port) throw new Error('config: api.host and api.port are required')
  return {
    db: raw.db,
    workdir: raw.workdir,
    api: { host: raw.api.host, port: raw.api.port, token },
    scheduler: {
      max_active_subjects: raw.scheduler?.max_active_subjects ?? 1,
      tick_seconds: raw.scheduler?.tick_seconds ?? 5,
      stall_minutes: raw.scheduler?.stall_minutes ?? 15,
    },
    policy: {
      budget: {
        sessions_per_day: raw.policy?.budget?.sessions_per_day ?? 50,
        tokens_per_day: raw.policy?.budget?.tokens_per_day ?? 2_000_000,
      },
      protected_branches: raw.policy?.protected_branches ?? ['main', 'master'],
    },
    artifacts: { hub: raw.artifacts?.hub ?? '' },
  }
}
