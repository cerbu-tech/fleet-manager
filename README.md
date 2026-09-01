# fleet-manager

Autonomous manager for coding agents. It runs **subjects** (units of work) through
headless [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions in tmux,
keeps all state in SQLite, and escalates every irreversible decision to a human —
entirely on existing subscriptions (Claude / ChatGPT OAuth), no pay-per-token API keys.

**Status: early (M0).** One subject at a time, closely supervised: every action the
brain proposes requires explicit approval. Autonomy with a declarative policy engine,
a Codex driver, proactive proposals and a mobile bridge come in later milestones.

## How it works

- **Brain** — one Claude Agent SDK session per subject decides *what* to do next
  (`spawn_worker`, `report_event`, `request_decision`). It never executes anything
  itself: requests become pending decisions.
- **Scheduler** — deterministic loop that owns the limits (active subjects, stall
  detection) and executes approved decisions.
- **Driver** — runs workers as `claude -p --session-id <uuid> --output-format stream-json`
  inside tmux, one git worktree per session; follow-ups resume the same session.
- **API + dashboard** — HTTP API (static bearer token, explicit bind address) with a
  read-only dashboard (SSE) and a thin `fleet` CLI on top of it.

## Requirements

- Linux host for the manager daemon (systemd user unit provided; other OSes are
  documented targets only). macOS works fine for development.
- Node.js >= 24, tmux, git
- Claude Code CLI, logged in (`claude auth status` is checked at boot)

## Quick start

```bash
./deploy/install.sh          # checks prerequisites, builds, installs the systemd user unit
cp config.example.yaml config.yaml
export FLEET_API_TOKEN=$(openssl rand -hex 24)
npm start                    # or: systemctl --user start fleet-managerd
```

Create a subject and approve its steps:

```bash
fleet add "Add a trivial endpoint" --repo /path/to/repo --goal "Add GET /ping returning pong"
fleet decisions              # pending decisions
fleet approve <decision-id>
```

Dashboard: `http://<api.host>:<api.port>/` (read-only; paste the token once).

## Security model (v1)

Workers run on trusted nodes with the credentials already present there. Real
containment is **mechanical** — branch protection, deploy keys, push/PR allowlists
(see `docs/threat-model.md`) — not tool restrictions inside the agent. The API binds
only to the address you configure; keep it on loopback or a private (VPN/overlay)
interface.
