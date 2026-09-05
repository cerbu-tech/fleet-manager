# fleet-manager

Autonomous manager for coding agents. It runs **subjects** (units of work) through
headless [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions in tmux,
keeps all state in SQLite, and escalates every irreversible decision to a human —
entirely on existing subscriptions (Claude / ChatGPT OAuth), no pay-per-token API keys.

**Status: M1 (gated autonomy).** A declarative policy auto-approves routine actions —
worker spawns within budget, artifact publishes to allowlisted repos — and escalates
everything else (closure, clarifications, protected branches, anything new) to a
human. Proactive proposals and a mobile bridge come in later milestones.

## How it works

- **Brain** — one Claude Agent SDK session per subject decides *what* to do next
  (`spawn_worker`, `publish_artifact`, `report_event`, `request_decision`). It never
  executes anything itself: every request becomes a decision row.
- **Policy** — declarative rules from `config.yaml` (daily session/token budget,
  protected branches, per-subject repo allowlist). Allowed requests are auto-approved
  at the next scheduler tick — through the same path a human approval takes — and
  recorded with `resolved_by = 'policy'`; the rest stay pending for a human.
- **Scheduler** — deterministic loop that owns the limits (active subjects, stall
  detection, publish queue) and executes approved decisions.
- **Drivers** — `claude-code` runs workers as `claude -p --session-id <uuid>
  --output-format stream-json`, `codex` runs `codex exec --json`; both inside tmux,
  one git worktree per session; follow-ups resume the same agent session.
- **Artifacts** — `publish_artifact` pushes a file from the worker's worktree as a
  new branch on the configured hub and opens a PR (retried automatically while the
  destination is offline). **Subject closure in M1** = artifact PR open + the
  `close_subject` decision approved in the dashboard; correlating with the actual
  merge comes with the GitHub connector (M2).
- **API + dashboard** — HTTP API (static bearer token, explicit bind address); the
  dashboard shows subjects + live timeline (SSE) and lets you approve/deny pending
  decisions; a thin `fleet` CLI sits on the same API.

## Requirements

- Linux host for the manager daemon (systemd user unit provided; other OSes are
  documented targets only). macOS works fine for development.
- Node.js >= 24, tmux, git, gitleaks
- Claude Code CLI, logged in (`claude auth status` is checked at boot)
- Optional: Codex CLI (`codex`) for the codex driver; `gh` for opening artifact PRs
  on GitHub hubs

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

Dashboard: `http://<api.host>:<api.port>/` — paste the token once; create subjects,
follow the timeline, approve/deny escalations. Works on a phone over your VPN/overlay.

## Deploy (Linux, always-on host)

`deploy/install.sh` installs a **systemd user unit**. What it assumes, and why:

- Node >= 24 and the agent CLIs must be on the `PATH` of the user running
  `install.sh` — that PATH is captured into the unit, so a Node installed in your
  home directory (a tarball under `~/node`, nvm, fnm) works without root.
- The unit reads `~/.config/fleet-manager/env` (`FLEET_API_TOKEN`, generated on first
  install; add `FLEET_CONFIG=/path/to/config.yaml` there to keep the real config in a
  private repo outside the checkout).
- Run `loginctl enable-linger $USER` once so the service survives logout.
- Bind `api.host` to your VPN/overlay address (e.g. a Tailscale IP), never `0.0.0.0`.
- **Agent auth on the daemon host: use a long-lived token, not the interactive
  login.** Interactive `claude auth login` credentials are refreshed with rotation —
  the same account logged in on your laptop invalidates the daemon host's refresh
  token at the first refresh (observed: credentials wiped at the brain's first turn).
  Run `claude setup-token` once and put `CLAUDE_CODE_OAUTH_TOKEN=…` in the env file.
  Workers run in a dedicated tmux server (`tmux -L fleet`) started by the daemon, so
  they inherit that environment.

```bash
./deploy/install.sh
echo "FLEET_CONFIG=$HOME/my-config/config.yaml" >> ~/.config/fleet-manager/env
echo "CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token)" >> ~/.config/fleet-manager/env   # interactive once
loginctl enable-linger "$USER"
systemctl --user enable --now fleet-managerd
journalctl --user -u fleet-managerd -f
```

## Security model (v1)

Workers run on trusted nodes with the credentials already present there. Real
containment is **mechanical** — branch protection, deploy keys, push/PR allowlists
(see `docs/threat-model.md`) — not tool restrictions inside the agent. Protect `main`
on every repo the manager touches with **"require a pull request"** (a bare
protection rule does not stop direct pushes — the exact `gh api` call is in the
threat model). The API binds only to the address you configure; keep it on loopback
or a private (VPN/overlay) interface.
